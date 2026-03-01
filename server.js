#!/usr/bin/env node
// server.js — Clawville visualizer server
// Serves the UI on http://127.0.0.1:2788 and proxies gateway WS.
// Usage: node server.js  |  npx clawville

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

import { loadOpenclawConfig } from './lib/config.js';
import { createGatewayClient } from './lib/connect.js';
import { generateWorld, loadSavedLayout, saveLayout, mergeLayouts } from './lib/worldgen.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CLAWVILLE_PORT ?? '2788', 10);
const AUTO_OPEN = process.env.CLAWVILLE_NO_OPEN !== '1';

// ── Load config ───────────────────────────────────────────────────────────────
const ocConfig = loadOpenclawConfig();

if (!ocConfig.found) {
  console.warn(`\n⚠  ${ocConfig.error}`);
  console.warn('   Clawville will start in offline/demo mode.\n');
}

console.log(`\n🦞 CLAWVILLE starting…`);
if (ocConfig.found) {
  console.log(`   OpenClaw config: ${ocConfig.configPath}`);
  console.log(`   Gateway: ${ocConfig.gatewayUrl}`);
  console.log(`   Token: ${ocConfig.token ? '✓ found' : '✗ not set (loopback may auto-auth)'}`);
  console.log(`   City data: ${ocConfig.clawvilleDir}`);
}

// ── Static file server ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serveStatic(req, res) {
  // Serve inline status page if no public dir exists yet
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      clawvilleVersion: '0.1.0',
      ocConfigFound: ocConfig.found,
      gatewayUrl: ocConfig.gatewayUrl,
      configPath: ocConfig.configPath ?? null,
    }));
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = join(__dir, 'public', filePath.split('?')[0]);

  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not found: ' + req.url);
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer(serveStatic);

// ── Browser WebSocket server ──────────────────────────────────────────────────
// Browser connects here → we proxy to gateway on the server side
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

let gatewayClient = null;
let latestWorld = null;
const browserClients = new Set();

