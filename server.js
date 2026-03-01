#!/usr/bin/env node
// server.js — ClawCove visualizer server
// Usage: node server.js  |  npx clawcove

import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

import { loadOpenclawConfig } from './lib/config.js';
import { createGatewayClient } from './lib/connect.js';
import { generateWorld, loadSavedLayout, saveLayout, mergeLayouts } from './lib/worldgen.js';
import { diffState } from './lib/diff.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT  = parseInt(process.env.CLAWCOVE_PORT ?? '2788', 10);
const AUTO_OPEN = process.env.CLAWCOVE_NO_OPEN !== '1';

// ── Token persistence ─────────────────────────────────────────────────────────
// Users paste their gateway token once via the UI. We save it to
// ~/.openclaw/clawcove-token (mode 0600) so it survives restarts
// without modifying openclaw.json.
const TOKEN_FILE = join(homedir(), '.openclaw', 'clawcove-token');

function loadSavedToken() {
  try { return readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}
function saveToken(t) {
  try {
    mkdirSync(join(homedir(), '.openclaw'), { recursive: true });
    writeFileSync(TOKEN_FILE, t.trim(), { mode: 0o600 });
    return true;
  } catch { return false; }
}
function clearToken() {
  try { writeFileSync(TOKEN_FILE, '', { mode: 0o600 }); return true; } catch { return false; }
}

const POLL_FAST   = 10_000;
const POLL_NORMAL = 30_000;
const POLL_SLOW   = 300_000;

// ── Config ────────────────────────────────────────────────────────────────────
const ocConfig = loadOpenclawConfig();
// Resolve token: openclaw.json → clawcove-token file → null (user prompted in UI)
const resolvedToken = ocConfig.token ?? loadSavedToken();
if (!ocConfig.found) {
  console.warn(`\n⚠  ${ocConfig.error}`);
  console.warn(resolvedToken ? '   Token found in clawcove-token file.' : '   Running in demo mode (no token).\n');
}
console.log(`\n🦞 CLAWCOVE`);
if (ocConfig.found) {
  console.log(`   Config:  ${ocConfig.configPath}`);
  console.log(`   Gateway: ${ocConfig.gatewayUrl}`);
}
console.log(`   Token:   ${resolvedToken ? '✓ found' : '✗ not set — will prompt in UI'}`);

// ── Static server ─────────────────────────────────────────────────────────────
const MIME = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json' };
function serveStatic(req, res) {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ version:'0.1.0', found:ocConfig.found, gateway:ocConfig.gatewayUrl }));
    return;
  }
  const fp = join(__dir, 'public', (req.url==='/'?'/index.html':req.url).split('?')[0]);
  const ext = fp.slice(fp.lastIndexOf('.'));
  if (existsSync(fp)) { res.writeHead(200,{'Content-Type':MIME[ext]??'text/plain'}); res.end(readFileSync(fp)); }
  else { res.writeHead(404); res.end('Not found'); }
}

const httpServer = createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// ── State ─────────────────────────────────────────────────────────────────────
let gatewayConn  = null;
let latestWorld  = null;
let currentState = null;
let jobBoard     = mkJobBoard();
let reqFn        = null;
const pollTimers = {};
const browsers   = new Set();

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const c of browsers) { if (c.readyState === WebSocket.OPEN) c.send(raw); }
}

// ── Job board ─────────────────────────────────────────────────────────────────
function mkJobBoard() {
  return { cronJobs:[], activeRuns:[], recentRuns:[], sessions:[], channels:[], skills:[], nodes:[] };
}

