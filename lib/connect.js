// lib/connect.js — ClawCove gateway client
//
// Protocol (verified against live gateway error messages):
//
//  HANDSHAKE FLOW:
//  1. Open WS — send nothing
//  2. Gateway pushes: { type:"event", event:"connect.challenge", payload:{nonce,ts} }
//  3. Client sends connect frame with signed device identity
//  4. Gateway responds: { type:"res", id:"1", ok:true, payload:{type:"hello-ok",...} }
//
//  REQUIRED CONSTANTS (validated by gateway AJV schema):
//    client.id   = "gateway-client"   (one of an enum)
//    client.mode = "backend"          (one of an enum)
//
//  SIGNATURE (v2 pipe-delimited, HMAC-SHA256, key = token):
//    v2|deviceId|clientId|clientMode|role|scopesCsv|signedAtMs|tokenOrEmpty|nonce
//
//  DEVICE (required fields):
//    id, publicKey (base64 Ed25519), signature (hex), signedAt (ms), nonce

import { WebSocket }                                    from 'ws';
import { createHmac, generateKeyPairSync, randomUUID }  from 'crypto';
import { readFileSync, existsSync,
         writeFileSync, mkdirSync }                     from 'fs';
import { join }                                         from 'path';
import { homedir }                                      from 'os';

// ── Constants validated by gateway schema ─────────────────────────────────────
const CLIENT_ID   = 'gateway-client';
const CLIENT_MODE = 'backend';
const CLIENT_VER  = '0.2.0';
const ROLE        = 'operator';
const SCOPES      = ['operator.read', 'operator.write'];

// ── Device identity (persisted so gateway recognises us across restarts) ───────
function loadOrCreateDevice(stateDir) {
  const p = join(stateDir, 'clawcove-device.json');
  try {
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      if (d.deviceId && d.publicKeyBase64) return d;
    }
  } catch {}

  // Generate Ed25519 keypair — gateway requires a real publicKey field
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' })
                           .toString('base64');
  const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' })
                             .toString('base64');
  const d = {
    deviceId:       `clawcove-${randomUUID().slice(0, 8)}`,
    publicKeyBase64: pubB64,
    privateKeyBase64: privB64,
    createdAt:      new Date().toISOString(),
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(p, JSON.stringify(d, null, 2));
  } catch {}
  return d;
}

// ── v2 signature ──────────────────────────────────────────────────────────────
// Pipe-delimited: v2|deviceId|clientId|clientMode|role|scopesCsv|signedAtMs|token|nonce
// HMAC-SHA256 key = token (or empty string if no token)
function signV2(deviceId, token, nonce, signedAt) {
  const scopesCsv = SCOPES.join(',');
  const payload   = [
    'v2', deviceId, CLIENT_ID, CLIENT_MODE, ROLE,
    scopesCsv, String(signedAt), token ?? '', nonce,
  ].join('|');
  return createHmac('sha256', token ?? '')
           .update(payload)
           .digest('hex');
}

// ── Build connect frame ───────────────────────────────────────────────────────
function buildConnectFrame(id, nonce, ts, device, token) {
  const signedAt  = ts ?? Date.now();
  const signature = signV2(device.deviceId, token, nonce, signedAt);
  return {
    type:   'req',
    id,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id:         CLIENT_ID,
        version:    CLIENT_VER,
        platform:   'node',
        mode:       CLIENT_MODE,
        instanceId: randomUUID(),
      },
      role:        ROLE,
      scopes:      SCOPES,
      caps:        [],
      commands:    [],
      permissions: {},
      auth:        token ? { token } : {},
      locale:      'en-US',
      userAgent:   `clawcove/${CLIENT_VER}`,
      device: {
        id:         device.deviceId,
        publicKey:  device.publicKeyBase64,
        signature,
        signedAt,
        nonce,
      },
    },
  };
}

// ── Post-connect discovery ────────────────────────────────────────────────────
async function discover(req) {
  const methods = [
    'sessions.list', 'cron.list',    'channels.status', 'skills.list',
    'node.list',     'config.get',   'health',           'system-presence',
    'models.list',
  ];
  const keys = ['sessions','cron','channels','skills','nodes','config','health','presence','models'];
  const results = await Promise.allSettled(methods.map(m => req(m, {})));
  const out = {};
  results.forEach((r, i) => {
    out[keys[i]] = r.status === 'fulfilled' ? (r.value?.payload ?? null) : null;
  });
  out.errors = results
    .map((r, i) => r.status === 'rejected' ? [methods[i], r.reason?.message] : null)
    .filter(Boolean);
  return out;
}

