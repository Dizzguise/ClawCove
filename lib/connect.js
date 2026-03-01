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
//  Device auth format (matches OpenClaw infra/device-identity.ts + gateway/device-auth.ts):
//    deviceId   = SHA256(raw 32-byte Ed25519 public key).digest('hex') — full 64 chars
//    publicKey  = base64url(raw 32-byte key) — NOT SPKI/DER
//    signature  = base64url(Ed25519 signature)
//    Payload v3 = v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily

import { WebSocket }                                    from 'ws';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'crypto';
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

// ── OpenClaw device format (device-identity.ts) ────────────────────────────────
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function derivePublicKeyRaw(spkiBuffer) {
  if (spkiBuffer.length >= ED25519_SPKI_PREFIX.length + 32 &&
      spkiBuffer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spkiBuffer.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spkiBuffer.subarray(-32);  // fallback: last 32 bytes
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fingerprintFromSpki(spkiBuffer) {
  const raw = derivePublicKeyRaw(spkiBuffer);
  return createHash('sha256').update(raw).digest('hex');
}

function publicKeyRawBase64UrlFromSpki(spkiBuffer) {
  return base64UrlEncode(derivePublicKeyRaw(spkiBuffer));
}

// ── Device identity (persisted so gateway recognises us across restarts) ───────
function loadOrCreateDevice(stateDir) {
  const p = join(stateDir, 'clawcove-device.json');
  try {
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      if (d.publicKeyBase64 && d.privateKeyBase64) {
        const spki = Buffer.from(d.publicKeyBase64, 'base64');
        const deviceId = fingerprintFromSpki(spki);
        const publicKeyRawB64Url = publicKeyRawBase64UrlFromSpki(spki);
        if (d.deviceId !== deviceId) {
          d.deviceId = deviceId;
          try { writeFileSync(p, JSON.stringify(d, null, 2)); } catch {}
        }
        return {
          deviceId,
          publicKeyRawBase64Url: publicKeyRawB64Url,
          publicKeyBase64: d.publicKeyBase64,
          privateKeyBase64: d.privateKeyBase64,
        };
      }
    }
  } catch {}

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pubB64 = spki.toString('base64');
  const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const deviceId = fingerprintFromSpki(spki);
  const publicKeyRawB64Url = publicKeyRawBase64UrlFromSpki(spki);
  const d = {
    deviceId,
    publicKeyBase64: pubB64,
    privateKeyBase64: privB64,
    createdAt: new Date().toISOString(),
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(p, JSON.stringify(d, null, 2));
  } catch {}
  return {
    ...d,
    publicKeyRawBase64Url,
  };
}

// ── v3 device auth payload (matches gateway/device-auth.ts buildDeviceAuthPayloadV3) ─

// Payload must exactly match what gateway reconstructs from connect params.
// Gateway uses params.client.platform, params.client.deviceFamily (undefined → "").
function buildDeviceAuthPayloadV3(device, token, nonce, signedAt, platform, deviceFamily) {
  const scopes = SCOPES.join(',');
  const plat = normalizeDeviceMetadataForAuth(platform);
  const fam  = normalizeDeviceMetadataForAuth(deviceFamily);
  return [
    'v3', device.deviceId, CLIENT_ID, CLIENT_MODE, ROLE,
    scopes, String(signedAt), token ?? '', nonce,
    plat, fam,
  ].join('|');
}

function normalizeDeviceMetadataForAuth(value) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  if (!t) return '';
  return t.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function signDevicePayload(device, token, nonce, signedAt, platform, deviceFamily) {
  const payload = buildDeviceAuthPayloadV3(device, token, nonce, signedAt, platform, deviceFamily);
  const key = createPrivateKey({
    key: Buffer.from(device.privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(sig);
}

// ── Build connect frame ───────────────────────────────────────────────────────
// Reason: Use client Date.now() for signedAt; server challenge ts can cause
// validation drift if gateway expects client-time freshness semantics.
function buildConnectFrame(id, nonce, signedAt, device, token, platform, deviceFamily) {
  const plat  = platform ?? 'node';
  const fam   = deviceFamily ?? null;  // Omit from client = gateway uses ""
  const signature = signDevicePayload(device, token, nonce, signedAt, plat, fam);
  const client = {
    id:         CLIENT_ID,
    version:    CLIENT_VER,
    platform:   plat,
    mode:       CLIENT_MODE,
    instanceId: randomUUID(),
  };
  if (fam != null && fam !== '') client.deviceFamily = fam;
  return {
    type:   'req',
    id,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client,
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
        publicKey:  device.publicKeyRawBase64Url,
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

// ── Device token: hello-ok can return auth.deviceToken; persist for future connects ─
const DEVICE_TOKEN_FILE = 'clawcove-device-token.json';

function loadDeviceToken(stateDir) {
  try {
    const p = join(stateDir, DEVICE_TOKEN_FILE);
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j?.token) return j.token;
    }
  } catch {}
  return null;
}

function saveDeviceToken(stateDir, deviceToken) {
  try {
    mkdirSync(stateDir, { recursive: true });
    const p = join(stateDir, DEVICE_TOKEN_FILE);
    writeFileSync(p, JSON.stringify({ token: deviceToken, updatedAt: new Date().toISOString() }, null, 2));
  } catch {}
}

// ── Main export ───────────────────────────────────────────────────────────────
export function createGatewayClient(gatewayUrl, token, onState, onEvent, onError, opts = {}) {
  const stateDir = opts.stateDir ?? join(homedir(), '.openclaw');
  const device   = loadOrCreateDevice(stateDir);
  // Prefer persisted device token; gateway issues it after pairing and it takes priority.
  let effectiveToken = loadDeviceToken(stateDir) ?? token;

  let ws                 = null;
  let connected          = false;
  let reqId              = 10;
  const pending          = new Map();
  let reconnectTimer     = null;
  let dead               = false;
  let lastCloseWasAuth   = false;
  let consecutive1008    = 0;

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

    // Gateway ALWAYS sends connect.challenge first — connections are challenge-based.
    // No fallback: sending connect without valid nonce causes invalid signature / auth failures.
    const challengeTimeout = setTimeout(() => {
      if (!connectSent) {
        console.error('[clawcove] no challenge in 8s — gateway may not support challenge flow');
        onError({ type: 'auth', message: 'No connect.challenge received. Is the gateway reachable?', retryable: true });
        ws?.close();
      }
    }, 8000);

    function doSendConnect(nonce) {
      if (connectSent) return;
      connectSent = true;
      clearTimeout(challengeTimeout);
      const platform = typeof process !== 'undefined' ? process.platform : 'node';
      const frame = buildConnectFrame('1', nonce, Date.now(), device, effectiveToken, platform, null);
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
        console.log(`[clawcove] ← challenge received`);
        doSendConnect(nonce);
        return;
      }

      // ── connect response ───────────────────────────────────────────────────
      if (!connected && msg.type === 'res' && msg.id === '1') {
        if (msg.ok) {
          connected = true;
          consecutive1008 = 0;
          const dt = msg.payload?.auth?.deviceToken;
          if (dt) {
            effectiveToken = dt;
            saveDeviceToken(stateDir, dt);
          }
          console.log(`[clawcove] ✓ connected (protocol v${msg.payload?.protocol ?? 3})`);
          discover(req)
            .then(d  => onState({ helloOk: msg.payload, discovered: d }, req))
            .catch(e => onState({ helloOk: msg.payload, discovered: {} }, req));
        } else {
          const code = msg.error?.code    ?? '';
          const text = msg.error?.message ?? msg.payload?.message ?? 'connect rejected';
          console.error(`[clawcove] ✗ ${code} ${text}`);

          lastCloseWasAuth = true;
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
        // Reason: avoid churn on auth failures — backoff for 1008 and auth rejects
        if (lastCloseWasAuth) {
          lastCloseWasAuth = false;
          reconnectTimer = setTimeout(connect, 60000);  // 1 min for auth failure
        } else if (code === 1008) {
          consecutive1008++;
          const delay = Math.min(20000 * Math.pow(2, consecutive1008 - 1), 120000);
          reconnectTimer = setTimeout(connect, delay);
        } else {
          consecutive1008 = 0;
          reconnectTimer = setTimeout(connect, 5000);
        }
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
