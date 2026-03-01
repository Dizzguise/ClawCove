// lib/connect.js — ClawCove gateway client
//
// PROTOCOL (from docs.openclaw.ai/gateway/protocol):
//
//  1. Client opens WS to ws://127.0.0.1:18789
//  2. Gateway immediately pushes a challenge event (before any client frame):
//       { type:"event", event:"connect.challenge", payload:{ nonce:"…", ts:1234 } }
//  3. Client signs the challenge nonce and sends connect frame:
//       { type:"req", id:"1", method:"connect", params:{
//           minProtocol:3, maxProtocol:3,
//           client:{ id:"clawcove", version:"0.2.0", platform:"node", mode:"operator" },
//           role:"operator",
//           scopes:["operator.read","operator.write"],
//           caps:[], commands:[], permissions:{},
//           auth:{ token:"<raw token>" },
//           userAgent:"clawcove/0.2.0",
//           device:{ id:"<stable id>", nonce:"<same nonce>",
//                    signature:"<hmac-sha256 hex>", signedAt:<ts> }
//       }}
//  4. Gateway responds:
//       { type:"res", id:"1", ok:true,
//         payload:{ type:"hello-ok", protocol:3, policy:{…}, snapshot:{…} } }
//
// Signature v3 payload: deviceId:clientId:role:scopes(csv):token:nonce
// Loopback connects are auto-approved for new device IDs by default.
// If pairing is required: openclaw devices approve <requestId>

import { WebSocket }                         from 'ws';
import { randomUUID, createHmac }            from 'crypto';
import { readFileSync, existsSync,
         writeFileSync, mkdirSync }          from 'fs';
import { join }                              from 'path';
import { homedir }                           from 'os';

const CLIENT_VER   = '0.2.0';
const CLIENT_ID    = 'clawcove';
const PLATFORM     = 'node';

function loadOrCreateDevice(stateDir) {
  const p = join(stateDir, 'clawcove-device.json');
  try {
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf8'));
      if (d.deviceId) return d;
    }
  } catch {}
  const d = { deviceId: `clawcove-${randomUUID().slice(0,8)}`, createdAt: new Date().toISOString() };
  try { mkdirSync(stateDir, { recursive: true }); writeFileSync(p, JSON.stringify(d, null, 2)); } catch {}
  return d;
}

// v3 signature: deviceId:clientId:role:scopes(csv):token:nonce  HMAC-SHA256 keyed by token
function sign(deviceId, role, scopes, token, nonce) {
  const payload = [deviceId, CLIENT_ID, role, scopes.join(','), token ?? '', nonce].join(':');
  return createHmac('sha256', token ?? 'no-token').update(payload).digest('hex');
}

function buildConnectFrame(id, nonce, ts, deviceId, token, role, scopes) {
  return {
    type: 'req', id, method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: CLIENT_ID, version: CLIENT_VER, platform: PLATFORM,
                mode: role === 'operator' ? 'operator' : 'observer' },
      role, scopes,
      caps: [], commands: [], permissions: {},
      auth: token ? { token } : {},
      locale: 'en-US',
      userAgent: `${CLIENT_ID}/${CLIENT_VER}`,
      device: { id: deviceId, nonce, signature: sign(deviceId, role, scopes, token, nonce), signedAt: ts ?? Date.now() },
    },
  };
}

async function discover(req) {
  const methods = ['sessions.list','cron.list','channels.status','skills.list',
                   'node.list','config.get','health','system-presence','models.list'];
  const keys    = ['sessions','cron','channels','skills','nodes','config','health','presence','models'];
  const results = await Promise.allSettled(methods.map(m => req(m, {})));
  const out = {};
  results.forEach((r, i) => { out[keys[i]] = r.status === 'fulfilled' ? (r.value?.payload ?? null) : null; });
  out.errors = results.map((r,i) => r.status==='rejected' ? [methods[i], r.reason?.message] : null).filter(Boolean);
  return out;
}

