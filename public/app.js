// public/app.js — Clawville canvas engine
// Receives world layout from server via WebSocket, renders it.

'use strict';

// ── Canvas setup ──────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const mmCanvas = document.getElementById('mmcanvas');
const mmCtx = mmCanvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

let W = 0, H = 0;
const TILE = 16, MW = 80, MH = 56;
let camX = 0, camY = 0;
let simSpeed = 1;
let tick = 0;
let simTime = 9 * 60;

// ── World state (populated by server messages) ────────────────────────────────
let WORLD = null;       // { buildings, agents, meta }
let BUILDINGS = [];
let AGENTS = [];
let worldMode = 'connecting'; // connecting | live | demo | cached

// ── Map ───────────────────────────────────────────────────────────────────────
const map = [];
for (let y = 0; y < MH; y++) { map.push([]); for (let x = 0; x < MW; x++) map[y].push(0); }

function st(x, y, v) { if (x >= 0 && x < MW && y >= 0 && y < MH) map[y][x] = v; }
function fr(x, y, w, h, v) { for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) st(x+dx, y+dy, v); }

function buildBaseMap() {
  fr(0,0,MW,3,2); fr(0,MH-3,MW,3,2); fr(0,0,3,MH,2); fr(MW-3,0,3,MH,2);
  fr(4,26,MW-8,4,1); fr(37,4,4,MH-8,1);
  fr(4,14,17,3,1); fr(4,42,21,3,1);
  fr(58,14,18,3,1); fr(58,40,18,3,1);
  fr(14,4,3,26,1); fr(57,4,3,26,1);
  fr(14,30,3,14,1); fr(57,30,3,14,1);
  fr(32,21,14,10,1);
  fr(68,34,8,18,2);
  fr(20,46,14,8,3); fr(46,4,12,9,3);
  for (let y = 3; y < MH-3; y++) for (let x = 3; x < MW-3; x++) {
    if (map[y][x] === 0) {
      const h = Math.sin(x*0.47+y*0.73)*Math.cos(x*0.31-y*0.59);
      if (h > 0.65 && (x+y)%4===0) st(x,y,5);
    }
  }
  [[6,6],[8,8],[10,7],[12,10],[7,12],[22,6],[24,8],[48,6],[50,7],[65,6],[67,8],
   [6,18],[8,20],[65,18],[6,35],[8,37],[22,36],[48,37],[65,35],[6,48],[8,50]].forEach(([x,y])=>st(x,y,4));
  [[9,5],[23,5],[49,5],[66,5],[7,22],[66,22],[7,40],[23,41],[49,41],[7,52]].forEach(([x,y])=>st(x,y,6));
  [[11,7],[25,9],[51,8],[68,8],[8,21],[67,21],[8,39],[67,39]].forEach(([x,y])=>st(x,y,7));
  [[15,16],[17,15],[62,15],[64,16]].forEach(([x,y])=>st(x,y,8));
}

function applyBuildingsToMap() {
  BUILDINGS.forEach(b => {
    if (b.decaying) return;
    fr(b.x, b.y, b.w, b.h, 1);
    const doorX = Math.floor(b.x + b.w / 2);
    st(doorX, b.y+b.h, 1); st(doorX, b.y+b.h+1, 1); st(doorX, b.y+b.h+2, 1);
  });
}

// ── Pathfinding ───────────────────────────────────────────────────────────────
function isWalkable(tx, ty) {
  if (tx<0||ty<0||tx>=MW||ty>=MH) return false;
  if (map[ty][tx]===2||map[ty][tx]===5) return false;
  for (const b of BUILDINGS) {
    if (b.decaying) continue;
    if (tx>=b.x&&tx<b.x+b.w&&ty>=b.y&&ty<b.y+b.h) {
      return tx===Math.floor(b.x+b.w/2)&&ty===b.y+b.h-1;
    }
  }
  return true;
}

function bfs(sx, sy, ex, ey) {
  if (sx===ex&&sy===ey) return [];
  const q=[[sx,sy]], vis={}, par={};
  vis[sx+','+sy]=true; par[sx+','+sy]=null;
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let lim=0;
  while(q.length&&lim++<3000) {
    const [cx,cy]=q.shift();
    if(cx===ex&&cy===ey){
      const path=[]; let k=ex+','+ey;
      while(par[k]){path.unshift(k.split(',').map(Number));k=par[k];}
      return path;
    }
    for(const [dx,dy] of dirs){
      const nx=cx+dx,ny=cy+dy,nk=nx+','+ny;
      if(!vis[nk]&&isWalkable(nx,ny)){vis[nk]=true;par[nk]=cx+','+cy;q.push([nx,ny]);}
    }
  }
  return [[ex,ey]];
}

function getBEntry(b) { return [Math.floor(b.x+b.w/2), b.y+b.h]; }