function refreshJobBoardFromState(state) {
  const d = state?.discovered ?? state;
  jobBoard.cronJobs = (d?.cron?.jobs ?? []).map(j => ({
    id:j.id, label:j.label??j.id, schedule:j.schedule,
    enabled:j.enabled!==false, lastRun:j.lastRun??null,
    nextRun:j.nextRun??null, runCount:j.runCount??0, lastStatus:j.lastStatus??'—'
  }));
  jobBoard.sessions = (d?.sessions?.sessions ?? []).map(s => ({
    sessionKey:s.sessionKey,
    agentId:s.agentId??s.sessionKey?.split?.(':')?.[1]??'main',
    contextTokens:s.contextTokens??0, updatedAt:s.updatedAt??null,
    hot:(s.contextTokens??0)>50000
  })).sort((a,b)=>b.contextTokens-a.contextTokens);
  jobBoard.channels = Object.entries(d?.channels?.channels??{}).map(([id,info])=>({
    id, status:info?.status??(info?.linked?'linked':'unknown'),
    linked:!!(info?.linked||info?.status==='linked'), messageCount:info?.messageCount??0
  }));
  jobBoard.skills = (d?.skills?.skills??[]).map(s=>({
    id:s.id??s.name, name:s.name??s.id, version:s.version??'—',
    enabled:s.enabled!==false, lastUsed:s.lastUsed??null
  }));
  jobBoard.nodes = (d?.nodes?.nodes??[]).map(n=>({
    id:n.id??n.deviceId, displayName:n.displayName??n.id,
    deviceFamily:n.deviceFamily??'headless', platform:n.platform??'—', connected:true
  }));
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  if (!reqFn) return;

  async function pollNormal() {
    try {
      const [sess,cron,ch,sk,nd] = await Promise.allSettled([
        reqFn('sessions.list',{}), reqFn('cron.list',{}), reqFn('channels.status',{}),
        reqFn('skills.list',{}),   reqFn('node.list',{})
      ]);
      applyUpdate({
        ...currentState,
        sessions: sess.value?.payload ?? currentState?.sessions,
        cron:     cron.value?.payload ?? currentState?.cron,
        channels: ch.value?.payload   ?? currentState?.channels,
        skills:   sk.value?.payload   ?? currentState?.skills,
        nodes:    nd.value?.payload   ?? currentState?.nodes,
      });
    } catch(e) { console.warn('[poll]', e.message); }
  }

  async function pollHealth() {
    try {
      const r = await reqFn('health',{});
      if (r?.payload) applyUpdate({ ...currentState, health: r.payload });
    } catch {}
  }

  async function pollConfig() {
    try {
      const r = await reqFn('config.get',{});
      if (r?.payload) applyUpdate({ ...currentState, config: r.payload });
    } catch {}
  }

  pollTimers.n = setInterval(pollNormal, POLL_NORMAL);
  pollTimers.h = setInterval(pollHealth, POLL_FAST);
  pollTimers.c = setInterval(pollConfig, POLL_SLOW);
  pollNormal(); pollHealth();
}

function stopPolling() { Object.values(pollTimers).forEach(clearInterval); }

// ── Apply update ──────────────────────────────────────────────────────────────
function applyUpdate(nextState) {
  const changes = currentState ? diffState(currentState, nextState) : [];
  currentState = nextState;
  refreshJobBoardFromState(nextState);
  broadcast({ type:'jobboard-update', jobBoard });
  if (!changes.length) return;
  console.log(`[clawcove] ${changes.length} change(s)`);
  changes.forEach(handleChange);
  if (changes.some(c=>['agent','cron','channel','skill','node'].includes(c.type)))
    saveLayout(ocConfig.clawcoveDir, latestWorld);
  broadcast({ type:'state-changes', changes });
}