// ── Main export ───────────────────────────────────────────────────────────────
export function createGatewayClient(gatewayUrl, token, onState, onEvent, onError, opts = {}) {
  const stateDir = opts.stateDir ?? join(homedir(), '.openclaw');
  const device   = loadOrCreateDevice(stateDir);

  let ws             = null;
  let connected      = false;
  let reqId          = 10;
  const pending      = new Map();
  let reconnectTimer = null;
  let dead           = false;

  // ── RPC helper ──────────────────────────────────────────────────────────────
  function req(method, params = {}, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN)
        return reject(new Error('not connected'));
      const id = String(reqId++);
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, timeoutMs);
    });
  }

  // ── Connect ──────────────────────────────────────────────────────────────────
  function connect() {
    if (dead) return;
    console.log(`[clawcove] connecting to ${gatewayUrl}…`);
    ws = new WebSocket(gatewayUrl);

    let connectSent = false;

    // Gateway ALWAYS sends connect.challenge first — never send before it.
    // 4s safety timeout in case challenge is disabled on the gateway.
    const challengeTimeout = setTimeout(() => {
      if (!connectSent) {
        console.warn('[clawcove] no challenge in 4s — sending without nonce');
        doSendConnect('no-challenge', Date.now());
      }
    }, 4000);

    function doSendConnect(nonce, ts) {
      if (connectSent) return;
      connectSent = true;
      clearTimeout(challengeTimeout);
      const frame = buildConnectFrame('1', nonce, ts, device, token);
      console.log(`[clawcove] → connect (device: ${device.deviceId})`);
      ws.send(JSON.stringify(frame));
    }

    ws.on('open', () => {
      console.log('[clawcove] WS open — awaiting challenge…');
      // Intentionally silent. Gateway speaks first.
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // ── challenge ──────────────────────────────────────────────────────────
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const nonce = msg.payload?.nonce ?? randomUUID();
        const ts    = msg.payload?.ts    ?? Date.now();
        console.log(`[clawcove] ← challenge received`);
        doSendConnect(nonce, ts);
        return;
      }

      // ── connect response ───────────────────────────────────────────────────
      if (!connected && msg.type === 'res' && msg.id === '1') {
        if (msg.ok) {
          connected = true;
          console.log(`[clawcove] ✓ connected (protocol v${msg.payload?.protocol ?? 3})`);
          discover(req)
            .then(d  => onState({ helloOk: msg.payload, discovered: d }, req))
            .catch(e => onState({ helloOk: msg.payload, discovered: {} }, req));
        } else {
          const code = msg.error?.code    ?? '';
          const text = msg.error?.message ?? msg.payload?.message ?? 'connect rejected';
          console.error(`[clawcove] ✗ ${code} ${text}`);

          if (code === 'PAIRING_REQUIRED' || text.toLowerCase().includes('pairing')) {
            const pairId = msg.error?.details?.requestId ?? msg.payload?.requestId;
            const hint   = pairId
              ? `Run:  openclaw devices approve ${pairId}`
              : 'Run:  openclaw devices list  →  openclaw devices approve <id>';
            console.error(`[clawcove] Pairing needed — ${hint}`);
            onError({ type: 'pairing', message: `Pairing required. ${hint}`, retryable: false });
          } else {
            onError({ type: 'auth', message: text, retryable: false });
          }
          ws.close();
        }
        return;
      }

      // ── RPC responses ──────────────────────────────────────────────────────
      if (msg.type === 'res' && msg.id) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg); }
        return;
      }

      // ── Events ─────────────────────────────────────────────────────────────
      if (msg.type === 'event' || msg.event) onEvent(msg);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(challengeTimeout);
      connected = false;
      pending.forEach(p => p.reject(new Error('connection closed')));
      pending.clear();
      if (!dead) {
        const r = reason.toString();
        console.log(`[clawcove] disconnected (${code}${r ? ': ' + r : ''})`);
        onEvent({ type: 'event', event: 'clawcove.disconnected', payload: { code, reason: r } });
        reconnectTimer = setTimeout(connect, code === 1008 ? 20000 : 5000);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(challengeTimeout);
      if (!dead) {
        onError({
          type:      'connection',
          message:   err.code === 'ECONNREFUSED'
            ? `Gateway not reachable at ${gatewayUrl} — is OpenClaw running?  →  openclaw gateway`
            : err.message,
          retryable: true,
        });
      }
    });
  }

  connect();

  return {
    isConnected: () => connected,
    deviceId:    () => device.deviceId,
    destroy: () => {
      dead = true;
      clearTimeout(reconnectTimer);
      pending.forEach(p => p.reject(new Error('destroyed')));
      pending.clear();
      ws?.close();
    },
  };
}