// ── Agent init from world ─────────────────────────────────────────────────────
function initAgentsFromWorld(worldAgents) {
  return worldAgents.map(a => {
    // Derive colorDark/colorLight from hue
    const h = a.colorHue ?? 180;
    return {
      ...a,
      px: a.startX * TILE,
      py: a.startY * TILE,
      colorDark: `hsl(${h},60%,10%)`,
      colorLight: `hsl(${h},60%,70%)`,
      antennae: `hsl(${h},80%,55%)`,
      path: [], state: 'idle', stateTimer: 0,
      schedIdx: 0, currentBuilding: null,
      facing: 'down', walkFrame: 0, walkTick: 0,
      speechText: '', speechTimer: 0, tailWave: 0,
      activeJob: null,  // set by gateway events
      glowing: false,
    };
  });
}

// ── Agent update ──────────────────────────────────────────────────────────────
function updateAgent(a) {
  a.stateTimer++;
  a.tailWave += 0.12 * simSpeed;

  // If idle for a while, wander toward home building
  if (a.state === 'idle' && a.stateTimer > 300 / simSpeed && !a.activeJob) {
    const home = BUILDINGS.find(b => b.id === a.homeBuilding);
    if (home) {
      const [ex, ey] = getBEntry(home);
      const ax = Math.round(a.px/TILE), ay = Math.round(a.py/TILE);
      if (Math.abs(ax-ex)+Math.abs(ay-ey) > 3) {
        a.path = bfs(ax, ay, ex, ey);
        a.state = 'walking';
        a.stateTimer = 0;
      }
    }
  }

  // Active job: walk to target building
  if (a.activeJob && a.state !== 'working') {
    const target = BUILDINGS.find(b => b.id === a.activeJob.buildingId);
    if (target) {
      const [ex, ey] = getBEntry(target);
      const ax = Math.round(a.px/TILE), ay = Math.round(a.py/TILE);
      if (Math.abs(ax-ex)+Math.abs(ay-ey) > 2) {
        if (a.path.length === 0) { a.path = bfs(ax, ay, ex, ey); a.state = 'walking'; }
      } else {
        a.state = 'working';
        a.currentBuilding = target;
        a.stateTimer = 0;
        if (Math.random() < 0.4) showSpeech(a, a.activeJob.label ?? 'Working…');
      }
    }
  }

  // Move along path
  if (a.path.length > 0) {
    const [tx, ty] = a.path[0];
    const tpx = tx*TILE, tpy = ty*TILE;
    const ddx = tpx-a.px, ddy = tpy-a.py;
    const dist = Math.sqrt(ddx*ddx+ddy*ddy);
    const spd = 1.1 * simSpeed;
    if (dist < spd+0.5) {
      a.px=tpx; a.py=tpy; a.path.shift();
      if (a.path.length===0) { a.state = a.activeJob ? 'working' : 'idle'; }
    } else {
      a.px+=ddx/dist*spd; a.py+=ddy/dist*spd;
      if(Math.abs(ddx)>Math.abs(ddy)) a.facing=ddx>0?'right':'left';
      else a.facing=ddy>0?'down':'up';
      a.walkTick++;
      if(a.walkTick%8===0) a.walkFrame=(a.walkFrame+1)%4;
    }
  }

  // Working timeout (return home after a while if no cancel event)
  if (a.state === 'working' && a.stateTimer > 240 / simSpeed && a.activeJob) {
    a.activeJob = null;
    a.state = 'idle';
    a.currentBuilding = null;
  }

  if (a.speechTimer > 0) a.speechTimer -= simSpeed;
}

// ── Speech bubbles ────────────────────────────────────────────────────────────
let activeSpeech = null;
function showSpeech(agent, text) {
  agent.speechText = text; agent.speechTimer = 180; activeSpeech = agent;
}
function updateSpeech() {
  const el = document.getElementById('speech');
  if (activeSpeech && activeSpeech.speechTimer > 0) {
    const sx = activeSpeech.px-camX, sy = activeSpeech.py-camY-36;
    el.style.display = 'block';
    el.style.left = Math.max(5, Math.min(W-250, sx))+'px';
    el.style.top = Math.max(54, sy)+'px';
    el.innerHTML = `<span style="color:${activeSpeech.color}">${activeSpeech.name}</span><br>${activeSpeech.speechText}`;
  } else {
    el.style.display = 'none'; activeSpeech = null;
  }
}

// Random chatter
let chatCooldown = 0;
function maybeChatter() {
  if (!AGENTS.length) return;
  chatCooldown--;
  if (chatCooldown <= 0 && Math.random() < 0.005) {
    chatCooldown = 400;
    const a = AGENTS[Math.floor(Math.random()*AGENTS.length)];
    const lines = {
      idle:    ['Thinking…','Planning…','Reflecting…'],
      working: ['Processing!','Running tool…','Almost done!'],
      walking: ['On my way!','Heading over!','Swimming…'],
    };
    const pool = lines[a.state] || lines.idle;
    showSpeech(a, pool[Math.floor(Math.random()*pool.length)]);
  }
}

// ── Event log ─────────────────────────────────────────────────────────────────
let logEntries = [];
function addLog(text, type='new') {
  logEntries.unshift({ text: text.slice(0,42), type });
  if (logEntries.length > 10) logEntries.pop();
  const el = document.getElementById('log-entries');
  if (el) el.innerHTML = logEntries.map((e,i)=>`<div class="log-entry${i===0?' new':''} ${e.type}">${
    e.type==='warn'?'⚠ ':e.type==='live'?'◈ ':'▸ '
  }${e.text}</div>`).join('');
}