function handleChange(ch) {
  const { type, action, id, next, prev } = ch;
  if (type==='agent') {
    if (action==='add') {
      const { nb, na } = buildAgentEntry(next, latestWorld);
      if (nb) latestWorld?.buildings?.push(nb);
      if (na) latestWorld?.agents?.push(na);
      broadcast({ type:'world-add-building', building:nb });
      broadcast({ type:'world-add-agent', agent:na });
      broadcast({ type:'log', text:`New agent: ${id}`, level:'new' });
    }
    if (action==='remove') {
      const b = latestWorld?.buildings?.find(b=>b.agentId===id);
      if (b) b.decaying = true;
      broadcast({ type:'world-decay-building', buildingId:`agent-${id}` });
      broadcast({ type:'world-remove-agent', agentId:id });
      broadcast({ type:'log', text:`Agent removed: ${id}`, level:'warn' });
    }
    if (action==='update') {
      broadcast({ type:'world-update-building', buildingId:`agent-${id}`, updates:{model:next?.model} });
      broadcast({ type:'log', text:`Agent ${id}: model → ${next?.model}`, level:'new' });
    }
  }
  if (type==='session') {
    if (action==='add')    broadcast({ type:'log', text:`Session: ${short(id)}`, level:'new' });
    if (action==='remove') broadcast({ type:'log', text:`Session ended: ${short(id)}`, level:'warn' });
    if (action==='update') broadcast({ type:'session-token-update', sessionKey:id,
      contextTokens:next?.contextTokens, delta:(next?.contextTokens??0)-(prev?.contextTokens??0) });
  }
  if (type==='cron') {
    if (action==='add')    broadcast({ type:'log', text:`Cron added: ${next?.label??id}`, level:'new' });
    if (action==='remove') broadcast({ type:'log', text:`Cron removed: ${id}`, level:'warn' });
    if (action==='update') broadcast({ type:'log', text:`Cron ${id}: ${next?.enabled?'enabled':'disabled'}`, level:'new' });
    if (action==='ran') {
      const j = jobBoard.cronJobs.find(j=>j.id===id);
      if (j) { j.runCount=(j.runCount??0)+1; j.lastRun=Date.now(); }
      broadcast({ type:'cron-ran', jobId:id, job:next });
      broadcast({ type:'log', text:`Cron ran: ${next?.label??id}`, level:'cron' });
    }
  }
  if (type==='channel') {
    if (action==='add'||action==='linked')    broadcast({ type:'log', text:`Channel ${id} linked`, level:'new' });
    if (action==='remove'||action==='unlinked') broadcast({ type:'log', text:`Channel ${id} gone`, level:'warn' });
  }
  if (type==='skill') {
    if (action==='add')    broadcast({ type:'log', text:`Skill: ${next?.name??id}`, level:'new' });
    if (action==='remove') broadcast({ type:'log', text:`Skill removed: ${id}`, level:'warn' });
  }
  if (type==='node') {
    if (action==='add')    broadcast({ type:'log', text:`Node: ${next?.displayName??id}`, level:'new' });
    if (action==='remove') broadcast({ type:'log', text:`Node left: ${id}`, level:'warn' });
  }
  if (type==='health') broadcast({ type:'health-change', status:next?.status });
}

// ── Gateway event handler ─────────────────────────────────────────────────────
function onGatewayEvent(event) {
  broadcast({ type:'gateway-event', event });
  const e = event.event, p = event.payload;

  if (e==='health') {
    const b = latestWorld?.buildings?.find(b=>b.id==='gateway');
    if (b) b.details.status = p?.status ?? 'ok';
  }
  if (e==='agent') {
    const agentId = p?.agentId ?? 'main';
    if (p?.status==='started'||p?.status==='running') {
      const run = jobBoard.activeRuns.find(r=>r.runId===p?.runId);
      if (!run) jobBoard.activeRuns.push({ runId:p?.runId??rid(), agentId,
        sessionKey:p?.sessionKey??'—', startedAt:Date.now(), tool:p?.tool??'—', status:'running' });
      else run.tool = p?.tool ?? run.tool;
      broadcast({ type:'jobboard-run-update', activeRuns:jobBoard.activeRuns });
    }
    if (p?.status==='ok'||p?.status==='error') {
      const idx = jobBoard.activeRuns.findIndex(r=>r.runId===p?.runId);
      if (idx!==-1) {
        const run = jobBoard.activeRuns.splice(idx,1)[0];
        jobBoard.recentRuns.unshift({ ...run, finishedAt:Date.now(),
          durationMs:Date.now()-run.startedAt, status:p.status });
        if (jobBoard.recentRuns.length>50) jobBoard.recentRuns.pop();
        broadcast({ type:'jobboard-run-update', activeRuns:jobBoard.activeRuns });
        broadcast({ type:'jobboard-recent-update', recentRuns:jobBoard.recentRuns.slice(0,20) });
      }
    }
  }
  if (e==='cron') {
    const j = jobBoard.cronJobs.find(j=>j.id===p?.jobId);
    if (j) { j.lastRun=Date.now(); j.runCount=(j.runCount??0)+1; }
    broadcast({ type:'jobboard-update', jobBoard });
  }
  if (e==='clawcove.disconnected') { broadcast({ type:'log', text:'Gateway disconnected', level:'warn' }); stopPolling(); }
  if (e==='clawcove.reconnected')  { startPolling(); }
}

