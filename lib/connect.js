// lib/connect.js
// Opens a WebSocket to the OpenClaw gateway, performs the connect handshake,
// then fires off all discovery queries in parallel.
// Returns a live connection that proxies events to browser clients.

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const DEVICE_ID = 'clawville-visualizer-v1';
const DISPLAY_NAME = 'Clawville Visualizer';

export function createGatewayClient(gatewayUrl, token, onState, onEvent, onError) {
  let ws = null;
  let connected = false;
  let reqId = 1;
  const pending = new Map(); // id -> {resolve, reject}
  let reconnectTimer = null;
  let dead = false;

  function req(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = String(reqId++);
      pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ type: 'req', id, method, params });
      ws.send(frame);
      // timeout after 10s
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 10000);
    });
  }

  async function discover() {
    // Fire all discovery calls in parallel, tolerate individual failures
    const results = await Promise.allSettled([
      req('sessions.list', {}),
      req('cron.list', {}),
      req('channels.status', {}),
      req('skills.list', {}),
      req('node.list', {}),
      req('config.get', {}),
      req('health', {}),
      req('system-presence', {}),
      req('models.list', {}),
    ]);

    const [
      sessions, cron, channels, skills, nodes, config, health, presence, models
    ] = results.map(r => r.status === 'fulfilled' ? r.value : null);

    return {
      sessions:  sessions?.payload  ?? null,
      cron:      cron?.payload      ?? null,
      channels:  channels?.payload  ?? null,
      skills:    skills?.payload    ?? null,
      nodes:     nodes?.payload     ?? null,
      config:    config?.payload    ?? null,
      health:    health?.payload    ?? null,
      presence:  presence?.payload  ?? null,
      models:    models?.payload    ?? null,
      errors: results
        .map((r, i) => r.status === 'rejected' ? [
          ['sessions.list','cron.list','channels.status','skills.list',
           'node.list','config.get','health','system-presence','models.list'][i],
          r.reason?.message
        ] : null)
        .filter(Boolean),
    };
  }

  function connect() {
    if (dead) return;
    console.log(`[clawville] connecting to ${gatewayUrl}…`);

    ws = new WebSocket(gatewayUrl);

    ws.on('open', () => {
      // First frame MUST be connect
      const connectFrame = {
        type: 'req',
        id: String(reqId++),
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 10,
          client: {
            id: DEVICE_ID,
            displayName: DISPLAY_NAME,
            version: '0.1.0',
            platform: 'node',
            mode: 'observer',
            instanceId: randomUUID(),
          },
          ...(token ? { auth: { token } } : {}),
        },
      };
      pending.set(connectFrame.id, {
        resolve: async (res) => {
          if (!res.ok) {
            const msg = res.error?.message ?? 'connect rejected';
            console.error(`[clawville] gateway rejected connect: ${msg}`);
            onError({ type: 'auth', message: msg });
            ws.close();
            return;
          }
          connected = true;
          console.log('[clawville] connected ✓');

          // hello-ok snapshot has health + presence already
          const helloOk = res.payload;

          // Now fire discovery
          let discovered;
          try {
            discovered = await discover();
          } catch (e) {
            discovered = { error: e.message };
          }

          onState({ helloOk, discovered });
        },
        reject: (e) => onError({ type: 'connect', message: e.message }),
      });
      ws.send(JSON.stringify(connectFrame));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'res') {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve(msg);
        }
      } else if (msg.type === 'event') {
        onEvent(msg);
      }
    });

    ws.on('close', (code, reason) => {
      connected = false;
      if (!dead) {
        console.log(`[clawville] disconnected (${code}), reconnecting in 5s…`);
        onEvent({ type: 'event', event: 'clawville.disconnected', payload: { code, reason: reason.toString() } });
        reconnectTimer = setTimeout(connect, 5000);
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
    isConnected: () => connected,
    destroy: () => {
      dead = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
