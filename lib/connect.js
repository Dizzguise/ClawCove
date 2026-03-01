// lib/connect.js
// OpenClaw gateway WebSocket client.
// Supports protocol v3 (role/scopes/device) with automatic fallback to v1.
// The error from the gateway was:
//   "invalid connect params ... /client/id ... /client/mode"
// v3 expects a `device` object with `deviceId` + `deviceSecret`, a `role`,
// and a `scopes` array rather than the old `client.mode` field.

import { WebSocket } from 'ws';
import { randomUUID, createHmac } from 'crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DISPLAY_NAME  = 'ClawCove Visualizer';
const CLIENT_ID     = 'clawcove';
const CLIENT_VER    = '0.2.0';

// ── Device credential helpers ─────────────────────────────────────────────────
// v3 auth uses a persistent device identity so the gateway can recognise us
// across restarts without re-prompting for a token each time.

function loadOrCreateDevice(stateDir) {
  const credPath = join(stateDir ?? join(homedir(), '.openclaw'), 'clawcove-device.json');
  try {
    if (existsSync(credPath)) {
      const d = JSON.parse(readFileSync(credPath, 'utf8'));
      if (d.deviceId && d.deviceSecret) return d;
    }
  } catch { /* fall through */ }

  // Generate a fresh device identity
  const device = {
    deviceId:     `clawcove-${randomUUID().slice(0, 8)}`,
    deviceSecret: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    createdAt:    new Date().toISOString(),
  };
  try {
    mkdirSync(join(stateDir ?? join(homedir(), '.openclaw')), { recursive: true });
    writeFileSync(credPath, JSON.stringify(device, null, 2));
  } catch { /* ignore if read-only */ }
  return device;
}

// HMAC-SHA256 challenge response (used by v3 device auth flow)
function signChallenge(challenge, deviceSecret) {
  return createHmac('sha256', deviceSecret).update(challenge).digest('hex');
}