// ── Gateway event handler ─────────────────────────────────────────────────────
function handleGatewayEvent(event) {
  const e = event.event;
  if (e === 'agent') {
    const p = event.payload;
    const status = p?.status;
    const agentId = p?.agentId ?? 'main';
    const agent = AGENTS.find(a => a.id === agentId || (agentId==='main' && a.id==='main'));
    if (agent) {
      if (status === 'started' || status === 'running') {
        const tool = p?.tool ?? 'processing';
        agent.activeJob = { buildingId: 'gateway', label: `${tool}…` };
        agent.glowing = true;
        addLog(`${agent.name}: ${tool}`, 'live');
      } else if (status === 'ok' || status === 'error') {
        agent.activeJob = null;
        agent.glowing = false;
        agent.state = 'idle';
        addLog(`${agent.name}: run complete`, 'new');
      }
    }
  }
  if (e === 'cron') {
    const cleo = AGENTS.find(a => a.id === 'cleo');
    const cronBldg = BUILDINGS.find(b => b.id === 'cron');
    if (cleo && cronBldg) {
      cleo.activeJob = { buildingId: 'cron', label: 'Cron job!' };
      showSpeech(cleo, `Cron: ${event.payload?.jobId ?? 'job fired'}!`);
    }
    addLog(`Cron fired: ${event.payload?.jobId ?? '—'}`, 'warn');
  }
  if (e === 'chat') {
    const ch = event.payload?.channel ?? '';
    addLog(`Chat: ${ch} message in`, 'live');
  }
  if (e === 'health') {
    const spire = BUILDINGS.find(b => b.id === 'gateway');
    if (spire) spire.details.status = event.payload?.status ?? 'ok';
  }
  if (e === 'clawville.disconnected') {
    setStatusPill('offline', 'DISCONNECTED');
    addLog('Gateway disconnected', 'warn');
  }
}

// ── Handle agent-activity message from server ─────────────────────────────────
function handleAgentActivity(msg) {
  const agent = AGENTS.find(a => a.id === msg.agentId || (msg.agentId==='main'&&a.id==='main'));
  if (!agent) return;
  if (msg.status === 'started' || msg.status === 'running') {
    agent.activeJob = { buildingId: 'gateway', label: msg.tool ?? 'processing…' };
    agent.glowing = true;
  } else if (msg.status === 'ok' || msg.status === 'error') {
    setTimeout(() => { agent.activeJob = null; agent.glowing = false; }, 2000);
  }
}

// ── Status pill ───────────────────────────────────────────────────────────────
function setStatusPill(cls, text) {
  const el = document.getElementById('status-pill');
  el.className = `status-pill ${cls}`;
  el.textContent = text;
}

// ── Tiles ─────────────────────────────────────────────────────────────────────
function drawTile(tx, ty) {
  const sx=tx*TILE-camX, sy=ty*TILE-camY;
  if(sx<-TILE||sx>W+TILE||sy<-TILE||sy>H+TILE) return;
  const t=map[ty][tx], ev=(tx+ty)%2===0;
  if(t===0){
    ctx.fillStyle=ev?'#041428':'#061c34'; ctx.fillRect(sx,sy,TILE,TILE);
    if((tx*3+ty*7)%13===0){ctx.fillStyle='#030f20';ctx.fillRect(sx+2,sy+2,4,4);}
  }else if(t===1){
    ctx.fillStyle=ev?'#0d2a42':'#122e48'; ctx.fillRect(sx,sy,TILE,TILE);
    ctx.fillStyle='#003355'; ctx.fillRect(sx+1,sy+1,5,5); ctx.fillRect(sx+9,sy+9,4,4);
  }else if(t===2){
    ctx.fillStyle='#020c18'; ctx.fillRect(sx,sy,TILE,TILE);
    ctx.fillStyle='rgba(0,15,50,0.6)'; ctx.fillRect(sx,sy,TILE,TILE);
  }else if(t===3){
    ctx.fillStyle=ev?'#1a3a5a':'#2a4a6a'; ctx.fillRect(sx,sy,TILE,TILE);
  }else if(t===4){
    ctx.fillStyle='#041428'; ctx.fillRect(sx,sy,TILE,TILE);
    const wv=Math.round(Math.sin(tick*0.04+tx*0.7)*1.5);
    ctx.fillStyle='#8a1a30'; ctx.fillRect(sx+6,sy+11,4,5);
    ctx.fillStyle=(tx+ty)%3===0?'#ff4a6a':(tx+ty)%3===1?'#ff6a3a':'#ff3a5a';
    ctx.fillRect(sx+4,sy+5+wv,8,7); ctx.fillRect(sx+2,sy+7,5,5); ctx.fillRect(sx+9,sy+7,5,5);
    ctx.fillStyle='#00e5ff'; ctx.fillRect(sx+5,sy+3+wv,3,2);
  }else if(t===5){
    ctx.fillStyle='#041428'; ctx.fillRect(sx,sy,TILE,TILE);
    ctx.fillStyle='#0a1e30'; ctx.fillRect(sx+2,sy+6,12,7);
    ctx.fillStyle='#142840'; ctx.fillRect(sx+3,sy+5,10,3);
  }else if(t===6){
    ctx.fillStyle='#041428'; ctx.fillRect(sx,sy,TILE,TILE);
    const sw=Math.round(Math.sin(tick*0.05+tx*0.8)*2);
    ctx.fillStyle='#008040'; ctx.fillRect(sx+7,sy+8,2,8);
    ctx.fillStyle='#00a050'; ctx.fillRect(sx+5+sw,sy+4,4,6);
    ctx.fillRect(sx+7+Math.round(sw*0.6),sy+1,4,5);
  }else if(t===7){
    ctx.fillStyle='#041428'; ctx.fillRect(sx,sy,TILE,TILE);
    const aw=Math.round(Math.sin(tick*0.06+tx*0.5));
    ctx.fillStyle='#8a1a30'; ctx.fillRect(sx+6,sy+12,4,4);
    for(let ii=0;ii<5;ii++){ctx.fillStyle=ii%2===0?'#cc44ff':'#ee88ff';ctx.fillRect(sx+3+ii*2+Math.round(Math.sin(tick*0.07+ii)*aw),sy+4,3,9);}
  }else if(t===8){
    ctx.fillStyle='#041428'; ctx.fillRect(sx,sy,TILE,TILE);
    ctx.fillStyle='#a07848'; ctx.fillRect(sx+3,sy+8,10,6);
    ctx.fillStyle='#d4a878'; ctx.fillRect(sx+4,sy+6,8,6);
  }
}