export function createGatewayClient(gatewayUrl, token, onState, onEvent, onError, opts = {}) {
  const stateDir = opts.stateDir ?? join(homedir(), '.openclaw');
  const device   = loadOrCreateDevice(stateDir);

  // Try operator first (full read), fall back to observer if denied
  const ROLES = [
    { role: 'operator', scopes: ['operator.read', 'operator.write'] },
    { role: 'observer', scopes: ['operator.read'] },
  ];
  let roleIndex  = 0;
  let ws         = null;
  let connected  = false;
  let reqId      = 10;
  const pending  = new Map();
  let reconnectTimer = null;
  let dead       = false;

  function req(method, params = {}, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('not connected'));
      const id = String(reqId++);
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, timeoutMs);
    });
  }

  function connect() {
    if (dead) return;
    const { role, scopes } = ROLES[roleIndex % ROLES.length];
    console.log(`[clawcove] connecting to ${gatewayUrl} (role: ${role})…`);

    ws = new WebSocket(gatewayUrl);
    let connectSent = false;

    // Gateway MUST send connect.challenge first. We wait up to 3s; if none
    // arrives we send without signature (supports gateways with challenge disabled).
    const challengeTimeout = setTimeout(() => {
      if (!connectSent) {
        console.warn('[clawcove] no challenge in 3s — sending unsigned connect');
        sendConnect('no-challenge', Date.now());
      }
    }, 3000);

    function sendConnect(nonce, ts) {
      if (connectSent) return;
      connectSent = true;
      clearTimeout(challengeTimeout);
      ws.send(JSON.stringify(buildConnectFrame('1', nonce, ts, device.deviceId, token, role, scopes)));
    }

    ws.on('open', () => {
      console.log('[clawcove] WS open — awaiting challenge…');
      // Do NOT send anything. Gateway pushes challenge first.
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Challenge — sign and respond
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const nonce = msg.payload?.nonce ?? randomUUID();
        const ts    = msg.payload?.ts    ?? Date.now();
        console.log(`[clawcove] ← challenge, signing…`);
        sendConnect(nonce, ts);
        return;
      }

      // Connect response
      if (!connected && msg.type === 'res' && msg.id === '1') {
        if (msg.ok) {
          connected = true;
          console.log(`[clawcove] ✓ connected (protocol v${msg.payload?.protocol ?? 3}, role: ${role})`);
          discover(req)
            .then(discovered => onState({ helloOk: msg.payload, discovered }, req))
            .catch(e => { console.error('[clawcove] discovery:', e.message); onState({ helloOk: msg.payload, discovered: {} }, req); });
        } else {
          const errMsg  = msg.error?.message ?? msg.payload?.message ?? 'connect rejected';
          const errCode = msg.error?.code    ?? msg.payload?.code    ?? '';
          console.error(`[clawcove] ✗ connect rejected: ${errCode} ${errMsg}`);

          if (errCode === 'PAIRING_REQUIRED' || errMsg.toLowerCase().includes('pairing')) {
            const pairId = msg.error?.details?.requestId ?? msg.payload?.requestId;
            const hint   = pairId ? `Run: openclaw devices approve ${pairId}` : 'Run: openclaw devices list  →  openclaw devices approve <id>';
            console.error(`[clawcove] ${hint}`);
            onError({ type: 'pairing', message: `Pairing required. ${hint}`, retryable: false });
            ws.close(); return;
          }

          if (errCode === 'UNAUTHORIZED' || errCode === 'FORBIDDEN' || errMsg.includes('scope')) {
            roleIndex++;
            if (roleIndex < ROLES.length) {
              console.warn(`[clawcove] retrying as ${ROLES[roleIndex].role}`);
              ws.close(); return;
            }
          }

          onError({ type: 'auth', message: errMsg, retryable: false });
          ws.close();
        }
        return;
      }

      // RPC responses
      if (msg.type === 'res' && msg.id) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg); }
        return;
      }

      // Events
      if (msg.type === 'event' || msg.event) onEvent(msg);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(challengeTimeout);
      connected = false;
      pending.forEach(p => p.reject(new Error('connection closed')));
      pending.clear();
      if (!dead) {
        const reasonStr = reason.toString();
        console.log(`[clawcove] disconnected (${code}: ${reasonStr})`);
        onEvent({ type:'event', event:'clawcove.disconnected', payload:{ code, reason: reasonStr } });
        if (code !== 1008) roleIndex = 0; // reset role on non-auth disconnect
        reconnectTimer = setTimeout(connect, code === 1008 ? 20000 : 5000);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(challengeTimeout);
      if (!dead) {
        onError({
          type: 'connection',
          message: err.code === 'ECONNREFUSED'
            ? `Gateway not reachable at ${gatewayUrl}. Is OpenClaw running?  →  openclaw gateway`
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