// ── Main export ───────────────────────────────────────────────────────────────
export function createGatewayClient(gatewayUrl, token, onState, onEvent, onError, opts = {}) {
  const stateDir = opts.stateDir ?? join(homedir(), '.openclaw');
  const device   = loadOrCreateDevice(stateDir);

  let ws            = null;
  let connected     = false;
  let protocolVer   = null;   // negotiated after connect
  let reqId         = 1;
  const pending     = new Map();
  let reconnectTimer = null;
  let dead          = false;

  // ── RPC helper ──────────────────────────────────────────────────────────────
  function req(method, params = {}, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const id = String(reqId++);
      pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      } catch (e) {
        pending.delete(id);
        return reject(e);
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  // ── Discovery ───────────────────────────────────────────────────────────────
  async function discover() {
    const methods = [
      'sessions.list', 'cron.list', 'channels.status', 'skills.list',
      'node.list',     'config.get', 'health',          'system-presence',
      'models.list',
    ];
    const results = await Promise.allSettled(methods.map(m => req(m, {})));
    const keys    = ['sessions','cron','channels','skills','nodes','config','health','presence','models'];
    const out     = {};
    results.forEach((r, i) => {
      out[keys[i]] = r.status === 'fulfilled' ? (r.value?.payload ?? null) : null;
    });
    out.errors = results
      .map((r, i) => r.status === 'rejected' ? [methods[i], r.reason?.message] : null)
      .filter(Boolean);
    return out;
  }

  // ── Connect handshake ────────────────────────────────────────────────────────
  // Tries v3 first (role/scopes/device), falls back to v1 on rejection.
  async function doHandshake() {
    // ── v3 shape ──
    const v3frame = {
      type:   'req',
      id:     String(reqId++),
      method: 'connect',
      params: {
        protocol: { min: 3, max: 10 },
        device: {
          deviceId:    device.deviceId,
          displayName: DISPLAY_NAME,
          clientId:    CLIENT_ID,
          version:     CLIENT_VER,
          platform:    'node',
        },
        role:   'observer',
        scopes: ['read:sessions', 'read:cron', 'read:channels',
                 'read:skills',   'read:nodes', 'read:config',
                 'read:health',   'read:presence', 'subscribe:events'],
        ...(token ? { auth: { token } } : {}),
      },
    };

    return new Promise((resolve, reject) => {
      // We may get a challenge back before the final ok/err
      const id = v3frame.id;
      pending.set(id, {
        resolve: async (res) => {
          if (res.ok) {
            protocolVer = res.payload?.protocol ?? 3;
            resolve({ ok: true, payload: res.payload, version: 3 });
            return;
          }

          // v3 rejected → check if it's a challenge
          if (res.payload?.type === 'challenge' && res.payload?.challenge) {
            const sig = signChallenge(res.payload.challenge, device.deviceSecret);
            try {
              const r2 = await req('connect.auth', {
                deviceId:  device.deviceId,
                challenge: res.payload.challenge,
                signature: sig,
                ...(token ? { token } : {}),
              });
              if (r2.ok) { protocolVer = r2.payload?.protocol ?? 3; resolve({ ok: true, payload: r2.payload, version: 3 }); }
              else reject(new Error(r2.error?.message ?? 'challenge auth failed'));
            } catch (e) { reject(e); }
            return;
          }

          // v3 hard-rejected → try v1 fallback
          const errMsg = res.error?.message ?? '';
          const isV3Incompatible = errMsg.includes('/client/') || errMsg.includes('mode') || errMsg.includes('protocol');
          if (isV3Incompatible) {
            console.warn('[clawcove] v3 rejected, trying v1 fallback…');
            resolve({ ok: false, fallback: true, message: errMsg });
          } else {
            reject(new Error(errMsg || 'connect rejected'));
          }
        },
        reject,
      });
      ws.send(JSON.stringify(v3frame));
    });
  }

  async function doHandshakeV1() {
    const v1frame = {
      type:   'req',
      id:     String(reqId++),
      method: 'connect',
      params: {
        minProtocol: 1,
        maxProtocol: 10,
        client: {
          id:          device.deviceId,
          displayName: DISPLAY_NAME,
          version:     CLIENT_VER,
          platform:    'node',
        },
        ...(token ? { auth: { token } } : {}),
      },
    };

    return new Promise((resolve, reject) => {
      pending.set(v1frame.id, {
        resolve: (res) => {
          if (res.ok) { protocolVer = 1; resolve({ ok: true, payload: res.payload, version: 1 }); }
          else reject(new Error(res.error?.message ?? 'v1 connect rejected'));
        },
        reject,
      });
      ws.send(JSON.stringify(v1frame));
    });
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────
  function connect() {
    if (dead) return;
    console.log(`[clawcove] connecting to ${gatewayUrl}…`);

    ws = new WebSocket(gatewayUrl);

    ws.on('open', async () => {
      try {
        // Try v3 first
        let handshake = await doHandshake();

        // Fallback to v1 if needed
        if (!handshake.ok && handshake.fallback) {
          handshake = await doHandshakeV1();
        }

        connected = true;
        console.log(`[clawcove] connected ✓ (protocol v${handshake.version})`);

        const discovered = await discover();
        onState({ helloOk: handshake.payload, discovered }, req);

      } catch (e) {
        console.error('[clawcove] handshake failed:', e.message);
        onError({ type: 'auth', message: e.message, retryable: false });
        ws.close();
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'res') {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg); }
      } else if (msg.type === 'event') {
        onEvent(msg);
      }
    });

    ws.on('close', (code, reason) => {
      connected = false;
      pending.forEach(p => p.reject(new Error('connection closed')));
      pending.clear();
      if (!dead) {
        const delay = code === 1008 ? 15000 : 5000; // back off on policy violation
        console.log(`[clawcove] disconnected (${code}), reconnecting in ${delay/1000}s…`);
        onEvent({ type: 'event', event: 'clawcove.disconnected', payload: { code, reason: reason.toString() } });
        reconnectTimer = setTimeout(connect, delay);
      }
    });

    ws.on('error', (err) => {
      if (!dead) {
        const msg = err.code === 'ECONNREFUSED'
          ? `Gateway not reachable at ${gatewayUrl}. Is OpenClaw running?`
          : err.message;
        onError({ type: 'connection', message: msg, retryable: true });
      }
    });
  }

  connect();

  return {
    isConnected:   () => connected,
    protocolVer:   () => protocolVer,
    deviceId:      () => device.deviceId,
    destroy: () => {
      dead = true;
      clearTimeout(reconnectTimer);
      pending.forEach(p => p.reject(new Error('destroyed')));
      pending.clear();
      ws?.close();
    },
  };
}