// ── Gateway init ──────────────────────────────────────────────────────────────
function initGateway(tokenOverride) {
  const useToken = tokenOverride ?? resolvedToken;
  const canConnect = ocConfig.found || useToken;

  if (!canConnect) {
    // No config and no token — show demo, ask for token
    latestWorld = demoWorld();
    broadcast({ type:'world-init', world:latestWorld, mode:'demo' });
    broadcast({ type:'jobboard-update', jobBoard });
    broadcast({ type:'needs-token', gatewayUrl: ocConfig.gatewayUrl ?? 'ws://127.0.0.1:18789' });
    return;
  }

  // Tear down any existing connection first
  if (gatewayConn) { gatewayConn.destroy(); gatewayConn = null; }

  const url = ocConfig.gatewayUrl ?? 'ws://127.0.0.1:18789';
  gatewayConn = createGatewayClient(
    url, useToken,
    (state, req) => {
      reqFn = req;
      const ds = {
        helloOk:state.helloOk, discovered:state.discovered,
        sessions:state.discovered.sessions, cron:state.discovered.cron,
        channels:state.discovered.channels, skills:state.discovered.skills,
        nodes:state.discovered.nodes, config:state.discovered.config,
        health:state.discovered.health,
      };
      currentState = ds;
      const fresh = generateWorld(state);
      const saved = loadSavedLayout(ocConfig.clawcoveDir ?? join(homedir(), '.openclaw', 'workspace', 'clawcove'));
      latestWorld = mergeLayouts(saved, fresh);
      saveLayout(ocConfig.clawcoveDir ?? join(homedir(), '.openclaw', 'workspace', 'clawcove'), latestWorld);
      console.log(`[clawcove] city: ${latestWorld.buildings.length} buildings, ${latestWorld.agents.length} agents`);
      broadcast({ type:'world-init', world:latestWorld, mode:'live' });
      broadcast({ type:'token-ok' });
      refreshJobBoardFromState(currentState);
      broadcast({ type:'jobboard-update', jobBoard });
      startPolling();
    },
    onGatewayEvent,
    (err) => {
      broadcast({ type:'gateway-error', error:err });
      if (err.type === 'auth' || err.type === 'pairing') {
        broadcast({ type:'needs-token',
          gatewayUrl: url,
          error: err.message,
          isPairing: err.type === 'pairing' });
      }
      stopPolling();
    },
    { stateDir: ocConfig.stateDir ?? join(homedir(), '.openclaw') }
  );
}

// ── Browser WS ────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('[clawcove] browser connected');
  browsers.add(ws);

  // Tell the browser whether a token exists
  ws.send(JSON.stringify({
    type: 'server-config',
    hasToken: !!(resolvedToken),
    gatewayUrl: ocConfig.gatewayUrl ?? 'ws://127.0.0.1:18789',
  }));

  if (latestWorld) {
    ws.send(JSON.stringify({ type:'world-init', world:latestWorld,
      mode:gatewayConn?.isConnected()?'live':'cached' }));
    ws.send(JSON.stringify({ type:'jobboard-update', jobBoard }));
  } else {
    ws.send(JSON.stringify({ type:'connecting', gatewayUrl:ocConfig.gatewayUrl ?? 'ws://127.0.0.1:18789' }));
  }

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'save-token') {
      const t = (msg.token ?? '').trim();
      if (!t) { ws.send(JSON.stringify({ type:'token-error', error:'Token cannot be empty' })); return; }
      saveToken(t);
      console.log('[clawcove] token saved, reinitialising gateway…');
      broadcast({ type:'log', text:'Token saved — connecting…', level:'new' });
      initGateway(t);
    }

    if (msg.type === 'clear-token') {
      clearToken();
      if (gatewayConn) { gatewayConn.destroy(); gatewayConn = null; }
      stopPolling();
      console.log('[clawcove] token cleared');
      broadcast({ type:'token-cleared' });
      broadcast({ type:'needs-token', gatewayUrl: ocConfig.gatewayUrl ?? 'ws://127.0.0.1:18789' });
    }

    if (msg.type === 'user-message') {
      // Forward user message to manager agent via gateway
      if (reqFn && msg.text) {
        reqFn('chat.send', { text: msg.text, target: msg.target ?? 'main' })
          .catch(e => console.error('[clawcove] chat.send failed:', e.message));
      }
    }
  });

  ws.on('close', () => browsers.delete(ws));
  ws.on('error', () => browsers.delete(ws));
});