// ── Buildings ─────────────────────────────────────────────────────────────────
function drawBuilding(b) {
  const sx=b.x*TILE-camX, sy=b.y*TILE-camY, bw=b.w*TILE, bh=b.h*TILE;
  if(sx>W+20||sx+bw<-20||sy>H+20||sy+bh<-20) return;

  const isActive = AGENTS.some(a=>a.currentBuilding?.id===b.id&&a.state==='working');
  const gp=Math.sin(tick*0.06)*0.5+0.5;
  const decay = b.decaying ? Math.max(0, 1 - (Date.now()-b.decayStart)/8000) : 1;

  ctx.save();
  if(b.decaying) ctx.globalAlpha = decay * 0.5;

  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(sx+5,sy+5,bw,bh);
  ctx.fillStyle=b.roof||'#021020'; ctx.fillRect(sx,sy,bw,bh);
  ctx.fillStyle=b.wall||'#041428'; ctx.fillRect(sx+1,sy+1,bw-2,bh-2);
  ctx.fillStyle=b.roof||'#021020'; ctx.fillRect(sx,sy,bw,TILE*2);
  ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(sx+2,sy+1,bw-4,2);

  if(isActive){
    const ga=Math.round(20+gp*35).toString(16).padStart(2,'0');
    ctx.fillStyle=(b.accent||'#00e5ff')+ga; ctx.fillRect(sx+1,sy+1,bw-2,bh-2);
  }

  for(let row=2;row<b.h-1;row++){
    for(let col=0;col<b.w;col++){
      const wx=sx+col*TILE+2,wy=sy+row*TILE+3;
      const isDoor=col===Math.floor(b.w/2)&&row===b.h-2;
      if(isDoor){
        ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(wx+1,wy-1,TILE-6,TILE-2);
        ctx.fillStyle=(b.accent||'#00e5ff'); ctx.fillRect(wx+2,wy-3,TILE-8,4);
      }else if(col%2===0){
        const glowing=isActive&&Math.sin(tick*0.1+col*1.3+row*0.7)>0.3;
        ctx.fillStyle='#020c18'; ctx.fillRect(wx+1,wy,8,7);
        ctx.fillStyle=glowing?(b.accent||'#00e5ff'):'rgba(0,50,90,0.5)'; ctx.fillRect(wx+2,wy+1,6,5);
        ctx.fillStyle=(b.accent||'#00e5ff')+'55';
        ctx.fillRect(wx+1,wy,8,1);ctx.fillRect(wx+1,wy+6,8,1);ctx.fillRect(wx+1,wy,1,7);ctx.fillRect(wx+8,wy,1,7);
      }
    }
  }

  ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(sx,sy+bh-2,bw,2);
  ctx.fillStyle=(b.accent||'#00e5ff')+'66';
  ctx.fillRect(sx,sy+TILE*2,2,bh-TILE*2-2); ctx.fillRect(sx+bw-2,sy+TILE*2,2,bh-TILE*2-2);

  if(b.shape==='tower'){
    const anH=b.kind==='gateway'?20:10;
    ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(sx+bw/2-1,sy-anH,2,anH);
    const orbR=b.kind==='gateway'?5:3;
    ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(sx+bw/2-orbR,sy-anH-orbR*2,orbR*2,orbR*2);
    const ga2=Math.round(50+gp*100).toString(16).padStart(2,'0');
    ctx.fillStyle=(b.accent||'#00e5ff')+ga2; ctx.fillRect(sx+bw/2-orbR-2,sy-anH-orbR*2-2,orbR*2+4,orbR*2+4);
  }

  ctx.fillStyle='#ff4a6a'; ctx.fillRect(sx+2,sy-4,3,5); ctx.fillRect(sx+bw-5,sy-4,3,5);
  ctx.fillStyle='#00ffaa'; ctx.fillRect(sx+3,sy-5,1,2); ctx.fillRect(sx+bw-4,sy-5,1,2);

  ctx.fillStyle='rgba(0,0,10,0.88)'; ctx.fillRect(sx+1,sy-15,bw-2,12);
  ctx.fillStyle=b.accent||'#00e5ff'; ctx.font='bold 6px "Press Start 2P",monospace';
  ctx.textAlign='center';

  // Truncate label to fit
  const maxW = bw - 6;
  let label = b.label || b.name || b.id;
  ctx.fillText(label, sx+bw/2, sy-6, maxW);

  if(isActive){ctx.fillStyle=b.accent||'#00e5ff';ctx.fillRect(sx+bw-8,sy+2,5,5);}
  ctx.restore();

  // Decay: sinking effect
  if(b.decaying && decay <= 0) {
    BUILDINGS = BUILDINGS.filter(bb => bb !== b);
  }
}