function broadcastToBrowsers(msg) {
  const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

// Connect to gateway and generate world
function initGateway() {
  if (!ocConfig.found) {
    // Offline mode: send demo world
    latestWorld = getDemoWorld();
    broadcastToBrowsers({ type: 'world-init', world: latestWorld, mode: 'demo' });
    return;
  }

  gatewayClient = createGatewayClient(
    ocConfig.gatewayUrl,
    ocConfig.token,

    // onState: called once after connect + discovery
    (state) => {
      console.log('[clawville] gateway state received, generating world…');

      // Generate fresh world from gateway state
      const freshWorld = generateWorld(state);

      // Load saved layout, merge (preserves positions, adds new, marks removed)
      const saved = loadSavedLayout(ocConfig.clawvilleDir);
      latestWorld = mergeLayouts(saved, freshWorld);

      // Save updated layout
      saveLayout(ocConfig.clawvilleDir, latestWorld);

      console.log(`[clawville] world ready: ${latestWorld.buildings.length} buildings, ${latestWorld.agents.length} agents`);

      broadcastToBrowsers({ type: 'world-init', world: latestWorld, mode: 'live' });
    },

    // onEvent: live gateway events → forward to browsers
    (event) => {
      broadcastToBrowsers({ type: 'gateway-event', event });

      // Update world state based on event
      handleGatewayEvent(event);
    },

    // onError
    (err) => {
      console.error('[clawville] gateway error:', err.message);
      broadcastToBrowsers({ type: 'gateway-error', error: err });
    }
  );
}

function handleGatewayEvent(event) {
  if (!latestWorld) return;
  const e = event.event;

  if (e === 'health') {
    // Update gateway spire status
    const spire = latestWorld.buildings.find(b => b.id === 'gateway');
    if (spire) {
      spire.details.status = event.payload?.status ?? 'unknown';
      broadcastToBrowsers({ type: 'building-update', buildingId: 'gateway', details: spire.details });
    }
  }

  if (e === 'agent') {
    // Agent started/completed a run
    const agentId = event.payload?.agentId ?? event.payload?.sessionKey?.split(':')?.[1];
    if (agentId) {
      broadcastToBrowsers({
        type: 'agent-activity',
        agentId,
        status: event.payload?.status,
        tool: event.payload?.tool,
        sessionKey: event.payload?.sessionKey,
      });
    }
  }

  if (e === 'cron') {
    broadcastToBrowsers({ type: 'cron-fired', payload: event.payload });
  }

  if (e === 'chat') {
    broadcastToBrowsers({ type: 'chat-event', payload: event.payload });
  }

  if (e === 'presence') {
    broadcastToBrowsers({ type: 'presence-update', payload: event.payload });
  }
}

wss.on('connection', (browserWs) => {
  console.log('[clawville] browser connected');
  browserClients.add(browserWs);

  // Send current world immediately if we have it
  if (latestWorld) {
    browserWs.send(JSON.stringify({
      type: 'world-init',
      world: latestWorld,
      mode: gatewayClient?.isConnected() ? 'live' : 'cached',
    }));
  } else {
    browserWs.send(JSON.stringify({ type: 'connecting', gatewayUrl: ocConfig.gatewayUrl }));
  }

  browserWs.on('close', () => {
    console.log('[clawville] browser disconnected');
    browserClients.delete(browserWs);
  });

  browserWs.on('message', (raw) => {
    // Forward browser requests to gateway (for future interactive features)
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // For now: only allow read-only requests
    const ALLOWED = ['sessions.list','cron.list','channels.status','skills.list',
                     'node.list','health','system-presence','models.list','chat.history'];
    if (msg.type === 'req' && ALLOWED.includes(msg.method)) {
      // Re-issue to gateway, forward response back to this browser only
      console.log(`[clawville] browser req: ${msg.method}`);
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n🦞 Clawville running at ${url}`);
  console.log(`   Press Ctrl+C to stop.\n`);

  // Init gateway connection
  initGateway();

  // Open browser
  if (AUTO_OPEN) {
    const open = { darwin: 'open', win32: 'start', linux: 'xdg-open' }[process.platform] ?? 'open';
    import('child_process').then(({ exec }) => exec(`${open} ${url}`));
  }
});

httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} already in use. Try: CLAWVILLE_PORT=2789 node server.js`);
  } else {
    console.error('\n❌ Server error:', e.message);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n\n🦞 Clawville shutting down…');
  gatewayClient?.destroy();
  process.exit(0);
});

// ── Demo world (offline fallback) ─────────────────────────────────────────────
function getDemoWorld() {
  return {
    version: 1,
    generatedAt: Date.now(),
    mode: 'demo',
    buildings: [
      { id:'gateway', kind:'gateway', name:'The Spire', label:'GATEWAY SPIRE',
        x:35, y:19, w:8, h:10, accent:'#00e5ff', wall:'#041428', roof:'#021020',
        details:{ url:'ws://127.0.0.1:18789', uptime:'offline', sessions:0, status:'offline' },
        activities:['Gateway offline — demo mode'],
        shape:'tower' },
      { id:'agent-main', kind:'agent', agentId:'main', name:"Molty's Grotto",
        label:'MAIN GROTTO', x:15, y:13, w:9, h:10, accent:'#ff6b35',
        wall:'#180a06', roof:'#0e0503',
        details:{ model:'claude-opus-4-6', tier:'large' },
        activities:['Waiting for gateway…'] },
    ],
    agents: [
      { id:'main', name:'Molty', role:'Main Agent', homeBuilding:'agent-main',
        color:'#ff6b35', colorHue:18, model:'claude-opus-4-6', tier:'large',
        startX:20, startY:22 },
    ],
    meta: { agentCount:1, sessionCount:0, cronJobCount:0, channelCount:0,
            skillCount:0, nodeCount:0, health:'offline' },
  };
}