// ── Listen ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n🦞 → ${url}   (Ctrl+C to stop)\n`);
  initGateway();
  if (AUTO_OPEN) {
    const cmd = { darwin:'open', win32:'start', linux:'xdg-open' }[process.platform]??'open';
    import('child_process').then(({ exec }) => exec(`${cmd} ${url}`));
  }
});
httpServer.on('error', e => {
  console.error(e.code==='EADDRINUSE'?`\n❌ Port ${PORT} in use`:`\n❌ ${e.message}`);
  process.exit(1);
});
process.on('SIGINT', () => { console.log('\n🦞 bye'); stopPolling(); gatewayConn?.destroy(); process.exit(0); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function short(k) { return k.length>32 ? k.slice(0,30)+'…' : k; }
function rid()    { return Math.random().toString(36).slice(2,9); }
function cap(s)   { return s ? s[0].toUpperCase()+s.slice(1) : s; }
function tier(m='') { return m.includes('opus')?'large':m.includes('sonnet')?'medium':'small'; }
function hcol(s) {
  let h=2166136261;
  for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h*16777619)>>>0;}
  const hue=h%360,sat=60+(h>>8)%30,lit=45+(h>>16)%20;
  return { hue,css:`hsl(${hue},${sat}%,${lit}%)`,dark:`hsl(${hue},${sat}%,12%)`,
           darker:`hsl(${hue},${sat}%,8%)`,light:`hsl(${hue},${sat}%,70%)`,
           bright:`hsl(${hue},80%,55%)` };
}

function buildAgentEntry(agentDef, world) {
  const used = new Set((world?.buildings??[]).map(b=>`${b.x},${b.y}`));
  const zones = [{cx:20,cy:18},{cx:12,cy:22},{cx:28,cy:14},{cx:60,cy:18},
                 {cx:68,cy:22},{cx:53,cy:14},{cx:20,cy:27},{cx:58,cy:27}];
  const z = zones.find(z=>!used.has(`${z.cx-4},${z.cy-4}`)) ?? {cx:25+Math.floor(Math.random()*30),cy:20};
  const id=agentDef.id??'unknown', m=agentDef.model??'claude-sonnet-4-6', t=tier(m);
  const sz={large:{w:9,h:10},medium:{w:8,h:8},small:{w:7,h:7}}[t];
  const c=hcol(id);
  return {
    nb:{ id:`agent-${id}`,kind:'agent',agentId:id,name:`${cap(id)}'s Reef`,label:id.toUpperCase(),
         x:z.cx-Math.floor(sz.w/2),y:z.cy-Math.floor(sz.h/2),w:sz.w,h:sz.h,
         accent:c.css,wall:c.dark,roof:c.darker,details:{model:m,tier:t,agentId:id},
         activities:['Initializing…','Planning…','Running…','Reflecting…'],isNew:true },
    na:{ id,name:cap(id),role:`${cap(id)} Agent`,homeBuilding:`agent-${id}`,
         color:c.css,colorHue:c.hue,colorDark:c.dark,colorLight:c.light,antennae:c.bright,
         model:m,tier:t,startX:z.cx,startY:z.cy+sz.h+2,session:null }
  };
}

function demoWorld() {
  return { version:1, generatedAt:Date.now(), mode:'demo',
    buildings:[
      { id:'gateway',kind:'gateway',name:'The Spire',label:'GATEWAY SPIRE',
        x:35,y:19,w:8,h:10,accent:'#00e5ff',wall:'#041428',roof:'#021020',
        details:{url:'ws://127.0.0.1:18789',uptime:'offline',sessions:0,status:'offline'},
        activities:['Demo mode — connect OpenClaw'],shape:'tower'},
      { id:'agent-main',kind:'agent',agentId:'main',name:"Molty's Grotto",label:'MAIN GROTTO',
        x:15,y:13,w:9,h:10,accent:'#ff6b35',wall:'#180a06',roof:'#0e0503',
        details:{model:'claude-opus-4-6',tier:'large'},activities:['Waiting…']},
    ],
    agents:[{ id:'main',name:'Molty',role:'Main Agent',homeBuilding:'agent-main',
      color:'#ff6b35',colorHue:18,model:'claude-opus-4-6',tier:'large',startX:20,startY:22}],
    meta:{agentCount:1,sessionCount:0,cronJobCount:0,channelCount:0,skillCount:0,nodeCount:0,health:'offline'} };
}