// ── Lobster agent sprite ──────────────────────────────────────────────────────
function drawAgent(a) {
  const sx=a.px-camX, sy=a.py-camY;
  if(sx<-40||sx>W+40||sy<-40||sy>H+40) return;
  const C1=a.color||'#ff6b35', C2=a.colorDark||'#6a1500', CL=a.colorLight||'#ff9a60';
  const isW=a.state==='walking', isWk=a.state==='working';
  const bob=isW?Math.sin(a.walkFrame*Math.PI*0.5)*2:0;
  const wkb=isWk?Math.sin(tick*0.12+a.px*0.01)*1:0;
  const bx=Math.round(sx-7), by=Math.round(sy-14+bob+wkb);

  // Glow if active
  if(a.glowing || isWk){
    ctx.save();
    ctx.globalAlpha=0.3+Math.sin(tick*0.1)*0.2;
    ctx.fillStyle=C1; ctx.beginPath(); ctx.arc(sx,sy-5,14,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle='rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(sx,sy+2,7,3,0,0,Math.PI*2); ctx.fill();

  const tw=Math.round(Math.sin(a.tailWave)*2);
  ctx.fillStyle=C2; ctx.fillRect(bx+1,by+14,12,5);
  ctx.fillStyle=C1; ctx.fillRect(bx+2,by+14,4,4); ctx.fillRect(bx+6,by+14,4,4);
  ctx.fillRect(bx+1+tw,by+16,3,3); ctx.fillRect(bx+10-tw,by+16,3,3);
  ctx.fillStyle=C2; ctx.fillRect(bx+2,by+7,10,8);
  ctx.fillStyle=C1; ctx.fillRect(bx+3,by+8,8,6);
  ctx.fillStyle=C2; ctx.fillRect(bx+3,by+10,8,1); ctx.fillRect(bx+3,by+12,8,1);
  ctx.fillStyle=C2; ctx.fillRect(bx+1,by+2,12,8);
  ctx.fillStyle=C1; ctx.fillRect(bx+2,by+3,10,6);
  ctx.fillStyle=CL; ctx.fillRect(bx+3,by+3,4,3);
  ctx.fillStyle=C2; ctx.fillRect(bx+2,by-1,10,5);
  ctx.fillStyle=C1; ctx.fillRect(bx+3,by,8,4);
  ctx.fillStyle=C2; ctx.fillRect(bx+2,by-2,2,3); ctx.fillRect(bx+10,by-2,2,3);
  ctx.fillStyle='#ffffff'; ctx.fillRect(bx+2,by-2,2,2); ctx.fillRect(bx+10,by-2,2,2);
  ctx.fillStyle='#000000'; ctx.fillRect(bx+2,by-2,1,1); ctx.fillRect(bx+11,by-2,1,1);

  const antW=Math.round(Math.sin(tick*0.07+a.px*0.03)*2);
  ctx.fillStyle=a.antennae||C1;
  ctx.fillRect(bx+2,by-5+Math.round(antW*0.5),1,4); ctx.fillRect(bx+1,by-8+antW,1,4);
  ctx.fillRect(bx+11,by-5+Math.round(-antW*0.5),1,4); ctx.fillRect(bx+12,by-8-antW,1,4);
  ctx.fillRect(bx+4,by-3,1,3); ctx.fillRect(bx+9,by-3,1,3);

  const ca=isWk?Math.round(Math.sin(tick*0.15)*2):0;
  ctx.fillStyle=C2; ctx.fillRect(bx-3,by+3+ca,5,5);
  ctx.fillStyle=C1; ctx.fillRect(bx-2,by+4+ca,4,4);
  ctx.fillStyle=CL; ctx.fillRect(bx-2,by+4+ca,2,2);
  if(isWk){ctx.fillStyle='#020c18';ctx.fillRect(bx-1,by+6+ca,2,2);}
  ctx.fillStyle=C2; ctx.fillRect(bx+12,by+3-ca,5,5);
  ctx.fillStyle=C1; ctx.fillRect(bx+12,by+4-ca,4,4);
  ctx.fillStyle=CL; ctx.fillRect(bx+14,by+4-ca,2,2);
  if(isWk){ctx.fillStyle='#020c18';ctx.fillRect(bx+13,by+6-ca,2,2);}

  const lo=isW?(a.walkFrame%2)*2:0;
  ctx.fillStyle=C2;
  for(let li=0;li<3;li++){
    ctx.fillRect(bx+3+li*3,by+9,1,4+Math.round(li%2===0?lo:-lo));
    ctx.fillRect(bx+11-li*3,by+9,1,4+Math.round(li%2===0?-lo:lo));
  }

  ctx.fillStyle='rgba(0,0,0,0.72)'; ctx.fillRect(sx-30,by-22,60,13);
  ctx.fillStyle=a.color||'#ff6b35'; ctx.font='8px "Press Start 2P",monospace';
  ctx.textAlign='center'; ctx.fillText(a.name||a.id, sx, by-11, 56);
}

// ── Bubbles ───────────────────────────────────────────────────────────────────
const BUBBLES = Array.from({length:50},()=>({
  x:Math.random()*MW*TILE, y:Math.random()*MH*TILE,
  r:0.8+Math.random()*3, speed:0.25+Math.random()*0.45, phase:Math.random()*Math.PI*2
}));

function drawBubbles() {
  for(const b of BUBBLES){
    b.y -= b.speed*simSpeed; b.x += Math.sin(tick*0.02+b.phase)*0.25;
    if(b.y<-20){b.y=MH*TILE+10;b.x=Math.random()*MW*TILE;}
    const bsx=b.x-camX, bsy=b.y-camY;
    if(bsx<-10||bsx>W+10||bsy<-10||bsy>H+10) continue;
    ctx.strokeStyle='rgba(80,200,255,0.3)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.arc(bsx,bsy,b.r,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle='rgba(120,220,255,0.05)'; ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.4)';
    ctx.fillRect(bsx-b.r*0.4,bsy-b.r*0.5,Math.max(1,b.r*0.4),Math.max(1,b.r*0.4));
  }
}

function drawCaustics() {
  ctx.save(); ctx.globalAlpha=0.025;
  for(let ci=0;ci<6;ci++){
    const rx=ci*W*0.2+Math.sin(tick*0.015+ci*1.1)*W*0.05;
    const rw=35+Math.sin(tick*0.02+ci*0.9)*18;
    ctx.fillStyle='rgba(0,160,255,1)';
    ctx.beginPath(); ctx.moveTo(rx,0); ctx.lineTo(rx+rw,0);
    ctx.lineTo(rx+rw*0.7+Math.sin(tick*0.01)*15,H);
    ctx.lineTo(rx-rw*0.3+Math.sin(tick*0.012)*15,H);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// ── Camera ────────────────────────────────────────────────────────────────────
function updateCamera() {
  if (!AGENTS.length) return;
  const hero = AGENTS[0];
  camX += (hero.px-W/2-camX)*0.05;
  camY += (hero.py-H/2-camY)*0.05;
  camX = Math.max(0, Math.min(MW*TILE-W, camX));
  camY = Math.max(0, Math.min(MH*TILE-H, camY));
}

// ── Minimap ───────────────────────────────────────────────────────────────────
function drawMinimap() {
  const mmW=120, mmH=84, sx=mmW/MW, sy2=mmH/MH;
  mmCtx.fillStyle='#020c18'; mmCtx.fillRect(0,0,mmW,mmH);
  BUILDINGS.forEach(b=>{
    if(b.decaying) return;
    mmCtx.fillStyle=(b.accent||'#00e5ff')+'88';
    mmCtx.fillRect(b.x*sx,b.y*sy2,b.w*sx,b.h*sy2);
  });
  AGENTS.forEach(a=>{
    mmCtx.fillStyle=a.color||'#ff6b35';
    mmCtx.fillRect((a.px/TILE)*sx-2,(a.py/TILE)*sy2-2,4,4);
  });
  mmCtx.strokeStyle='rgba(0,229,255,0.5)'; mmCtx.lineWidth=1;
  mmCtx.strokeRect((camX/TILE)*sx,(camY/TILE)*sy2,(W/TILE)*sx,(H/TILE)*sy2);
}

// ── Drag/pan ──────────────────────────────────────────────────────────────────
let isDragging=false, dragStart={x:0,y:0}, camStart={x:0,y:0};
canvas.addEventListener('mousedown', e=>{
  const r=canvas.getBoundingClientRect();
  const mx=e.clientX-r.left+camX, my=e.clientY-r.top+camY;
  let hit=false;
  for(const a of AGENTS){if(Math.abs(a.px-mx)<14&&Math.abs(a.py-my)<16){openAgentPanel(a);hit=true;break;}}
  if(!hit){
    for(const b of BUILDINGS){
      if(!b.decaying&&mx>=b.x*TILE&&mx<(b.x+b.w)*TILE&&my>=b.y*TILE&&my<(b.y+b.h)*TILE){
        openBuildingPanel(b);hit=true;break;
      }
    }
  }
  if(!hit){isDragging=true;dragStart={x:e.clientX,y:e.clientY};camStart={x:camX,y:camY};}
});
canvas.addEventListener('mousemove',e=>{if(!isDragging)return;camX=camStart.x-(e.clientX-dragStart.x);camY=camStart.y-(e.clientY-dragStart.y);});
canvas.addEventListener('mouseup',()=>isDragging=false);
canvas.addEventListener('mouseleave',()=>isDragging=false);

// Touch
let lastTouch=null;
canvas.addEventListener('touchstart',e=>{e.preventDefault();lastTouch={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:false});
canvas.addEventListener('touchmove',e=>{e.preventDefault();if(!lastTouch)return;camX-=e.touches[0].clientX-lastTouch.x;camY-=e.touches[0].clientY-lastTouch.y;lastTouch={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:false});
canvas.addEventListener('touchend',()=>lastTouch=null);

// ── Inspector panels ──────────────────────────────────────────────────────────
function openAgentPanel(a) {
  let h=`<div class="ip-title">${a.name}<br><span style="font-size:6px;color:${a.color}">${a.role||'Agent'}</span></div>`;
  h+=`<div class="ip-section">◈ STATUS</div>`;
  h+=`<div class="ip-row">state: <span>${(a.state||'idle').toUpperCase()}</span></div>`;
  h+=`<div class="ip-row">location: <span>${a.currentBuilding?.name||'open water'}</span></div>`;
  h+=`<div class="ip-row">model: <span>${a.model||'—'}</span></div>`;
  if(a.activeJob) h+=`<div class="ip-row">task: <span>${a.activeJob.label}</span></div>`;
  if(a.session){
    h+=`<div class="ip-section">◈ SESSION</div>`;
    h+=`<div class="ip-row">key: <span>${(a.session.sessionKey||'').slice(0,28)}…</span></div>`;
    h+=`<div class="ip-row">tokens: <span>${Math.round((a.session.contextTokens||0)/1000)}k</span></div>`;
  }
  document.getElementById('ipc').innerHTML=h;
  document.getElementById('infopanel').classList.add('show');
}

function openBuildingPanel(b) {
  let h=`<div class="ip-title" style="color:${b.accent||'#00e5ff'}">${b.label||b.name}</div>`;
  h+=`<div style="font-family:'Press Start 2P',monospace;font-size:6px;color:#0a5070;margin-bottom:10px;line-height:1.9">${b.kind?.toUpperCase()}</div>`;
  if(b.details){
    h+=`<div class="ip-section">⚙ DETAILS</div>`;
    for(const[k,v] of Object.entries(b.details)){
      h+=`<div class="ip-row">${k}: <span>${v}</span></div>`;
    }
  }
  const inside = AGENTS.filter(a=>a.currentBuilding?.id===b.id);
  if(inside.length){
    h+=`<div class="ip-section">🦞 INSIDE (${inside.length})</div>`;
    inside.forEach(a=>{h+=`<div class="ip-mem" style="color:${a.color}">▸ ${a.name}</div>`;});
  }
  if(b.activities?.length){
    h+=`<div class="ip-section">⚡ ACTIVITY</div>`;
    h+=`<div class="ip-mem">▸ ${b.activities[Math.floor(tick/200)%b.activities.length]}</div>`;
  }
  if(b.cronJobs?.length){
    h+=`<div class="ip-section">⏰ CRON JOBS</div>`;
    b.cronJobs.forEach(j=>{h+=`<div class="ip-mem">${j.enabled?'▸':'○'} ${j.label||j.id} — ${j.schedule}</div>`;});
  }
  if(b.channels?.length){
    h+=`<div class="ip-section">📡 CHANNELS</div>`;
    b.channels.forEach(c=>{h+=`<div class="ip-mem" style="color:${c.color||'#aaa'}">▸ ${c.id}</div>`;});
  }
  document.getElementById('ipc').innerHTML=h;
  document.getElementById('infopanel').classList.add('show');
}

// ── Controls ──────────────────────────────────────────────────────────────────
function setSpeed(s) {
  simSpeed=s;
  document.querySelectorAll('.spdbtn').forEach((btn,i)=>{
    btn.classList.toggle('active',[0.5,1,2,4][i]===s);
  });
}
window.setSpeed=setSpeed;

// ── Resize ────────────────────────────────────────────────────────────────────
function resize(){
  W=canvas.offsetWidth; H=canvas.offsetHeight;
  canvas.width=W*devicePixelRatio; canvas.height=H*devicePixelRatio;
  ctx.scale(devicePixelRatio,devicePixelRatio); ctx.imageSmoothingEnabled=false;
}
window.addEventListener('resize',resize);

// ── Main loop ─────────────────────────────────────────────────────────────────
function loop(){
  tick++;
  simTime += 0.025 * simSpeed;
  if(simTime>=24*60) simTime=0;
  AGENTS.forEach(updateAgent);
  maybeChatter();
  updateCamera();
  updateSpeech();

  ctx.fillStyle='#020c18'; ctx.fillRect(0,0,W,H);
  drawCaustics();

  const tx0=Math.max(0,Math.floor(camX/TILE)-1), tx1=Math.min(MW,Math.ceil((camX+W)/TILE)+1);
  const ty0=Math.max(0,Math.floor(camY/TILE)-1), ty1=Math.min(MH,Math.ceil((camY+H)/TILE)+1);
  for(let ty=ty0;ty<ty1;ty++) for(let tx=tx0;tx<tx1;tx++) drawTile(tx,ty);

  drawBubbles();
  BUILDINGS.forEach(drawBuilding);
  AGENTS.slice().sort((a,b)=>a.py-b.py).forEach(drawAgent);
  drawMinimap();

  const h=Math.floor(simTime/60)%24, m=Math.floor(simTime%60);
  const ap=h>=12?'PM':'AM', hh=h>12?h-12:h===0?12:h;
  const clockEl = document.getElementById('clockel');
  if(clockEl) clockEl.innerHTML=`${String(hh).padStart(2,'0')}:${String(m).padStart(2,'0')} ${ap}<br><span style="font-size:6px;color:#0a3050">${worldMode.toUpperCase()}</span>`;

  requestAnimationFrame(loop);
}

// ── World init ────────────────────────────────────────────────────────────────
function applyWorld(world) {
  WORLD = world;
  BUILDINGS = world.buildings || [];
  AGENTS = initAgentsFromWorld(world.agents || []);

  // Rebuild walkable map
  for(let y=0;y<MH;y++) for(let x=0;x<MW;x++) map[y][x]=0;
  buildBaseMap();
  applyBuildingsToMap();

  if(AGENTS.length) {
    camX = AGENTS[0].px - W/2;
    camY = AGENTS[0].py - H/2;
  }

  // Update legend
  const legendEl = document.getElementById('legend-agents');
  if(legendEl) legendEl.innerHTML = AGENTS.map(a=>
    `<div class="lr"><div class="ld" style="background:${a.color}"></div>${a.name} — ${a.role}</div>`
  ).join('');

  // Hide splash
  const splash = document.getElementById('splash');
  if(splash) splash.classList.add('hidden');

  addLog(`City loaded: ${BUILDINGS.length} buildings, ${AGENTS.length} agents`,'new');
  addLog(`Mode: ${world.mode||worldMode}`, 'live');
}

// ── WebSocket to server ───────────────────────────────────────────────────────
function connectToServer() {
  const ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onopen = () => {
    console.log('[clawville] connected to server');
    setStatusPill('connecting', 'LOADING…');
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'world-init') {
      worldMode = msg.mode || 'live';
      setStatusPill(
        msg.mode === 'live' ? 'live' : msg.mode === 'demo' ? 'demo' : 'offline',
        msg.mode === 'live' ? '● LIVE' : msg.mode === 'demo' ? '◌ DEMO' : '○ CACHED'
      );
      applyWorld(msg.world);
    }

    else if (msg.type === 'gateway-event') {
      handleGatewayEvent(msg.event);
    }

    else if (msg.type === 'agent-activity') {
      handleAgentActivity(msg);
    }

    else if (msg.type === 'gateway-error') {
      const err = msg.error;
      setStatusPill('offline', '✗ ERROR');
      const splashMsg = document.getElementById('splash-msg');
      if(splashMsg) splashMsg.textContent = err.message || 'Gateway error';
      addLog(err.message || 'gateway error', 'warn');
    }

    else if (msg.type === 'connecting') {
      const splashMsg = document.getElementById('splash-msg');
      if(splashMsg) splashMsg.textContent = `Connecting to ${msg.gatewayUrl}…`;
    }

    else if (msg.type === 'building-update') {
      const b = BUILDINGS.find(b => b.id === msg.buildingId);
      if (b) Object.assign(b.details, msg.details);
    }

    else if (msg.type === 'cron-fired') {
      addLog(`Cron: ${msg.payload?.jobId ?? 'job fired'}`, 'warn');
    }

    else if (msg.type === 'chat-event') {
      addLog(`Chat: ${msg.payload?.channel ?? 'message'} in`, 'live');
    }

    else if (msg.type === 'presence-update') {
      addLog(`Presence: ${msg.payload?.mode ?? 'update'}`, 'new');
    }
  };

  ws.onclose = () => {
    setStatusPill('offline', '○ SERVER OFF');
    addLog('Lost connection to Clawville server', 'warn');
    setTimeout(connectToServer, 3000);
  };

  ws.onerror = () => {
    setStatusPill('offline', '✗ NO SERVER');
  };
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  resize();
  buildBaseMap();
  loop();
  connectToServer();

  // Update splash hint
  const splashSub = document.getElementById('splash-sub');
  if(splashSub) splashSub.textContent = 'Make sure OpenClaw gateway is running.';
});
