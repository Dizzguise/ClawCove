// public/app.js — ClawCove canvas engine v2
// Every agent action, collaboration, tool call, and delegation is represented visually.
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// CANVAS + GLOBALS
// ═══════════════════════════════════════════════════════════════════════════════
const canvas   = document.getElementById('canvas');
const ctx      = canvas.getContext('2d');
const mmCanvas = document.getElementById('mmcanvas');
const mmCtx    = mmCanvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

let W = 0, H = 0;
const TILE = 16, MW = 80, MH = 56;
let camX = 0, camY = 0;
let simSpeed = 1;
let tick = 0;
let simTime = 9 * 60;

let WORLD     = null;
let BUILDINGS = [];
let AGENTS    = [];
let worldMode = 'connecting';

// Camera follow modes: 'follow' | 'action' | 'free'
let camMode       = 'follow';
let camTarget     = null;  // agent to follow in 'follow'/'action' mode
let lastActiveAt  = 0;     // tick of last agent activity (for action cam)

// ═══════════════════════════════════════════════════════════════════════════════
// MAP + PATHFINDING
// ═══════════════════════════════════════════════════════════════════════════════
const map = [];
for (let y = 0; y < MH; y++) { map.push([]); for (let x = 0; x < MW; x++) map[y].push(0); }

function st(x, y, v) { if (x>=0&&x<MW&&y>=0&&y<MH) map[y][x]=v; }
function fr(x, y, w, h, v) { for (let dy=0;dy<h;dy++) for (let dx=0;dx<w;dx++) st(x+dx,y+dy,v); }

function buildBaseMap() {
  fr(0,0,MW,3,2); fr(0,MH-3,MW,3,2); fr(0,0,3,MH,2); fr(MW-3,0,3,MH,2);
  fr(4,26,MW-8,4,1); fr(37,4,4,MH-8,1);
  fr(4,14,17,3,1);  fr(4,42,21,3,1);
  fr(58,14,18,3,1); fr(58,40,18,3,1);
  fr(14,4,3,26,1);  fr(57,4,3,26,1);
  fr(14,30,3,14,1); fr(57,30,3,14,1);
  fr(32,21,14,10,1);
  fr(68,34,8,18,2);
  fr(20,46,14,8,3); fr(46,4,12,9,3);
  for (let y=3;y<MH-3;y++) for (let x=3;x<MW-3;x++) {
    if (map[y][x]===0) {
      const h = Math.sin(x*0.47+y*0.73)*Math.cos(x*0.31-y*0.59);
      if (h>0.65 && (x+y)%4===0) st(x,y,5);
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
    fr(b.x,b.y,b.w,b.h,1);
    const doorX = Math.floor(b.x+b.w/2);
    st(doorX,b.y+b.h,1); st(doorX,b.y+b.h+1,1); st(doorX,b.y+b.h+2,1);
  });
}

function isWalkable(tx, ty) {
  if (tx<0||ty<0||tx>=MW||ty>=MH) return false;
  if (map[ty][tx]===2||map[ty][tx]===5) return false;
  for (const b of BUILDINGS) {
    if (b.decaying) continue;
    if (tx>=b.x&&tx<b.x+b.w&&ty>=b.y&&ty<b.y+b.h)
      return tx===Math.floor(b.x+b.w/2)&&ty===b.y+b.h-1;
  }
  return true;
}

function bfs(sx, sy, ex, ey) {
  if (sx===ex&&sy===ey) return [];
  const q=[[sx,sy]], vis={}, par={};
  vis[sx+','+sy]=true; par[sx+','+sy]=null;
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let lim=0;
  while (q.length&&lim++<3000) {
    const [cx,cy]=q.shift();
    if (cx===ex&&cy===ey) {
      const path=[]; let k=ex+','+ey;
      while(par[k]){path.unshift(k.split(',').map(Number));k=par[k];}
      return path;
    }
    for (const [dx,dy] of dirs) {
      const nx=cx+dx,ny=cy+dy,nk=nx+','+ny;
      if(!vis[nk]&&isWalkable(nx,ny)){vis[nk]=true;par[nk]=cx+','+cy;q.push([nx,ny]);}
    }
  }
  return [[ex,ey]];
}

function getBEntry(b) { return [Math.floor(b.x+b.w/2), b.y+b.h]; }

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL → BUILDING ROUTING
// Every tool call routes the agent to the building that represents that capability.
// ═══════════════════════════════════════════════════════════════════════════════
const TOOL_ROUTES = [
  [['browser','screenshot','navigate','click','scroll','web_search','fetch_url'], 'browser'],
  [['read_memory','write_memory','search_memory','memory','recall','store','remember'], 'db'],
  [['send_message','whatsapp','telegram','discord','slack','signal','send_channel'], 'channels'],
  [['schedule','cron','timer','add_cron'], 'cron'],
  [['execute_code','run_script','python','javascript','code','eval'], 'skills'],
  [['canvas','draw','image','render'], 'canvas'],
  [['voice','speak','tts','transcribe'], 'gateway'],
];

function toolToBuilding(toolName) {
  if (!toolName) return 'gateway';
  const t = toolName.toLowerCase();
  for (const [keys, bid] of TOOL_ROUTES) {
    if (keys.some(k => t.includes(k))) {
      // Return the building if it exists, else gateway
      return BUILDINGS.some(b => b.id === bid) ? bid : 'gateway';
    }
  }
  return 'gateway';
}

function toolLabel(toolName) {
  if (!toolName) return 'Processing…';
  const nice = {
    browser:'Browsing…', screenshot:'Taking screenshot…', navigate:'Navigating…',
    web_search:'Searching web…', read_memory:'Reading memory…', write_memory:'Storing memory…',
    send_message:'Sending message…', execute_code:'Running code…', canvas:'Drawing…',
    voice:'Speaking…', schedule:'Scheduling…', fetch_url:'Fetching URL…',
  };
  const t = toolName.toLowerCase();
  for (const [k,v] of Object.entries(nice)) { if (t.includes(k)) return v; }
  return toolName.slice(0,22)+'…';
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLLABORATION LINKS
// Glowing beams between agents when one delegates to / responds to another.
// ═══════════════════════════════════════════════════════════════════════════════
let COLLAB_LINKS = [];  // [{fromId, toId, label, color, ttl, maxTtl, phase}]

function addCollabLink(fromId, toId, label, color) {
  // Remove existing same-pair link
  COLLAB_LINKS = COLLAB_LINKS.filter(l => !(l.fromId===fromId&&l.toId===toId));
  COLLAB_LINKS.push({ fromId, toId, label, color: color||'#00e5ff',
    ttl: 300, maxTtl: 300, phase: Math.random()*Math.PI*2 });
}

function updateCollabLinks() {
  COLLAB_LINKS = COLLAB_LINKS.filter(l => {
    l.ttl -= simSpeed;
    return l.ttl > 0;
  });
}

function drawCollabLinks() {
  for (const link of COLLAB_LINKS) {
    const fa = AGENTS.find(a => a.id === link.fromId);
    const ta = AGENTS.find(a => a.id === link.toId);
    if (!fa || !ta) continue;
    const fx = fa.px - camX, fy = fa.py - camY;
    const tx = ta.px - camX, ty = ta.py - camY;
    const alpha = Math.min(1, link.ttl / 60) * (0.5 + Math.sin(tick*0.08+link.phase)*0.3);

    ctx.save();
    ctx.globalAlpha = alpha;

    // Glowing beam
    ctx.strokeStyle = link.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -tick * 0.8;
    ctx.beginPath(); ctx.moveTo(fx,fy); ctx.lineTo(tx,ty); ctx.stroke();

    // Outer glow
    ctx.globalAlpha = alpha * 0.2;
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(fx,fy); ctx.lineTo(tx,ty); ctx.stroke();

    ctx.setLineDash([]);
    ctx.globalAlpha = alpha;

    // Arrow head at target
    const dx=tx-fx, dy=ty-fy, len=Math.sqrt(dx*dx+dy*dy);
    if (len > 20) {
      const ux=dx/len, uy=dy/len;
      const ax=tx-ux*12, ay=ty-uy*12;
      ctx.fillStyle = link.color;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ax - uy*5, ay + ux*5);
      ctx.lineTo(ax + uy*5, ay - ux*5);
      ctx.closePath(); ctx.fill();
    }

    // Label at midpoint
    if (link.label) {
      const mx=(fx+tx)/2, my=(fy+ty)/2;
      ctx.fillStyle='rgba(0,5,20,0.8)'; ctx.fillRect(mx-36,my-9,72,14);
      ctx.fillStyle=link.color; ctx.font='6px "Press Start 2P",monospace';
      ctx.textAlign='center'; ctx.fillText(link.label.slice(0,14), mx, my+1);
    }
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEETING SYSTEM
// When manager delegates, agents walk to a midpoint, exchange glow, then proceed.
// ═══════════════════════════════════════════════════════════════════════════════
let MEETINGS = [];  // [{agentAId, agentBId, topic, timer, maxTimer, midX, midY}]

function startMeeting(agentAId, agentBId, topic) {
  const a = AGENTS.find(x => x.id === agentAId);
  const b = AGENTS.find(x => x.id === agentBId);
  if (!a || !b) return;
  const midX = (a.px + b.px) / 2;
  const midY = (a.py + b.py) / 2;
  MEETINGS.push({ agentAId, agentBId, topic, timer: 180, maxTimer: 180, midX, midY });
  a.meetingWith = agentBId; a.meetingTimer = 180; a.state = 'meeting';
  b.meetingWith = agentAId; b.meetingTimer = 180; b.state = 'meeting';
  addCollabLink(agentAId, agentBId, topic, a.color);
  agentSpeak(a, `Delegating: ${topic}`, 140);
  agentSpeak(b, 'Received task!', 120);
  cityEvent('📋', `${a.name} → ${b.name}: ${topic}`, a.color);
  // Log to chat system
  if (typeof logAgentConvo === 'function') {
    logAgentConvo(agentAId, agentBId, `Delegating: ${topic}`, 'delegation');
    logAgentConvo(agentBId, agentAId, 'Received task!', 'delegation');
  }
}

function updateMeetings() {
  MEETINGS = MEETINGS.filter(m => {
    m.timer -= simSpeed;
    return m.timer > 0;
  });
}

function drawMeetings() {
  for (const m of MEETINGS) {
    const mx = m.midX - camX, my = m.midY - camY;
    const alpha = Math.min(1, m.timer / 30);
    const pulse = Math.sin(tick * 0.15) * 0.5 + 0.5;
    ctx.save();
    ctx.globalAlpha = alpha * (0.3 + pulse * 0.4);
    ctx.fillStyle = '#ffd060';
    ctx.beginPath(); ctx.arc(mx, my, 10 + pulse*6, 0, Math.PI*2); ctx.fill();
    if (m.topic) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(0,4,16,0.85)'; ctx.fillRect(mx-50,my-20,100,14);
      ctx.fillStyle = '#ffd060'; ctx.font = '6px "Press Start 2P",monospace';
      ctx.textAlign = 'center'; ctx.fillText(m.topic.slice(0,16), mx, my-9);
    }
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// THOUGHT STREAM / PINNED AGENT
// Click an agent to pin them — their thought log floats beside them.
// ═══════════════════════════════════════════════════════════════════════════════
let pinnedAgent = null;

function drawPinnedThoughts() {
  if (!pinnedAgent) return;
  const a = AGENTS.find(x => x.id === pinnedAgent);
  if (!a || !a.thoughtLines?.length) return;
  const sx = a.px - camX + 20, sy = a.py - camY - 60;
  const lines = a.thoughtLines.slice(0, 6);
  const panW = 180, lineH = 14, padV = 8;
  const panH = lines.length * lineH + padV * 2;
  const px = Math.max(4, Math.min(W - panW - 4, sx));
  const py = Math.max(54, Math.min(H - panH - 4, sy));

  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = 'rgba(0,4,16,0.95)';
  ctx.fillRect(px, py, panW, panH);
  ctx.strokeStyle = a.color; ctx.lineWidth = 1;
  ctx.strokeRect(px, py, panW, panH);
  ctx.fillStyle = a.color; ctx.font = '6px "Press Start 2P",monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`◈ ${a.name.toUpperCase()} THOUGHTS`, px+5, py+10);
  lines.forEach((ln, i) => {
    const age = Math.min(1, (Date.now() - ln.ts) / 30000);
    ctx.globalAlpha = 0.92 * (1 - age * 0.6);
    ctx.fillStyle = '#7ef7ff';
    ctx.font = '5px monospace';
    const text = ln.text.length > 28 ? ln.text.slice(0,26)+'…' : ln.text;
    ctx.fillText(`▸ ${text}`, px+5, py + padV + 12 + i * lineH);
  });
  // Unpin hint
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#0a4060';
  ctx.font = '5px monospace';
  ctx.fillText('[click to unpin]', px+5, py+panH-3);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVITY RINGS
// Orbiting dots around a working agent showing tool-call depth.
// ═══════════════════════════════════════════════════════════════════════════════
function drawActivityRing(a) {
  const depth = Math.min(a.activityDepth || 1, 6);
  const sx = a.px - camX, sy = a.py - camY;
  ctx.save();
  for (let i = 0; i < depth; i++) {
    const angle = (tick * 0.06 + i * (Math.PI*2/depth));
    const r = 18 + i * 3;
    const ox = Math.cos(angle) * r;
    const oy = Math.sin(angle) * r * 0.5; // elliptical
    const alpha = 0.5 + Math.sin(tick*0.1 + i) * 0.3;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = a.color;
    ctx.beginPath(); ctx.arc(sx+ox, sy-8+oy, 2.5, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = alpha * 0.3;
    ctx.fillStyle = a.color;
    ctx.beginPath(); ctx.arc(sx+ox, sy-8+oy, 5, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT INIT + STATE
// ═══════════════════════════════════════════════════════════════════════════════
function initAgentsFromWorld(worldAgents) {
  return worldAgents.map(a => {
    const h = a.colorHue ?? 180;
    return {
      ...a,
      px: a.startX * TILE, py: a.startY * TILE,
      colorDark:  `hsl(${h},60%,10%)`,
      colorLight: `hsl(${h},60%,70%)`,
      antennae:   `hsl(${h},80%,55%)`,
      path: [], state: 'idle', stateTimer: 0,
      currentBuilding: null,
      facing: 'down', walkFrame: 0, walkTick: 0,
      speechLines: [],      // [{text, timer}] — multiple per agent
      tailWave: 0,
      activeJob: null,
      glowing: false,
      activityDepth: 0,
      thoughtLines: [],     // [{ts, text}]
      meetingWith: null, meetingTimer: 0,
      lastToolName: null,
      runId: null,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-AGENT SPEECH
// Multiple agents can have speech lines simultaneously.
// ═══════════════════════════════════════════════════════════════════════════════
function agentSpeak(agent, text, duration=160) {
  if (!agent || !text) return;
  // Don't double-post the same line
  if (agent.speechLines.some(s => s.text === text)) return;
  agent.speechLines.push({ text, timer: duration });
  if (agent.speechLines.length > 3) agent.speechLines.shift();
  // Log to thought stream
  if (!agent.thoughtLines) agent.thoughtLines = [];
  agent.thoughtLines.unshift({ ts: Date.now(), text });
  if (agent.thoughtLines.length > 30) agent.thoughtLines.pop();
  // Mirror to chat agent log (skip short/repeat lines)
  if (typeof logAgentConvo === 'function' && text.length > 4 && !text.startsWith('Done') && !text.startsWith('Goodbye')) {
    const isManager = agent.hierarchyRole === 'manager';
    if (isManager && typeof logManagerSpeech === 'function') {
      // Manager speech goes to manager tab
      logManagerSpeech(text, 'agent');
    } else {
      // Other agent speech goes to agent log as self-monologue
      logAgentConvo(agent.id, null, text, 'speech');
    }
  }
}

// Draw ALL speech bubbles for all agents
function drawAllSpeech() {
  for (const a of AGENTS) {
    if (!a.speechLines?.length) continue;
    const activeLi = a.speechLines.filter(s => s.timer > 0);
    if (!activeLi.length) continue;
    const sx = a.px - camX, sy = a.py - camY;
    const bx = Math.max(4, Math.min(W-160, sx-70)), by = Math.max(54, sy-44-activeLi.length*14);
    ctx.save();
    const alpha = Math.min(1, activeLi[activeLi.length-1].timer / 30);
    ctx.globalAlpha = alpha;
    const panH = activeLi.length * 14 + 10;
    ctx.fillStyle = 'rgba(0,4,16,0.92)';
    ctx.fillRect(bx, by, 140, panH);
    ctx.strokeStyle = a.color; ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, 140, panH);
    // Tail triangle
    ctx.fillStyle = 'rgba(0,4,16,0.92)';
    ctx.beginPath(); ctx.moveTo(sx-4, sy-28); ctx.lineTo(sx+4, sy-28); ctx.lineTo(sx, sy-18); ctx.fill();
    ctx.strokeStyle = a.color; ctx.beginPath(); ctx.moveTo(sx-4, sy-28); ctx.lineTo(sx, sy-18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+4, sy-28); ctx.lineTo(sx, sy-18); ctx.stroke();
    activeLi.forEach((ln, i) => {
      ctx.fillStyle = i === activeLi.length-1 ? a.color : '#4a8aaa';
      ctx.font = '6px "Press Start 2P",monospace';
      ctx.textAlign = 'left';
      const txt = ln.text.length>18 ? ln.text.slice(0,17)+'…' : ln.text;
      ctx.fillText(txt, bx+5, by+12+i*14);
    });
    ctx.restore();
  }
}

function updateSpeechLines() {
  for (const a of AGENTS) {
    if (!a.speechLines) { a.speechLines = []; continue; }
    a.speechLines = a.speechLines.filter(s => { s.timer -= simSpeed; return s.timer > 0; });
  }
}

// ── Random chatter ─────────────────────────────────────────────────────────────
let chatCooldown = 0;
function maybeChatter() {
  if (!AGENTS.length) return;
  chatCooldown--;
  if (chatCooldown > 0 || Math.random() > 0.005) return;
  chatCooldown = 350 + Math.random() * 200;
  const a = AGENTS[Math.floor(Math.random()*AGENTS.length)];
  const lines = {
    idle:    ['Hmm, what next?','Thinking…','All clear.','Ready for tasks.'],
    working: ['Processing!','Running tool…','Almost done!','Crunching data…'],
    walking: ['On my way!','Heading over!','Swimming through…'],
    meeting: ['Got it, boss.','Understood.','On it!'],
  };
  const pool = lines[a.state] ?? lines.idle;
  agentSpeak(a, pool[Math.floor(Math.random()*pool.length)], 120);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT UPDATE
// ═══════════════════════════════════════════════════════════════════════════════
function updateAgent(a) {
  a.stateTimer++;
  a.tailWave += 0.12 * simSpeed;

  // Meeting state: freeze movement, wait for timer
  if (a.meetingWith && a.meetingTimer > 0) {
    a.meetingTimer -= simSpeed;
    a.state = 'meeting';
    if (a.meetingTimer <= 0) {
      a.meetingWith = null;
      a.state = 'idle';
      a.stateTimer = 0;
    }
    return;
  }

  // Active job: route to the right building based on tool
  if (a.activeJob && a.state !== 'working') {
    const bid = a.activeJob.buildingId ?? toolToBuilding(a.activeJob.tool ?? '');
    const target = BUILDINGS.find(b => b.id === bid) ?? BUILDINGS.find(b => b.id === 'gateway');
    if (target) {
      const [ex, ey] = getBEntry(target);
      const ax = Math.round(a.px/TILE), ay = Math.round(a.py/TILE);
      if (Math.abs(ax-ex)+Math.abs(ay-ey) > 2) {
        if (!a.path.length) { a.path = bfs(ax,ay,ex,ey); a.state = 'walking'; }
      } else {
        a.state = 'working';
        a.currentBuilding = target;
        a.stateTimer = 0;
        agentSpeak(a, a.activeJob.label ?? toolLabel(a.activeJob.tool), 140);
        lastActiveAt = tick;
        if (camMode === 'action') camTarget = a;
      }
    }
  }

  // Idle → wander home
  if (a.state === 'idle' && a.stateTimer > 280/simSpeed && !a.activeJob) {
    const home = BUILDINGS.find(b => b.id === a.homeBuilding);
    if (home) {
      const [ex, ey] = getBEntry(home);
      const ax = Math.round(a.px/TILE), ay = Math.round(a.py/TILE);
      if (Math.abs(ax-ex)+Math.abs(ay-ey) > 3) {
        a.path = bfs(ax,ay,ex,ey); a.state = 'walking'; a.stateTimer = 0;
      }
    }
  }

  // Walk path
  if (a.path.length > 0 && a.state !== 'meeting') {
    const [tx,ty] = a.path[0];
    const tpx=tx*TILE, tpy=ty*TILE;
    const ddx=tpx-a.px, ddy=tpy-a.py;
    const dist=Math.sqrt(ddx*ddx+ddy*ddy);
    const spd=1.1*simSpeed;
    if (dist < spd+0.5) {
      a.px=tpx; a.py=tpy; a.path.shift();
      if (!a.path.length) { a.state = a.activeJob ? 'working' : 'idle'; }
    } else {
      a.px+=ddx/dist*spd; a.py+=ddy/dist*spd;
      a.facing = Math.abs(ddx)>Math.abs(ddy) ? (ddx>0?'right':'left') : (ddy>0?'down':'up');
      a.walkTick++;
      if (a.walkTick%8===0) a.walkFrame=(a.walkFrame+1)%4;
    }
  }

  // Working timeout → gracefully return home
  if (a.state==='working' && a.stateTimer>320/simSpeed && a.activeJob) {
    agentSpeak(a, 'Done!', 80);
    finishAgentJob(a);
  }
}

function finishAgentJob(a) {
  a.activeJob = null; a.glowing = false; a.activityDepth = 0;
  a.state = 'idle'; a.currentBuilding = null; a.stateTimer = 0;
  const home = BUILDINGS.find(b => b.id === a.homeBuilding);
  if (home) {
    const [ex,ey]=getBEntry(home);
    const ax=Math.round(a.px/TILE), ay=Math.round(a.py/TILE);
    a.path=bfs(ax,ay,ex,ey); a.state='walking';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CITY BULLETIN FEED
// Narrative-layer: "Molty delegated to Wally" not "[cron:add]"
// ═══════════════════════════════════════════════════════════════════════════════
let CITY_EVENTS = [];    // [{ts, icon, who, what, color}]
let bulletinOpen = false;

function cityEvent(icon, what, color, who) {
  CITY_EVENTS.unshift({ ts: Date.now(), icon, what, color: color||'#7ef7ff', who: who||'' });
  if (CITY_EVENTS.length > 60) CITY_EVENTS.pop();
  renderBulletin();
}

function renderBulletin() {
  const rows = document.getElementById('bulletin-rows');
  if (!rows) return;
  rows.innerHTML = CITY_EVENTS.slice(0, 40).map((e,i) => {
    const ago = relTime(e.ts);
    return `<div class="bul-row${i===0?' bul-new':''}">
      <span class="bul-icon">${e.icon}</span>
      <span class="bul-text" style="color:${e.color}">${esc(e.what)}</span>
      <span class="bul-time">${ago}</span>
    </div>`;
  }).join('');
}

// Keep timestamps fresh
setInterval(() => { if (bulletinOpen || CITY_EVENTS.length) renderBulletin(); }, 15000);

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT LOG (technical, existing)
// ═══════════════════════════════════════════════════════════════════════════════
let logEntries = [];
function addLog(text, type='new') {
  logEntries.unshift({ text: text.slice(0,44), type });
  if (logEntries.length > 12) logEntries.pop();
  const el = document.getElementById('log-entries');
  if (!el) return;
  el.innerHTML = logEntries.map((e,i) =>
    `<div class="log-entry${i===0?' new':''} ${e.type}">${
      e.type==='warn'?'⚠ ':e.type==='live'?'◈ ':e.type==='cron'?'⏰ ':'▸ '
    }${e.text}</div>`
  ).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATEWAY EVENT HANDLER
// This is the most important function — every gateway event produces a
// visible effect in the world.
// ═══════════════════════════════════════════════════════════════════════════════
function handleGatewayEvent(event) {
  const e = event.event, p = event.payload;

  if (e === 'agent') {
    const status  = p?.status;
    const agentId = p?.agentId ?? p?.agent ?? 'main';
    const runId   = p?.runId;
    const tool    = p?.tool ?? p?.toolName ?? null;
    const agent   = AGENTS.find(a => a.id === agentId)
                 ?? AGENTS.find(a => a.id === 'main');

    if (!agent) return;

    if (status === 'started') {
      agent.runId = runId;
      agent.activityDepth = 0;
      agent.glowing = true;
      agent.activeJob = { buildingId: toolToBuilding(tool), tool, label: toolLabel(tool) };
      agentSpeak(agent, toolLabel(tool), 180);
      addLog(`${agent.name}: started run`, 'live');
      cityEvent('⚡', `${agent.name} started ${tool||'a run'}`, agent.color);
      lastActiveAt = tick;
      if (camMode === 'action') camTarget = agent;
    }

    if (status === 'tool_start' || status === 'running') {
      agent.activityDepth = (agent.activityDepth||0) + 1;
      if (tool) {
        agent.lastToolName = tool;
        const bid = toolToBuilding(tool);
        agent.activeJob = { buildingId: bid, tool, label: toolLabel(tool) };
        if (agent.state === 'working' && agent.currentBuilding?.id !== bid) {
          // Tool changed → walk to new building
          agent.state = 'idle'; agent.path = [];
        }
        agentSpeak(agent, toolLabel(tool), 150);
        addLog(`${agent.name}: ${tool}`, 'live');
        cityEvent('🔧', `${agent.name} → ${tool}`, agent.color);
      }
      lastActiveAt = tick;
    }

    if (status === 'tool_end') {
      agent.activityDepth = Math.max(0, (agent.activityDepth||1) - 1);
    }

    if (status === 'ok' || status === 'complete') {
      agentSpeak(agent, 'Done! ✓', 100);
      addLog(`${agent.name}: run complete ✓`, 'new');
      cityEvent('✅', `${agent.name} finished run`, agent.color);
      setTimeout(() => finishAgentJob(agent), 1500);
    }

    if (status === 'error') {
      agentSpeak(agent, 'Error! ✗', 120);
      addLog(`${agent.name}: run error`, 'warn');
      cityEvent('❌', `${agent.name} hit an error`, '#ff5555');
      setTimeout(() => finishAgentJob(agent), 2000);
    }

    // Detect delegation: if the gateway signals a sub-agent was called
    if (p?.calledBy || p?.parentAgent) {
      const managerId = p.calledBy ?? p.parentAgent;
      addCollabLink(managerId, agentId, tool || 'task', '#ffd060');
      cityEvent('📋', `${managerId} → ${agent.name}: delegated`, '#ffd060');
      startMeeting(managerId, agentId, (tool||'task').slice(0,12));
    }
  }

  if (e === 'cron') {
    const jobId = p?.jobId ?? '—';
    const job   = p?.label ?? jobId;
    // Find cleo or the first available agent
    const cleo  = AGENTS.find(a => a.id==='cleo') ?? AGENTS[0];
    const cronB = BUILDINGS.find(b => b.id==='cron');
    if (cleo) {
      cleo.activeJob = { buildingId:'cron', tool:'schedule', label:`Cron: ${job}` };
      cleo.glowing = true;
      agentSpeak(cleo, `⏰ ${job}!`, 180);
    }
    addLog(`Cron: ${job}`, 'cron');
    cityEvent('⏰', `Cron fired: ${job}`, '#ffd060');
    if (cronB) cronB.cronFlash = tick; // trigger building flash
  }

  if (e === 'chat') {
    const ch = p?.channel ?? p?.from ?? 'channel';
    const text = p?.text ? p.text.slice(0,30) : null;
    // Route to channels building
    const channelB = BUILDINGS.find(b => b.id==='channels');
    // Pick nearest idle agent to "receive" the message
    const receiver = AGENTS.find(a=>a.id==='main') ?? AGENTS[0];
    if (receiver) {
      receiver.activeJob = { buildingId:'channels', tool:'send_message', label:`${ch}: msg in` };
      agentSpeak(receiver, `📡 ${ch}${text?' : '+text.slice(0,14):''}`, 160);
    }
    addLog(`Chat [${ch}]: ${text||'message'}`, 'live');
    cityEvent('💬', `${ch}: ${text||'new message'}`, '#00e5ff');
  }

  if (e === 'presence') {
    const mode = p?.mode ?? p?.status ?? 'update';
    const name = p?.agentId ?? p?.displayName ?? 'system';
    cityEvent('◈', `Presence: ${name} → ${mode}`, '#7ef7ff');
    addLog(`Presence: ${name} ${mode}`, 'new');
  }

  if (e === 'health') {
    const status = p?.status ?? 'ok';
    const spire = BUILDINGS.find(b => b.id==='gateway');
    if (spire) {
      spire.details.status = status;
      spire.accent = status==='ok'?'#00e5ff':status==='warn'?'#ffd060':'#ff5555';
    }
    if (status !== 'ok') {
      cityEvent('💊', `Gateway health: ${status}`, status==='warn'?'#ffd060':'#ff5555');
      addLog(`Health: ${status}`, 'warn');
    }
  }

  if (e === 'session') {
    const sk = p?.sessionKey ?? '—';
    const act = p?.action ?? 'update';
    if (act === 'created') {
      cityEvent('🌱', `Session started: ${sk.slice(-12)}`, '#00ff88');
    } else if (act === 'ended') {
      cityEvent('🍂', `Session ended: ${sk.slice(-12)}`, '#ffa060');
    }
  }

  if (e === 'clawcove.disconnected') {
    setStatusPill('offline', 'DISCONNECTED');
    addLog('Gateway disconnected', 'warn');
    cityEvent('🔌', 'Gateway disconnected', '#ff5555');
  }

  if (e === 'clawcove.reconnected') {
    cityEvent('🔌', 'Gateway reconnected', '#00ff88');
  }
}

function handleAgentActivity(msg) {
  // Normalise and re-route through main handler
  handleGatewayEvent({ event: 'agent', payload: {
    agentId: msg.agentId ?? 'main',
    status:  msg.status,
    tool:    msg.tool,
    runId:   msg.runId,
  }});
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS PILL
// ═══════════════════════════════════════════════════════════════════════════════
function setStatusPill(cls, text) {
  const el = document.getElementById('status-pill');
  if (el) { el.className = `status-pill ${cls}`; el.textContent = text; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TILE RENDERING
// ═══════════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════════
// BUILDING RENDERING
// ═══════════════════════════════════════════════════════════════════════════════
function drawBuilding(b) {
  const sx=b.x*TILE-camX, sy=b.y*TILE-camY, bw=b.w*TILE, bh=b.h*TILE;
  if(sx>W+20||sx+bw<-20||sy>H+20||sy+bh<-20) return;

  const isActive = AGENTS.some(a=>a.currentBuilding?.id===b.id&&a.state==='working');
  const gp = Math.sin(tick*0.06)*0.5+0.5;
  const decay = b.decaying ? Math.max(0,1-(Date.now()-b.decayStart)/8000) : 1;

  // Cron flash
  const cronFlash = b.cronFlash && (tick - b.cronFlash) < 40;

  ctx.save();
  if (b.decaying) ctx.globalAlpha = decay * 0.5;

  // Shadow
  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(sx+5,sy+5,bw,bh);

  // Body
  ctx.fillStyle = b.roof||'#021020'; ctx.fillRect(sx,sy,bw,bh);
  ctx.fillStyle = b.wall||'#041428'; ctx.fillRect(sx+1,sy+1,bw-2,bh-2);
  ctx.fillStyle = b.roof||'#021020'; ctx.fillRect(sx,sy,bw,TILE*2);
  ctx.fillStyle = b.accent||'#00e5ff'; ctx.fillRect(sx+2,sy+1,bw-4,2);

  // Active glow
  if (isActive || cronFlash) {
    const ga = Math.round(cronFlash ? 60 : (20+gp*35)).toString(16).padStart(2,'0');
    ctx.fillStyle = (cronFlash?'#ffd060':b.accent||'#00e5ff')+ga;
    ctx.fillRect(sx+1,sy+1,bw-2,bh-2);
  }

  // Windows
  for (let row=2;row<b.h-1;row++) {
    for (let col=0;col<b.w;col++) {
      const wx=sx+col*TILE+2, wy=sy+row*TILE+3;
      const isDoor = col===Math.floor(b.w/2)&&row===b.h-2;
      if (isDoor) {
        ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(wx+1,wy-1,TILE-6,TILE-2);
        ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(wx+2,wy-3,TILE-8,4);
      } else if (col%2===0) {
        const glowing = isActive&&Math.sin(tick*0.1+col*1.3+row*0.7)>0.3;
        ctx.fillStyle='#020c18'; ctx.fillRect(wx+1,wy,8,7);
        ctx.fillStyle=glowing?(b.accent||'#00e5ff'):'rgba(0,50,90,0.5)'; ctx.fillRect(wx+2,wy+1,6,5);
        ctx.fillStyle=(b.accent||'#00e5ff')+'55';
        ctx.fillRect(wx+1,wy,8,1); ctx.fillRect(wx+1,wy+6,8,1);
        ctx.fillRect(wx+1,wy,1,7); ctx.fillRect(wx+8,wy,1,7);
      }
    }
  }

  // Trim
  ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(sx,sy+bh-2,bw,2);
  ctx.fillStyle=(b.accent||'#00e5ff')+'66';
  ctx.fillRect(sx,sy+TILE*2,2,bh-TILE*2-2); ctx.fillRect(sx+bw-2,sy+TILE*2,2,bh-TILE*2-2);

  // Tower spike for gateway / cron
  if (b.shape==='tower') {
    const anH=b.kind==='gateway'?20:10;
    ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(sx+bw/2-1,sy-anH,2,anH);
    const orbR=b.kind==='gateway'?5:3;
    ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(sx+bw/2-orbR,sy-anH-orbR*2,orbR*2,orbR*2);
    const ga2=Math.round(50+gp*100).toString(16).padStart(2,'0');
    ctx.fillStyle=(b.accent||'#00e5ff')+ga2; ctx.fillRect(sx+bw/2-orbR-2,sy-anH-orbR*2-2,orbR*2+4,orbR*2+4);
  }

  // Coral decorations
  ctx.fillStyle='#ff4a6a'; ctx.fillRect(sx+2,sy-4,3,5); ctx.fillRect(sx+bw-5,sy-4,3,5);
  ctx.fillStyle='#00ffaa'; ctx.fillRect(sx+3,sy-5,1,2); ctx.fillRect(sx+bw-4,sy-5,1,2);

  // Label
  ctx.fillStyle='rgba(0,0,10,0.88)'; ctx.fillRect(sx+1,sy-15,bw-2,12);
  ctx.fillStyle=b.accent||'#00e5ff'; ctx.font='bold 6px "Press Start 2P",monospace';
  ctx.textAlign='center';
  ctx.fillText(b.label||b.name||b.id, sx+bw/2, sy-6, bw-6);

  // Activity dot
  if (isActive) { ctx.fillStyle=b.accent||'#00e5ff'; ctx.fillRect(sx+bw-8,sy+2,5,5); }

  // Hierarchy marker (crown for manager building)
  if (b.marker === 'crown') {
    ctx.fillStyle='#ffd060'; ctx.font='10px serif'; ctx.textAlign='center';
    ctx.fillText('♛', sx+bw/2, sy-18);
  } else if (b.marker === 'tools') {
    ctx.fillStyle='#00ff88'; ctx.font='9px serif'; ctx.textAlign='center';
    ctx.fillText('⚙', sx+bw/2, sy-18);
  }

  ctx.restore();
  if (b.decaying && decay<=0) BUILDINGS = BUILDINGS.filter(bb=>bb!==b);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT (LOBSTER) RENDERING
// ═══════════════════════════════════════════════════════════════════════════════
function drawAgent(a) {
  const sx=a.px-camX, sy=a.py-camY;
  if(sx<-40||sx>W+40||sy<-40||sy>H+40) return;

  const C1=a.color||'#ff6b35', C2=a.colorDark||'#6a1500', CL=a.colorLight||'#ff9a60';
  const isW=a.state==='walking', isWk=a.state==='working', isMt=a.state==='meeting';
  const bob=isW?Math.sin(a.walkFrame*Math.PI*0.5)*2:0;
  const wkb=isWk?Math.sin(tick*0.12+a.px*0.01)*1:0;
  const mtb=isMt?Math.sin(tick*0.2)*2:0;
  const bx=Math.round(sx-7), by=Math.round(sy-14+bob+wkb+mtb);

  // Activity rings (working + depth > 0)
  if ((isWk||a.glowing) && a.activityDepth > 0) drawActivityRing(a);

  // Glow halo
  if (a.glowing||isWk||isMt) {
    ctx.save();
    ctx.globalAlpha=0.25+Math.sin(tick*0.1)*0.15;
    ctx.fillStyle=C1; ctx.beginPath(); ctx.arc(sx,sy-5,14,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Shadow
  ctx.fillStyle='rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(sx,sy+2,7,3,0,0,Math.PI*2); ctx.fill();

  // Tail
  const tw=Math.round(Math.sin(a.tailWave)*2);
  ctx.fillStyle=C2; ctx.fillRect(bx+1,by+14,12,5);
  ctx.fillStyle=C1; ctx.fillRect(bx+2,by+14,4,4); ctx.fillRect(bx+6,by+14,4,4);
  ctx.fillRect(bx+1+tw,by+16,3,3); ctx.fillRect(bx+10-tw,by+16,3,3);

  // Abdomen
  ctx.fillStyle=C2; ctx.fillRect(bx+2,by+7,10,8);
  ctx.fillStyle=C1; ctx.fillRect(bx+3,by+8,8,6);
  ctx.fillStyle=C2; ctx.fillRect(bx+3,by+10,8,1); ctx.fillRect(bx+3,by+12,8,1);

  // Carapace
  ctx.fillStyle=C2; ctx.fillRect(bx+1,by+2,12,8);
  ctx.fillStyle=C1; ctx.fillRect(bx+2,by+3,10,6);
  ctx.fillStyle=CL; ctx.fillRect(bx+3,by+3,4,3);

  // Head
  ctx.fillStyle=C2; ctx.fillRect(bx+2,by-1,10,5);
  ctx.fillStyle=C1; ctx.fillRect(bx+3,by,8,4);

  // Eyes
  ctx.fillStyle=C2; ctx.fillRect(bx+2,by-2,2,3); ctx.fillRect(bx+10,by-2,2,3);
  ctx.fillStyle='#ffffff'; ctx.fillRect(bx+2,by-2,2,2); ctx.fillRect(bx+10,by-2,2,2);
  ctx.fillStyle='#000000'; ctx.fillRect(bx+2,by-2,1,1); ctx.fillRect(bx+11,by-2,1,1);

  // Antennae
  const antW=Math.round(Math.sin(tick*0.07+a.px*0.03)*(isWk?3:2));
  ctx.fillStyle=a.antennae||C1;
  ctx.fillRect(bx+2,by-5+Math.round(antW*0.5),1,4); ctx.fillRect(bx+1,by-8+antW,1,4);
  ctx.fillRect(bx+11,by-5+Math.round(-antW*0.5),1,4); ctx.fillRect(bx+12,by-8-antW,1,4);
  ctx.fillRect(bx+4,by-3,1,3); ctx.fillRect(bx+9,by-3,1,3);

  // Claws (animated when working)
  const ca=isWk?Math.round(Math.sin(tick*0.15)*3):0;
  ctx.fillStyle=C2; ctx.fillRect(bx-3,by+3+ca,5,5);
  ctx.fillStyle=C1; ctx.fillRect(bx-2,by+4+ca,4,4); ctx.fillStyle=CL; ctx.fillRect(bx-2,by+4+ca,2,2);
  if(isWk){ctx.fillStyle='#020c18';ctx.fillRect(bx-1,by+6+ca,2,2);}
  ctx.fillStyle=C2; ctx.fillRect(bx+12,by+3-ca,5,5);
  ctx.fillStyle=C1; ctx.fillRect(bx+12,by+4-ca,4,4); ctx.fillStyle=CL; ctx.fillRect(bx+14,by+4-ca,2,2);
  if(isWk){ctx.fillStyle='#020c18';ctx.fillRect(bx+13,by+6-ca,2,2);}

  // Legs
  const lo=isW?(a.walkFrame%2)*2:0;
  ctx.fillStyle=C2;
  for(let li=0;li<3;li++){
    ctx.fillRect(bx+3+li*3,by+9,1,4+Math.round(li%2===0?lo:-lo));
    ctx.fillRect(bx+11-li*3,by+9,1,4+Math.round(li%2===0?-lo:lo));
  }

  // Meeting pulse ring
  if (isMt) {
    ctx.save();
    ctx.globalAlpha = 0.6 + Math.sin(tick*0.2)*0.3;
    ctx.strokeStyle = '#ffd060'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy-5, 18+Math.sin(tick*0.15)*4, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
  }

  // Name tag
  ctx.fillStyle='rgba(0,0,0,0.72)'; ctx.fillRect(sx-30,by-22,60,13);
  ctx.fillStyle = a.id === pinnedAgent ? '#ffd060' : (a.color||'#ff6b35');
  ctx.font='8px "Press Start 2P",monospace'; ctx.textAlign='center';
  ctx.fillText(a.name||a.id, sx, by-11, 56);

  // State icon above name for active agents
  if (isWk) {
    ctx.fillStyle='#00ff88'; ctx.font='8px serif'; ctx.fillText('⚙', sx+22, by-11);
  } else if (isMt) {
    ctx.fillStyle='#ffd060'; ctx.font='8px serif'; ctx.fillText('🤝', sx+22, by-11);
  } else if (a.glowing) {
    ctx.fillStyle='#00e5ff'; ctx.font='7px serif'; ctx.fillText('●', sx+22, by-11);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUBBLES + CAUSTICS
// ═══════════════════════════════════════════════════════════════════════════════
const BUBBLES = Array.from({length:50},()=>({
  x:Math.random()*MW*TILE, y:Math.random()*MH*TILE,
  r:0.8+Math.random()*3, speed:0.25+Math.random()*0.45, phase:Math.random()*Math.PI*2
}));

function drawBubbles() {
  for(const b of BUBBLES){
    b.y-=b.speed*simSpeed; b.x+=Math.sin(tick*0.02+b.phase)*0.25;
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

// ═══════════════════════════════════════════════════════════════════════════════
// CAMERA
// Three modes: follow (tracks first agent), action (tracks most recently active),
// free (manual drag).
// ═══════════════════════════════════════════════════════════════════════════════
function updateCamera() {
  if (!AGENTS.length || camMode === 'free') return;

  let target;
  if (camMode === 'action') {
    // Follow the most recently active agent
    target = camTarget ?? AGENTS.find(a=>a.state==='working')
          ?? AGENTS.find(a=>a.state==='meeting')
          ?? AGENTS[0];
  } else {
    target = AGENTS.find(a=>a.hierarchyRole==='manager') ?? AGENTS[0];
  }

  if (!target) return;
  camX += (target.px - W/2 - camX) * 0.05;
  camY += (target.py - H/2 - camY) * 0.05;
  camX = Math.max(0, Math.min(MW*TILE-W, camX));
  camY = Math.max(0, Math.min(MH*TILE-H, camY));
}

function setCamMode(mode) {
  camMode = mode;
  if (mode !== 'action') camTarget = null;
  document.querySelectorAll('.cambtn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('cam-'+mode);
  if (btn) btn.classList.add('active');
}
window.setCamMode = setCamMode;

// ═══════════════════════════════════════════════════════════════════════════════
// MINIMAP
// ═══════════════════════════════════════════════════════════════════════════════
function drawMinimap() {
  const mmW=120, mmH=84, scx=mmW/MW, scy=mmH/MH;
  mmCtx.fillStyle='#020c18'; mmCtx.fillRect(0,0,mmW,mmH);
  BUILDINGS.forEach(b=>{
    if(b.decaying) return;
    const isAct = AGENTS.some(a=>a.currentBuilding?.id===b.id);
    mmCtx.fillStyle = isAct ? b.accent||'#00e5ff' : (b.accent||'#00e5ff')+'55';
    mmCtx.fillRect(b.x*scx,b.y*scy,Math.max(2,b.w*scx),Math.max(2,b.h*scy));
  });
  // Collab links on minimap
  for (const link of COLLAB_LINKS) {
    const fa=AGENTS.find(a=>a.id===link.fromId), ta=AGENTS.find(a=>a.id===link.toId);
    if(!fa||!ta) continue;
    mmCtx.strokeStyle=link.color+'88'; mmCtx.lineWidth=1;
    mmCtx.beginPath(); mmCtx.moveTo((fa.px/TILE)*scx,(fa.py/TILE)*scy);
    mmCtx.lineTo((ta.px/TILE)*scx,(ta.py/TILE)*scy); mmCtx.stroke();
  }
  AGENTS.forEach(a=>{
    mmCtx.fillStyle = a.state==='working'||a.glowing ? a.color : a.color+'99';
    const ax=(a.px/TILE)*scx, ay=(a.py/TILE)*scy;
    if (a.state==='working') {
      mmCtx.beginPath(); mmCtx.arc(ax,ay,3,0,Math.PI*2); mmCtx.fill();
    } else {
      mmCtx.fillRect(ax-2,ay-2,4,4);
    }
  });
  mmCtx.strokeStyle='rgba(0,229,255,0.5)'; mmCtx.lineWidth=1;
  mmCtx.strokeRect((camX/TILE)*scx,(camY/TILE)*scy,(W/TILE)*scx,(H/TILE)*scy);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT — drag/click
// ═══════════════════════════════════════════════════════════════════════════════
let isDragging=false, dragStart={x:0,y:0}, camStart={x:0,y:0}, dragMoved=false;

canvas.addEventListener('mousedown', e=>{
  dragMoved=false;
  isDragging=true; dragStart={x:e.clientX,y:e.clientY}; camStart={x:camX,y:camY};
});
canvas.addEventListener('mousemove', e=>{
  if(!isDragging) return;
  const dx=e.clientX-dragStart.x, dy=e.clientY-dragStart.y;
  if (Math.abs(dx)+Math.abs(dy)>4) {
    dragMoved=true; camMode='free';
    camX=camStart.x-dx; camY=camStart.y-dy;
  }
});
canvas.addEventListener('mouseup', e=>{
  isDragging=false;
  if (dragMoved) return; // was a drag, not a click
  const r=canvas.getBoundingClientRect();
  const mx=e.clientX-r.left+camX, my=e.clientY-r.top+camY;
  // Click agent?
  let hit=false;
  for(const a of AGENTS){
    if(Math.abs(a.px-mx)<16&&Math.abs(a.py-my)<18){
      if (pinnedAgent===a.id) { pinnedAgent=null; }
      else { pinnedAgent=a.id; openAgentPanel(a); }
      hit=true; break;
    }
  }
  if(!hit){
    for(const b of BUILDINGS){
      if(!b.decaying&&mx>=b.x*TILE&&mx<(b.x+b.w)*TILE&&my>=b.y*TILE&&my<(b.y+b.h)*TILE){
        openBuildingPanel(b); hit=true; break;
      }
    }
  }
  if(!hit) { pinnedAgent=null; document.getElementById('infopanel')?.classList.remove('show'); }
});
canvas.addEventListener('mouseleave',()=>{isDragging=false;});

// Touch
let lastTouch=null;
canvas.addEventListener('touchstart',e=>{e.preventDefault();lastTouch={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:false});
canvas.addEventListener('touchmove',e=>{e.preventDefault();if(!lastTouch)return;camX-=e.touches[0].clientX-lastTouch.x;camY-=e.touches[0].clientY-lastTouch.y;camMode='free';lastTouch={x:e.touches[0].clientX,y:e.touches[0].clientY};},{passive:false});
canvas.addEventListener('touchend',()=>lastTouch=null);

// ═══════════════════════════════════════════════════════════════════════════════
// INSPECTOR PANELS
// ═══════════════════════════════════════════════════════════════════════════════
function openAgentPanel(a) {
  const stateColor = {working:'#00ff88',walking:'#00e5ff',meeting:'#ffd060',idle:'#0a4060'}[a.state]||'#0a4060';
  let h=`<div class="ip-title" style="color:${a.color}">${a.name}
    <span style="font-size:6px;color:#0a6080;display:block;margin-top:3px">${a.role||'Agent'} · ${(a.hierarchyRole||'').toUpperCase()}</span></div>`;
  h+=`<div class="ip-section">◈ STATUS</div>`;
  h+=`<div class="ip-row">state <span style="color:${stateColor}">${(a.state||'idle').toUpperCase()}</span></div>`;
  h+=`<div class="ip-row">location <span>${a.currentBuilding?.name||'open water'}</span></div>`;
  h+=`<div class="ip-row">model <span>${a.model||'—'}</span></div>`;
  h+=`<div class="ip-row">tier <span>${a.tier||'—'}</span></div>`;
  if (a.activeJob) h+=`<div class="ip-row">task <span style="color:#00ff88">${a.activeJob.label||a.activeJob.tool||'—'}</span></div>`;
  if (a.activityDepth>0) h+=`<div class="ip-row">depth <span>${'●'.repeat(a.activityDepth)}</span></div>`;
  if (a.meetingWith) h+=`<div class="ip-row">meeting <span style="color:#ffd060">${a.meetingWith}</span></div>`;
  if (a.session) {
    h+=`<div class="ip-section">◈ SESSION</div>`;
    h+=`<div class="ip-row">key <span>${(a.session.sessionKey||'').slice(-20)}…</span></div>`;
    h+=`<div class="ip-row">tokens <span>${Math.round((a.session.contextTokens||0)/1000)}k</span></div>`;
  }
  if (a.thoughtLines?.length) {
    h+=`<div class="ip-section">🧠 THOUGHTS (last ${Math.min(8,a.thoughtLines.length)})</div>`;
    a.thoughtLines.slice(0,8).forEach(ln => {
      h+=`<div class="ip-mem">▸ ${esc(ln.text)}</div>`;
    });
  }
  h+=`<div class="ip-section" style="margin-top:8px"><button onclick="pinnedAgent=pinnedAgent==='${a.id}'?null:'${a.id}'" style="font-family:'Press Start 2P',monospace;font-size:6px;background:transparent;border:1px solid #0a3a5a;color:#0a6080;padding:4px 8px;cursor:pointer">${pinnedAgent===a.id?'◈ UNPIN':'◈ PIN THOUGHTS'}</button></div>`;
  document.getElementById('ipc').innerHTML=h;
  document.getElementById('infopanel').classList.add('show');
}

function openBuildingPanel(b) {
  const insideAgents = AGENTS.filter(a=>a.currentBuilding?.id===b.id);
  let h=`<div class="ip-title" style="color:${b.accent||'#00e5ff'}">${b.label||b.name}</div>`;
  h+=`<div style="font-family:'Press Start 2P',monospace;font-size:6px;color:#0a5070;margin-bottom:10px;line-height:1.9">${(b.kind||'').toUpperCase()}</div>`;
  if (b.details) {
    h+=`<div class="ip-section">⚙ DETAILS</div>`;
    for (const [k,v] of Object.entries(b.details)) {
      h+=`<div class="ip-row">${esc(k)} <span>${esc(String(v))}</span></div>`;
    }
  }
  if (insideAgents.length) {
    h+=`<div class="ip-section">🦞 INSIDE (${insideAgents.length})</div>`;
    insideAgents.forEach(a=>{
      h+=`<div class="ip-mem" style="color:${a.color}">▸ ${a.name} — ${a.activeJob?.label||a.state}</div>`;
    });
  }
  if (b.activities?.length) {
    h+=`<div class="ip-section">⚡ RECENT ACTIVITY</div>`;
    h+=`<div class="ip-mem">▸ ${esc(b.activities[Math.floor(tick/200)%b.activities.length])}</div>`;
  }
  if (b.cronJobs?.length) {
    h+=`<div class="ip-section">⏰ CRON JOBS</div>`;
    b.cronJobs.forEach(j=>{h+=`<div class="ip-mem">${j.enabled?'▸':'○'} ${esc(j.label||j.id)} — ${j.schedule}</div>`;});
  }
  if (b.channels?.length) {
    h+=`<div class="ip-section">📡 CHANNELS</div>`;
    b.channels.forEach(c=>{h+=`<div class="ip-mem" style="color:${c.color||'#aaa'}">▸ ${esc(c.id)}</div>`;});
  }
  document.getElementById('ipc').innerHTML=h;
  document.getElementById('infopanel').classList.add('show');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════
function setSpeed(s) {
  simSpeed=s;
  document.querySelectorAll('.spdbtn').forEach((btn,i)=>btn.classList.toggle('active',[0.5,1,2,4][i]===s));
}
window.setSpeed=setSpeed;

function resize(){
  W=canvas.offsetWidth; H=canvas.offsetHeight;
  canvas.width=W*devicePixelRatio; canvas.height=H*devicePixelRatio;
  ctx.scale(devicePixelRatio,devicePixelRatio); ctx.imageSmoothingEnabled=false;
}
window.addEventListener('resize',resize);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════════
function loop(){
  tick++;
  simTime += 0.025*simSpeed;
  if(simTime>=24*60) simTime=0;

  AGENTS.forEach(updateAgent);
  updateSpeechLines();
  updateCollabLinks();
  updateMeetings();
  maybeChatter();
  updateCamera();

  // Draw
  ctx.fillStyle='#020c18'; ctx.fillRect(0,0,W,H);
  drawCaustics();

  const tx0=Math.max(0,Math.floor(camX/TILE)-1), tx1=Math.min(MW,Math.ceil((camX+W)/TILE)+1);
  const ty0=Math.max(0,Math.floor(camY/TILE)-1), ty1=Math.min(MH,Math.ceil((camY+H)/TILE)+1);
  for(let ty=ty0;ty<ty1;ty++) for(let tx=tx0;tx<tx1;tx++) drawTile(tx,ty);

  drawBubbles();
  drawCollabLinks();
  drawMeetings();
  BUILDINGS.forEach(drawBuilding);
  AGENTS.slice().sort((a,b)=>a.py-b.py).forEach(drawAgent);
  drawAllSpeech();
  drawPinnedThoughts();
  drawMinimap();

  // Clock
  const h=Math.floor(simTime/60)%24, m=Math.floor(simTime%60);
  const ap=h>=12?'PM':'AM', hh=h>12?h-12:h===0?12:h;
  const clockEl=document.getElementById('clockel');
  if(clockEl) clockEl.innerHTML=`${String(hh).padStart(2,'0')}:${String(m).padStart(2,'0')} ${ap}<br><span style="font-size:6px;color:#0a3050">${worldMode.toUpperCase()}</span>`;

  requestAnimationFrame(loop);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORLD INIT
// ═══════════════════════════════════════════════════════════════════════════════
function applyWorld(world) {
  WORLD=world; BUILDINGS=world.buildings||[]; AGENTS=initAgentsFromWorld(world.agents||[]);
  for(let y=0;y<MH;y++) for(let x=0;x<MW;x++) map[y][x]=0;
  buildBaseMap(); applyBuildingsToMap();
  if(AGENTS.length){
    const mgr = AGENTS.find(a=>a.hierarchyRole==='manager') ?? AGENTS[0];
    camX=mgr.px-W/2; camY=mgr.py-H/2;
  }
  const legendEl=document.getElementById('legend-agents');
  if(legendEl) legendEl.innerHTML=AGENTS.map(a=>`
    <div class="lr"><div class="ld" style="background:${a.color}"></div>
    <span style="color:${a.hierarchyRole==='manager'?'#ffd060':a.color}">${a.name}</span>
    <span style="color:#0a4060"> — ${a.role}</span></div>`).join('');
  const splash=document.getElementById('splash');
  if(splash) splash.classList.add('hidden');
  addLog(`City: ${BUILDINGS.length} buildings, ${AGENTS.length} agents`,'new');
  addLog(`Mode: ${world.mode||worldMode}`,'live');
  cityEvent('🏙️', `Clawdville loaded — ${AGENTS.length} citizens`, '#00e5ff');
}

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK LAYER — WebSocket + server messages
// ═══════════════════════════════════════════════════════════════════════════════
let _latestWorld = null;

function connectToServer() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  wsRef = ws;
  if (window._setChatWs) window._setChatWs(ws);
  ws.onopen = () => { setStatusPill('connecting','LOADING…'); };
  ws.onmessage = e => { let m; try{m=JSON.parse(e.data);}catch{return;} (window.handleMsg??handleMsg)(m); };
  ws.onclose = () => {
    setStatusPill('offline','○ SERVER OFF');
    addLog('Connection lost — retrying…','warn');
    cityEvent('🔌','Server connection lost','#ff5555');
    setTimeout(connectToServer, 3000);
  };
  ws.onerror = () => setStatusPill('offline','✗ NO SERVER');
}

function handleMsg(msg) {
  switch(msg.type) {

    case 'world-init':
      _latestWorld = msg.world;
      worldMode = msg.mode||'live';
      setStatusPill(
        msg.mode==='live'?'live':msg.mode==='demo'?'demo':'offline',
        msg.mode==='live'?'● LIVE':msg.mode==='demo'?'◌ DEMO':'○ CACHED'
      );
      applyWorld(msg.world);
      break;

    case 'gateway-event':
      handleGatewayEvent(msg.event);
      break;

    case 'agent-activity':
      handleAgentActivity(msg);
      break;

    case 'gateway-error':
      setStatusPill('offline','✗ ERROR');
      addLog(msg.error?.message||'gateway error','warn');
      cityEvent('❌', msg.error?.message||'Gateway error', '#ff5555');
      break;

    case 'connecting':
      if(document.getElementById('splash-msg'))
        document.getElementById('splash-msg').textContent=`Connecting to ${msg.gatewayUrl}…`;
      break;

    // Incremental world changes from polling diff
    case 'world-add-building':
      if(msg.building&&_latestWorld){
        _latestWorld.buildings=_latestWorld.buildings??[];
        if(!BUILDINGS.find(b=>b.id===msg.building.id)){
          BUILDINGS.push(msg.building);
          buildBaseMap(); applyBuildingsToMap();
          cityEvent('🏗️',`${msg.building.label||msg.building.id} appeared`,'#00ff88');
          addLog(`Building: ${msg.building.label||msg.building.id}`,'new');
        }
      }
      break;

    case 'world-add-agent':
      if(msg.agent&&!AGENTS.find(a=>a.id===msg.agent.id)){
        const na=initAgentsFromWorld([msg.agent])[0];
        AGENTS.push(na);
        cityEvent('🦞',`${na.name} joined Clawdville`,na.color);
        addLog(`Agent joined: ${na.name}`,'new');
        const legendEl=document.getElementById('legend-agents');
        if(legendEl) legendEl.innerHTML=AGENTS.map(a=>
          `<div class="lr"><div class="ld" style="background:${a.color}"></div>${a.name} — ${a.role}</div>`
        ).join('');
      }
      break;

    case 'world-decay-building': {
      const b=BUILDINGS.find(b=>b.id===msg.buildingId);
      if(b&&!b.decaying){b.decaying=true;b.decayStart=Date.now();}
      cityEvent('🌊',`${msg.buildingId} dissolving`,'#ff8c35');
      break;
    }

    case 'world-remove-agent': {
      const a=AGENTS.find(a=>a.id===msg.agentId);
      if(a){
        a.state='leaving'; a.glowing=false;
        agentSpeak(a,'Goodbye…',180);
        cityEvent('👋',`${a.name} left Clawdville`,a.color);
        setTimeout(()=>{AGENTS=AGENTS.filter(x=>x.id!==msg.agentId);},5000);
      }
      break;
    }

    case 'health-change': {
      const spire=BUILDINGS.find(b=>b.id==='gateway');
      if(spire){spire.details.status=msg.status;spire.accent=msg.status==='ok'?'#00e5ff':msg.status==='warn'?'#ffd060':'#ff5555';}
      break;
    }

    case 'session-token-update': {
      const vault=BUILDINGS.find(b=>b.id==='db');
      if(vault&&msg.delta>0){
        const cur=parseInt(vault.details?.totalTokens??'0')*1000;
        vault.details.totalTokens=`${Math.round((cur+msg.delta)/1000)}k`;
      }
      if(msg.delta>8000){
        const agId=msg.sessionKey?.split?.(':')?.[1]??'main';
        const agent=AGENTS.find(a=>a.id===agId);
        if(agent){agent.glowing=true;setTimeout(()=>{if(agent)agent.glowing=false;},4000);}
      }
      break;
    }

    case 'cron-ran':
      worldCronRan(msg.jobId,msg.job);
      break;

    case 'state-changes':
      // Individual change messages are broadcast separately; just log summary
      if(msg.changes?.length)
        console.log('[clawcove]',msg.changes.map(c=>`${c.type}:${c.action}`).join(', '));
      break;

    // Job board
    case 'jobboard-update':
      renderJobBoard(msg.jobBoard);
      break;
    case 'jobboard-run-update':
      if(jbData){jbData.activeRuns=msg.activeRuns??[];renderJobBoard(jbData);}
      break;
    case 'jobboard-recent-update':
      if(jbData){jbData.recentRuns=msg.recentRuns??[];renderJobBoard(jbData);}
      break;

    case 'log':
      addLog(msg.text, msg.level||'new');
      break;

    // Legacy
    case 'cron-fired':  addLog(`⏰ Cron: ${msg.payload?.jobId??'fired'}`,'warn'); break;
    case 'chat-event':  addLog(`💬 ${msg.payload?.channel??'chat'}`,'live'); break;
    case 'presence-update': addLog(`◈ Presence: ${msg.payload?.mode??'update'}`,'new'); break;
    case 'building-update': {
      const b=BUILDINGS.find(b=>b.id===msg.buildingId);
      if(b) Object.assign(b.details??{},msg.details??{});
      break;
    }
  }
}

function worldCronRan(jobId, job) {
  const cronBldg=BUILDINGS.find(b=>b.id==='cron');
  const cleo=AGENTS.find(a=>a.id==='cleo')??AGENTS[0];
  if(cleo&&cronBldg){
    cleo.activeJob={buildingId:'cron',tool:'schedule',label:`Cron: ${job?.label??jobId}`};
    cleo.glowing=true;
    agentSpeak(cleo,`⏰ ${job?.label??jobId}!`,200);
  }
  addLog(`Cron ran: ${job?.label??jobId}`,'cron');
  cityEvent('⏰',`Cron: ${job?.label??jobId}`,'#ffd060');
}

// ═══════════════════════════════════════════════════════════════════════════════
// JOB BOARD UI
// ═══════════════════════════════════════════════════════════════════════════════
let jbData=null, jbOpen=false;

function initJobBoard() {
  const panel=document.createElement('div');
  panel.id='jobboard';
  panel.innerHTML=`
    <div id="jb-header">
      <span id="jb-title">◈ JOB BOARD</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span id="jb-live-dot" class="jb-live-dot"></span>
        <span id="jb-close" onclick="toggleJobBoard()">✕</span>
      </div>
    </div>
    <div id="jb-body">
      <div class="jb-sec"><div class="jb-sec-title"><span>⚡</span>ACTIVE RUNS</div><div id="jb-active-rows"></div></div>
      <div class="jb-sec"><div class="jb-sec-title"><span>⏰</span>CRON JOBS</div><div id="jb-cron-rows"></div></div>
      <div class="jb-sec"><div class="jb-sec-title"><span>📡</span>CHANNELS</div><div id="jb-channel-rows"></div></div>
      <div class="jb-sec"><div class="jb-sec-title"><span>🧠</span>SESSIONS</div><div id="jb-session-rows"></div></div>
      <div class="jb-sec"><div class="jb-sec-title"><span>📱</span>NODES</div><div id="jb-node-rows"></div></div>
      <div class="jb-sec"><div class="jb-sec-title"><span>🔧</span>SKILLS</div><div id="jb-skill-rows"></div></div>
      <div class="jb-sec"><div class="jb-sec-title"><span>🕐</span>RECENT RUNS</div><div id="jb-recent-rows"></div></div>
    </div>`;
  document.body.appendChild(panel);

  const btn=document.createElement('button');
  btn.id='jb-toggle'; btn.innerHTML='◈ JOBS'; btn.onclick=toggleJobBoard;
  document.getElementById('ui')?.appendChild(btn);

  injectStyles();
}

window.toggleJobBoard=function toggleJobBoard(){
  jbOpen=!jbOpen;
  document.getElementById('jobboard')?.classList.toggle('open',jbOpen);
  document.getElementById('jb-toggle')?.classList.toggle('active',jbOpen);
  const shift=jbOpen?'284px':'8px';
  ['legend','eventlog'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.left=shift;});
};

function toggleBulletin(){
  bulletinOpen=!bulletinOpen;
  document.getElementById('bulletin')?.classList.toggle('open',bulletinOpen);
  document.getElementById('bulletin-toggle')?.classList.toggle('active',bulletinOpen);
  if(bulletinOpen) renderBulletin();
}
window.toggleBulletin=toggleBulletin;

function initBulletin(){
  const panel=document.createElement('div');
  panel.id='bulletin';
  panel.innerHTML=`
    <div id="bul-header">
      <span>📰 CITY BULLETIN</span>
      <span id="bul-close" onclick="toggleBulletin()">✕</span>
    </div>
    <div id="bul-body"><div id="bulletin-rows"></div></div>`;
  document.body.appendChild(panel);

  const btn=document.createElement('button');
  btn.id='bulletin-toggle'; btn.innerHTML='📰 NEWS'; btn.onclick=toggleBulletin;
  document.getElementById('ui')?.appendChild(btn);
}

function renderJobBoard(jb){
  if(!jb) return; jbData=jb;
  const ld=document.getElementById('jb-live-dot');
  if(ld) ld.style.animationDuration=jb.activeRuns?.length?'.6s':'2s';
  jbFill('jb-active-rows', renderActiveRuns(jb.activeRuns??[]));
  jbFill('jb-cron-rows',   renderCronJobs(jb.cronJobs??[]));
  jbFill('jb-channel-rows',renderChannels(jb.channels??[]));
  jbFill('jb-session-rows',renderSessions(jb.sessions??[]));
  jbFill('jb-node-rows',   renderNodes(jb.nodes??[]));
  jbFill('jb-skill-rows',  renderSkills(jb.skills??[]));
  jbFill('jb-recent-rows', renderRecentRuns(jb.recentRuns??[]));
}

function jbFill(id,html){const el=document.getElementById(id);if(el)el.innerHTML=html||'<div class="jb-empty">—</div>';}

function renderActiveRuns(runs){
  if(!runs.length) return '<div class="jb-empty">No active runs</div>';
  return runs.map(r=>`<div class="jb-row"><div class="jb-dot running"></div><div class="jb-col"><div class="jb-name">${esc(r.agentId)} · ${esc(r.tool||'—')}</div><div class="jb-sub">${rel(r.startedAt)}</div></div><div class="jb-badge running">ACTIVE</div></div>`).join('');
}
function renderCronJobs(jobs){
  if(!jobs.length) return '<div class="jb-empty">No cron jobs</div>';
  return jobs.map(j=>`<div class="jb-row"><div class="jb-dot ${j.enabled?'ok':'off'}"></div><div class="jb-col"><div class="jb-name">${esc(j.label||j.id)}</div><div class="jb-sub">${esc(j.schedule||'—')} · ${j.runCount??0} runs${j.lastRun?' · '+rel(j.lastRun):''}</div></div><div class="jb-badge ${j.enabled?'enabled':'disabled'}">${j.enabled?'ON':'OFF'}</div></div>`).join('');
}
function renderChannels(chs){
  if(!chs.length) return '<div class="jb-empty">No channels</div>';
  return chs.map(c=>`<div class="jb-row"><div class="jb-dot ${c.linked?'linked':'warn'}"></div><div class="jb-col"><div class="jb-name">${esc(c.id)}</div><div class="jb-sub">${esc(c.status)}${c.messageCount?' · '+c.messageCount+' msgs':''}</div></div><div class="jb-badge ${c.linked?'linked':'unlinked'}">${c.linked?'LINKED':'UNLINKED'}</div></div>`).join('');
}
function renderSessions(sessions){
  const act=sessions.filter(s=>s.contextTokens>0).slice(0,8);
  if(!act.length) return '<div class="jb-empty">No active sessions</div>';
  return act.map(s=>{
    const pct=Math.min(100,Math.round((s.contextTokens/200000)*100));
    const dot=s.contextTokens>100000?'hot':s.contextTokens>40000?'warn':'ok';
    const bc=dot==='hot'?'#ff6b35':dot==='warn'?'#ffd060':'#00c8e0';
    return `<div class="jb-row"><div class="jb-dot ${dot}"></div><div class="jb-col"><div class="jb-name">${esc(s.agentId)} · ${Math.round(s.contextTokens/1000)}k</div><div class="jb-bar-bg"><div class="jb-bar-fg" style="width:${pct}%;background:${bc}"></div></div></div><div class="jb-meta">${pct}%</div></div>`;
  }).join('');
}
function renderNodes(nodes){
  if(!nodes.length) return '<div class="jb-empty">No nodes</div>';
  return nodes.map(n=>`<div class="jb-row"><div class="jb-dot running"></div><div class="jb-col"><div class="jb-name">${esc(n.displayName||n.id)}</div><div class="jb-sub">${esc(n.deviceFamily)} · ${esc(n.platform)}</div></div><div class="jb-badge live">LIVE</div></div>`).join('');
}
function renderSkills(skills){
  if(!skills.length) return '<div class="jb-empty">No skills</div>';
  return skills.map(s=>`<div class="jb-row"><div class="jb-dot ${s.enabled?'ok':'off'}"></div><div class="jb-col"><div class="jb-name">${esc(s.name||s.id)}</div><div class="jb-sub">v${esc(s.version)}${s.lastUsed?' · used '+rel(s.lastUsed):''}</div></div><div class="jb-badge ${s.enabled?'enabled':'disabled'}">${s.enabled?'ON':'OFF'}</div></div>`).join('');
}
function renderRecentRuns(runs){
  if(!runs.length) return '<div class="jb-empty">No completed runs</div>';
  return runs.slice(0,15).map(r=>`<div class="jb-row"><div class="jb-dot ${r.status==='ok'?'ok':'error'}"></div><div class="jb-col"><div class="jb-name">${esc(r.agentId)}${r.tool?' · '+esc(r.tool):''}</div><div class="jb-sub">${dur(r.durationMs)} · ${rel(r.finishedAt)}</div></div><div class="jb-badge ${r.status}">${r.status.toUpperCase()}</div></div>`).join('');
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function rel(ts){
  if(!ts)return'—';const s=Math.floor((Date.now()-ts)/1000);
  if(s<5)return'now';if(s<60)return s+'s ago';
  const m=Math.floor(s/60);if(m<60)return m+'m ago';
  const h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago';
}
function relTime(ts){return rel(ts);}
function dur(ms){
  if(!ms||ms<0)return'—';if(ms<1000)return ms+'ms';
  if(ms<60000)return(ms/1000).toFixed(1)+'s';
  return Math.floor(ms/60000)+'m '+Math.floor((ms%60000)/1000)+'s';
}
function esc(s){
  if(s===null||s===undefined)return'—';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES — injected dynamically so they don't require a separate CSS file
// ═══════════════════════════════════════════════════════════════════════════════
function injectStyles(){
  const s=document.createElement('style');
  s.textContent=`
/* Job board */
#jobboard{position:fixed;left:0;top:46px;bottom:0;width:276px;background:rgba(1,5,16,.98);border-right:2px solid #0a2840;font-family:'Press Start 2P',monospace;display:none;flex-direction:column;overflow:hidden;pointer-events:all;z-index:50;box-shadow:4px 0 24px rgba(0,0,0,.6);}
#jobboard.open{display:flex;}
#jb-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 9px;border-bottom:1px solid #0a2840;background:rgba(0,8,22,.98);flex-shrink:0;}
#jb-title{font-size:8px;color:#00e5ff;letter-spacing:.12em;}
#jb-close{font-size:7px;color:#0a4060;cursor:pointer;padding:2px 5px;}
#jb-close:hover{color:#00e5ff;}
.jb-live-dot{width:6px;height:6px;border-radius:50%;background:#00ff88;box-shadow:0 0 5px #00ff88;animation:jbp 2s infinite;}
@keyframes jbp{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
#jb-body{overflow-y:auto;flex:1;}
#jb-body::-webkit-scrollbar{width:3px;}
#jb-body::-webkit-scrollbar-thumb{background:#0a2840;}
.jb-sec{border-bottom:1px solid rgba(10,40,64,.5);}
.jb-sec-title{display:flex;align-items:center;gap:6px;font-size:6px;color:#0a3a58;padding:7px 14px 5px;background:rgba(0,6,18,.6);letter-spacing:.1em;position:sticky;top:0;z-index:1;border-bottom:1px solid rgba(10,40,64,.3);}
.jb-row{display:flex;align-items:center;gap:7px;padding:5px 14px 4px;border-bottom:1px solid rgba(10,40,64,.2);transition:background .1s;}
.jb-row:hover{background:rgba(0,30,60,.35);}
.jb-empty{font-size:5px;color:#0a2030;padding:7px 14px;line-height:2;}
.jb-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-top:1px;}
.jb-dot.running{background:#00ff88;box-shadow:0 0 5px #00ff88;animation:jbp 1s infinite;}
.jb-dot.ok{background:#00c8e0;}.jb-dot.linked{background:#00e5a0;}.jb-dot.warn{background:#ffd060;}
.jb-dot.error{background:#ff5555;}.jb-dot.off{background:#1a3a50;}.jb-dot.hot{background:#ff6b35;box-shadow:0 0 5px #ff6b35;animation:jbp 1.5s infinite;}
.jb-col{display:flex;flex-direction:column;flex:1;min-width:0;gap:1px;}
.jb-name{font-size:6px;color:#7ef7ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.9;}
.jb-sub{font-size:5px;color:#1a5070;line-height:1.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.jb-meta{font-size:5px;color:#1a5070;flex-shrink:0;text-align:right;}
.jb-badge{font-size:5px;padding:1px 5px 0;border:1px solid;line-height:1.8;letter-spacing:.05em;flex-shrink:0;}
.jb-badge.running{color:#00ff88;border-color:#00ff88;}.jb-badge.ok{color:#00c8e0;border-color:#00c8e0;}
.jb-badge.error{color:#ff5555;border-color:#ff5555;}.jb-badge.enabled{color:#00c080;border-color:#007040;}
.jb-badge.disabled{color:#2a4050;border-color:#1a2a38;}.jb-badge.linked{color:#00e5a0;border-color:#00804a;}
.jb-badge.unlinked{color:#ff9944;border-color:#804422;}.jb-badge.live{color:#44aaff;border-color:#2266aa;}
.jb-bar-bg{width:48px;height:3px;background:#0a1e30;flex-shrink:0;}
.jb-bar-fg{height:3px;}
#jb-toggle{position:fixed;bottom:12px;left:8px;font-family:'Press Start 2P',monospace;font-size:6px;background:rgba(0,10,28,.96);border:1px solid #0a2840;color:#1a6080;padding:6px 12px;cursor:pointer;pointer-events:all;z-index:51;letter-spacing:.08em;transition:all .12s;}
#jb-toggle:hover,#jb-toggle.active{background:#00e5ff;color:#000;border-color:#00e5ff;}
/* Bulletin */
#bulletin{position:fixed;right:0;top:46px;bottom:0;width:260px;background:rgba(1,5,16,.98);border-left:2px solid #0a2840;font-family:'Press Start 2P',monospace;display:none;flex-direction:column;overflow:hidden;pointer-events:all;z-index:50;}
#bulletin.open{display:flex;}
#bul-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #0a2840;font-size:8px;color:#ffd060;flex-shrink:0;}
#bul-close{font-size:7px;color:#0a4060;cursor:pointer;padding:2px 5px;}
#bul-close:hover{color:#ffd060;}
#bul-body{overflow-y:auto;flex:1;}
#bul-body::-webkit-scrollbar{width:3px;}
#bul-body::-webkit-scrollbar-thumb{background:#0a2840;}
#bulletin-rows{padding:4px 0;}
.bul-row{display:flex;align-items:flex-start;gap:6px;padding:5px 12px;border-bottom:1px solid rgba(10,40,64,.3);transition:background .1s;}
.bul-row:hover{background:rgba(0,30,60,.3);}
.bul-row.bul-new{background:rgba(0,40,20,.4);}
.bul-icon{font-size:11px;flex-shrink:0;line-height:1.4;}
.bul-text{font-size:5px;color:#7ef7ff;line-height:1.9;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bul-time{font-size:5px;color:#0a3a58;flex-shrink:0;line-height:1.9;}
#bulletin-toggle{position:fixed;bottom:12px;right:8px;font-family:'Press Start 2P',monospace;font-size:6px;background:rgba(0,10,28,.96);border:1px solid #0a2840;color:#806010;padding:6px 12px;cursor:pointer;pointer-events:all;z-index:51;letter-spacing:.08em;transition:all .12s;}
#bulletin-toggle:hover,#bulletin-toggle.active{background:#ffd060;color:#000;border-color:#ffd060;}
`;
  document.head.appendChild(s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('load', ()=>{
  resize();
  buildBaseMap();
  loop();
  initJobBoard();
  initBulletin();
  initChat();
  connectToServer();
  const sub=document.getElementById('splash-sub');
  if(sub) sub.textContent='Make sure OpenClaw is running.';
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT SYSTEM
// Three layers:
//   1. MANAGER CHAT  — user ↔ main agent (real-time, sends messages to gateway)
//   2. AGENT LOG     — captures all inter-agent speech/delegation events
//   3. CHAT TABS     — per-conversation history the user can open and read
// All agent speech bubbles on the canvas are also mirrored here as log entries.
// ═══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────
let chatOpen        = false;
let chatActiveTab   = 'manager';   // 'manager' | agentId (for agent-to-agent logs)

// Message stores — no localStorage (not supported in this env), kept in memory
const CHAT_MANAGER  = [];   // [{ts, from, text, type}]  type = 'user'|'agent'|'system'
const AGENT_CONVOS  = {};   // { [convoKey]: [{ts, from, to, text}] }  convoKey = "a:b"
const AGENT_LOG     = [];   // flat list of all inter-agent events, newest first

let wsRef = null;           // set by connectToServer so chat can send messages

// ── Conversation key (canonical, order-independent) ───────────────────────────
function convoKey(a, b) { return [a, b].sort().join(':'); }

// ── Log an agent-to-agent interaction ─────────────────────────────────────────
// Called from startMeeting, delegation detection, channel events, etc.
export function logAgentConvo(fromId, toId, text, type = 'speech') {
  const ts    = Date.now();
  const key   = convoKey(fromId, toId);

  if (!AGENT_CONVOS[key]) AGENT_CONVOS[key] = [];
  AGENT_CONVOS[key].push({ ts, from: fromId, to: toId, text, type });
  if (AGENT_CONVOS[key].length > 200) AGENT_CONVOS[key].shift();

  AGENT_LOG.unshift({ ts, from: fromId, to: toId, text, key, type });
  if (AGENT_LOG.length > 300) AGENT_LOG.pop();

  // If chat window is open and on this convo tab, refresh
  if (chatOpen && chatActiveTab === key) renderChatMessages();
  if (chatOpen && chatActiveTab === 'log')   renderAgentLog();

  // Also push to agent tab list
  refreshChatTabs();
}

// ── Log something the manager agent "said" (from gateway event / speech) ──────
export function logManagerSpeech(text, type = 'agent') {
  const ts = Date.now();
  CHAT_MANAGER.push({ ts, from: 'manager', text, type });
  if (CHAT_MANAGER.length > 300) CHAT_MANAGER.shift();
  if (chatOpen && chatActiveTab === 'manager') renderChatMessages();
}

// ── Send user message to manager via gateway ──────────────────────────────────
function sendUserMessage(text) {
  if (!text?.trim()) return;
  const ts = Date.now();
  CHAT_MANAGER.push({ ts, from: 'user', text: text.trim(), type: 'user' });

  // Visual: make manager agent react
  const mgr = AGENTS.find(a => a.hierarchyRole === 'manager') ?? AGENTS[0];
  if (mgr) {
    agentSpeak(mgr, `User: ${text.slice(0,20)}…`, 200);
    mgr.glowing = true;
    setTimeout(() => { if (mgr) mgr.glowing = false; }, 3000);
  }
  cityEvent('💬', `You: ${text.slice(0,30)}`, '#00ff88');

  // Send over WebSocket to gateway
  if (wsRef && wsRef.readyState === 1) {
    wsRef.send(JSON.stringify({
      type:   'user-message',
      target: 'main',
      text:   text.trim(),
      ts,
    }));
  } else {
    // No live gateway — show offline notice
    CHAT_MANAGER.push({
      ts: Date.now(),
      from: 'system',
      text: '⚠ Gateway offline — message not sent. Reconnecting…',
      type: 'system',
    });
  }

  if (chatOpen && chatActiveTab === 'manager') renderChatMessages();
}

// ── Handle manager reply from gateway ─────────────────────────────────────────
// Called from handleGatewayEvent when e === 'agent' and status has a reply text
function handleManagerReply(text, agentId) {
  const mgr = AGENTS.find(a => a.id === agentId || a.hierarchyRole === 'manager') ?? AGENTS[0];
  if (mgr) {
    agentSpeak(mgr, text.slice(0, 28), 220);
    logManagerSpeech(text, 'agent');
  }
}

// ── Init DOM ──────────────────────────────────────────────────────────────────
function initChat() {
  // Panel
  const panel = document.createElement('div');
  panel.id = 'chat-panel';
  panel.innerHTML = `
    <div id="chat-header">
      <div id="chat-tabs-bar">
        <button class="chat-tab active" data-tab="manager" onclick="switchChatTab('manager')">
          💬 MANAGER
        </button>
        <button class="chat-tab" data-tab="log" onclick="switchChatTab('log')">
          📋 ALL COMMS
        </button>
        <div id="chat-tab-agents"><!-- dynamic agent conversation tabs --></div>
      </div>
      <span id="chat-close" onclick="toggleChat()">✕</span>
    </div>

    <div id="chat-body">
      <!-- MANAGER TAB -->
      <div id="chat-view-manager" class="chat-view active">
        <div id="chat-msgs-manager" class="chat-msgs"></div>
        <div id="chat-input-row">
          <input id="chat-input" type="text" placeholder="Message the manager…" maxlength="500"
            onkeydown="if(event.key==='Enter')submitChat()" autocomplete="off"/>
          <button id="chat-send" onclick="submitChat()">→</button>
        </div>
        <div id="chat-status-bar">
          <span id="chat-agent-status">◈ Manager: idle</span>
          <span id="chat-gateway-status">offline</span>
        </div>
      </div>

      <!-- ALL COMMS LOG TAB -->
      <div id="chat-view-log" class="chat-view">
        <div id="chat-msgs-log" class="chat-msgs chat-log-view"></div>
        <div style="padding:6px 10px;font-size:5px;color:#0a3050;border-top:1px solid #0a2030">
          All agent communications — newest first
        </div>
      </div>

      <!-- Dynamic per-convo tabs rendered by refreshChatTabs -->
    </div>`;
  document.body.appendChild(panel);

  // Toggle button — stays bottom-right area
  const btn = document.createElement('button');
  btn.id = 'chat-toggle';
  btn.innerHTML = '💬 CHAT';
  btn.onclick = toggleChat;
  document.getElementById('ui').appendChild(btn);

  injectChatStyles();
}

window.toggleChat = function() {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel')?.classList.toggle('open', chatOpen);
  document.getElementById('chat-toggle')?.classList.toggle('active', chatOpen);
  if (chatOpen) {
    renderChatMessages();
    scrollChatToBottom();
  }
};

window.switchChatTab = function(tab) {
  chatActiveTab = tab;
  document.querySelectorAll('.chat-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.chat-view').forEach(v =>
    v.classList.toggle('active', v.id === `chat-view-${tab}`)
  );
  renderChatMessages();
  scrollChatToBottom();
};

window.submitChat = function() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (text) { sendUserMessage(text); input.value = ''; }
};

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderChatMessages() {
  if (chatActiveTab === 'manager') renderManagerChat();
  else if (chatActiveTab === 'log') renderAgentLog();
  else renderConvoChat(chatActiveTab);
}

function renderManagerChat() {
  const el = document.getElementById('chat-msgs-manager');
  if (!el) return;

  if (!CHAT_MANAGER.length) {
    el.innerHTML = '<div class="chat-empty">No messages yet.<br>Send the manager a task or question.</div>';
    return;
  }

  el.innerHTML = CHAT_MANAGER.map(m => {
    const isUser   = m.type === 'user';
    const isSystem = m.type === 'system';
    const cls      = isUser ? 'chat-msg user' : isSystem ? 'chat-msg system' : 'chat-msg agent';
    const who      = isUser ? 'YOU' : isSystem ? 'SYSTEM' : 'MANAGER';
    const mgr      = AGENTS.find(a => a.hierarchyRole === 'manager');
    const col      = isUser ? '#00ff88' : isSystem ? '#ffd060' : (mgr?.color ?? '#7ef7ff');
    return `
      <div class="${cls}">
        <div class="chat-msg-who" style="color:${col}">${who}</div>
        <div class="chat-msg-text">${esc(m.text)}</div>
        <div class="chat-msg-ts">${fmtTime(m.ts)}</div>
      </div>`;
  }).join('');

  scrollChatToBottom('chat-msgs-manager');

  // Update manager status
  const mgr = AGENTS.find(a => a.hierarchyRole === 'manager') ?? AGENTS[0];
  const statusEl = document.getElementById('chat-agent-status');
  if (statusEl && mgr) {
    const stateLabel = { working: '🔧 working', walking: '🚶 moving', meeting: '🤝 meeting', idle: '💤 idle' }[mgr.state] ?? mgr.state;
    statusEl.textContent = `◈ ${mgr.name}: ${stateLabel}`;
    statusEl.style.color = mgr.state === 'working' ? '#00ff88' : mgr.state === 'meeting' ? '#ffd060' : '#0a4060';
  }
  const gwEl = document.getElementById('chat-gateway-status');
  if (gwEl) {
    gwEl.textContent = wsRef?.readyState === 1 ? '● LIVE' : '○ OFFLINE';
    gwEl.style.color = wsRef?.readyState === 1 ? '#00ff88' : '#ff5555';
  }
}

function renderAgentLog() {
  const el = document.getElementById('chat-msgs-log');
  if (!el) return;
  if (!AGENT_LOG.length) {
    el.innerHTML = '<div class="chat-empty">No inter-agent communications yet.</div>';
    return;
  }
  el.innerHTML = AGENT_LOG.slice(0, 80).map(m => {
    const fa = AGENTS.find(a => a.id === m.from);
    const ta = m.to ? AGENTS.find(a => a.id === m.to) : null;
    const fcol = fa?.color ?? '#7ef7ff';
    const tcol = ta?.color ?? '#0a8080';
    const icon = m.type === 'delegation' ? '📋' : m.type === 'cron' ? '⏰' : m.type === 'channel' ? '📡' : '💬';
    return `
      <div class="chat-log-row">
        <div class="chat-log-who">
          <span style="color:${fcol}">${esc(fa?.name ?? m.from)}</span>
          ${m.to ? `<span class="chat-log-arrow">→</span><span style="color:${tcol}">${esc(ta?.name ?? m.to)}</span>` : ''}
          <span class="chat-log-type">${icon}</span>
        </div>
        <div class="chat-log-text">${esc(m.text)}</div>
        <div class="chat-msg-ts">${fmtTime(m.ts)}</div>
      </div>`;
  }).join('');
}

function renderConvoChat(key) {
  const msgs = AGENT_CONVOS[key] ?? [];
  const viewId = `chat-view-${CSS.escape(key)}`;
  const el = document.getElementById(`chat-msgs-${CSS.escape(key)}`);
  if (!el) return;
  if (!msgs.length) { el.innerHTML = '<div class="chat-empty">No messages in this conversation.</div>'; return; }
  el.innerHTML = msgs.slice().reverse().slice(0, 60).reverse().map(m => {
    const fa = AGENTS.find(a => a.id === m.from);
    return `
      <div class="chat-msg agent">
        <div class="chat-msg-who" style="color:${fa?.color ?? '#7ef7ff'}">${esc(fa?.name ?? m.from)}</div>
        <div class="chat-msg-text">${esc(m.text)}</div>
        <div class="chat-msg-ts">${fmtTime(m.ts)}</div>
      </div>`;
  }).join('');
  scrollChatToBottom(`chat-msgs-${CSS.escape(key)}`);
}

// ── Dynamic tabs for agent conversations ──────────────────────────────────────
function refreshChatTabs() {
  const bar = document.getElementById('chat-tab-agents');
  if (!bar) return;

  // Find unique convo keys with at least 1 message
  const keys = Object.keys(AGENT_CONVOS).filter(k => AGENT_CONVOS[k].length > 0);

  bar.innerHTML = keys.map(key => {
    const [idA, idB] = key.split(':');
    const nA = AGENTS.find(a => a.id === idA)?.name ?? idA;
    const nB = AGENTS.find(a => a.id === idB)?.name ?? idB;
    const recent = AGENT_CONVOS[key].length;
    const isActive = chatActiveTab === key;
    return `
      <button class="chat-tab${isActive ? ' active' : ''}" data-tab="${esc(key)}"
        onclick="switchChatTab('${esc(key)}'); ensureConvoView('${esc(key)}')">
        🤝 ${esc(nA)}↔${esc(nB)} <span class="chat-tab-count">${recent}</span>
      </button>`;
  }).join('');

  // Ensure view divs exist for each convo
  keys.forEach(key => ensureConvoView(key, false));
}

window.ensureConvoView = function(key, switchTo = true) {
  const safeKey = CSS.escape(key);
  if (!document.getElementById(`chat-view-${safeKey}`)) {
    const body = document.getElementById('chat-body');
    const div = document.createElement('div');
    div.id = `chat-view-${safeKey}`;
    div.className = 'chat-view';
    div.innerHTML = `<div id="chat-msgs-${safeKey}" class="chat-msgs"></div>
      <div style="padding:6px 10px;font-size:5px;color:#0a3050;border-top:1px solid #0a2030">
        Conversation log (read-only)
      </div>`;
    body.appendChild(div);
  }
  if (switchTo) switchChatTab(key);
  renderConvoChat(key);
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function scrollChatToBottom(id = 'chat-msgs-manager') {
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// Update chat status bar every 2s even if chat is open
setInterval(() => {
  if (chatOpen && chatActiveTab === 'manager') {
    const mgr = AGENTS.find(a => a.hierarchyRole === 'manager') ?? AGENTS[0];
    const statusEl = document.getElementById('chat-agent-status');
    if (statusEl && mgr) {
      const stateLabel = { working: '🔧 working', walking: '🚶 moving', meeting: '🤝 meeting', idle: '💤 idle' }[mgr.state] ?? mgr.state;
      statusEl.textContent = `◈ ${mgr.name}: ${stateLabel}`;
    }
  }
}, 2000);

// ── Inject styles ─────────────────────────────────────────────────────────────
function injectChatStyles() {
  const s = document.createElement('style');
  s.textContent = `
/* ── Chat panel ────────────────────────────────────────────────────────────── */
#chat-panel {
  position: fixed;
  bottom: 0; right: 0;
  width: 320px; height: 460px;
  background: rgba(1,5,16,0.98);
  border-top: 2px solid #0a2840;
  border-left: 2px solid #0a2840;
  font-family: 'Press Start 2P', monospace;
  display: none; flex-direction: column;
  pointer-events: all; z-index: 52;
  box-shadow: -4px -4px 24px rgba(0,0,0,0.6);
  resize: both; overflow: hidden;
  min-width: 260px; min-height: 300px;
}
#chat-panel.open { display: flex; }

/* ── Header / tabs ─────────────────────────────────────────────────────────── */
#chat-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  background: rgba(0,8,22,0.98); border-bottom: 1px solid #0a2840;
  flex-shrink: 0; padding: 4px 8px 0;
}
#chat-tabs-bar {
  display: flex; flex-wrap: wrap; gap: 2px; flex: 1; padding-bottom: 4px;
}
.chat-tab {
  font-family: 'Press Start 2P', monospace; font-size: 5px;
  background: transparent; border: 1px solid #0a2030;
  color: #0a4060; padding: 3px 7px; cursor: pointer;
  transition: all .1s; white-space: nowrap;
}
.chat-tab:hover { border-color: #00e5ff; color: #00e5ff; }
.chat-tab.active { background: rgba(0,229,255,0.1); border-color: #00e5ff; color: #00e5ff; }
.chat-tab-count { color: #00ff88; font-size: 5px; }
#chat-close { font-size: 7px; color: #0a4060; cursor: pointer; padding: 4px 5px; flex-shrink: 0; }
#chat-close:hover { color: #00e5ff; }

/* ── Body / views ──────────────────────────────────────────────────────────── */
#chat-body { flex: 1; overflow: hidden; position: relative; }
.chat-view { display: none; flex-direction: column; height: 100%; }
.chat-view.active { display: flex; }

/* ── Messages ──────────────────────────────────────────────────────────────── */
.chat-msgs {
  flex: 1; overflow-y: auto; padding: 8px;
  display: flex; flex-direction: column; gap: 8px;
}
.chat-msgs::-webkit-scrollbar { width: 3px; }
.chat-msgs::-webkit-scrollbar-thumb { background: #0a2840; }

.chat-empty {
  font-size: 6px; color: #0a2030; text-align: center;
  padding: 20px 10px; line-height: 2.2; margin: auto;
}

.chat-msg {
  display: flex; flex-direction: column; gap: 2px;
  max-width: 85%; padding: 6px 8px;
  border: 1px solid rgba(10,40,64,0.5);
  background: rgba(0,8,20,0.5);
}
.chat-msg.user  { align-self: flex-end; border-color: rgba(0,255,136,0.3); background: rgba(0,40,20,0.5); }
.chat-msg.agent { align-self: flex-start; border-color: rgba(0,229,255,0.2); }
.chat-msg.system { align-self: center; border-color: rgba(255,208,96,0.3); background: rgba(40,30,0,0.5); }

.chat-msg-who { font-size: 5px; letter-spacing: .08em; margin-bottom: 1px; }
.chat-msg-text { font-size: 6px; color: #7ef7ff; line-height: 1.9; word-break: break-word; }
.chat-msg.user .chat-msg-text { color: #00ff88; }
.chat-msg.system .chat-msg-text { color: #ffd060; }
.chat-msg-ts { font-size: 5px; color: #0a3050; text-align: right; }

/* ── Input row ─────────────────────────────────────────────────────────────── */
#chat-input-row {
  display: flex; gap: 4px;
  padding: 6px 8px; border-top: 1px solid #0a2030;
  background: rgba(0,4,12,0.8); flex-shrink: 0;
}
#chat-input {
  flex: 1; font-family: 'Press Start 2P', monospace; font-size: 6px;
  background: rgba(0,10,28,0.8); border: 1px solid #0a2840;
  color: #7ef7ff; padding: 5px 7px; outline: none;
  caret-color: #00e5ff;
}
#chat-input:focus { border-color: #00e5ff; }
#chat-input::placeholder { color: #0a3a5a; }
#chat-send {
  font-family: 'Press Start 2P', monospace; font-size: 8px;
  background: rgba(0,229,255,0.1); border: 1px solid #0a4060;
  color: #00e5ff; padding: 0 10px; cursor: pointer; transition: all .1s;
}
#chat-send:hover { background: #00e5ff; color: #000; }

/* ── Status bar ────────────────────────────────────────────────────────────── */
#chat-status-bar {
  display: flex; justify-content: space-between;
  padding: 3px 8px; font-size: 5px;
  background: rgba(0,3,10,0.9); flex-shrink: 0;
  border-top: 1px solid #040e1e;
}
#chat-agent-status { color: #0a4060; }
#chat-gateway-status { color: #ff5555; }

/* ── Log view ──────────────────────────────────────────────────────────────── */
.chat-log-view { gap: 0 !important; }
.chat-log-row {
  padding: 5px 8px; border-bottom: 1px solid rgba(10,40,64,0.25);
  display: flex; flex-direction: column; gap: 2px;
}
.chat-log-row:hover { background: rgba(0,30,60,0.3); }
.chat-log-who { font-size: 5px; display: flex; align-items: center; gap: 4px; }
.chat-log-arrow { color: #0a4060; }
.chat-log-type { margin-left: auto; font-size: 8px; }
.chat-log-text { font-size: 6px; color: #7ef7ff; line-height: 1.9; }

/* ── Toggle button ─────────────────────────────────────────────────────────── */
#chat-toggle {
  position: fixed; bottom: 12px; right: 140px;
  font-family: 'Press Start 2P', monospace; font-size: 6px;
  background: rgba(0,10,28,0.96); border: 1px solid #0a2840;
  color: #00a040; padding: 6px 12px; cursor: pointer;
  pointer-events: all; z-index: 51; letter-spacing: .08em; transition: all .12s;
}
#chat-toggle:hover { background: rgba(0,40,20,0.98); color: #00ff88; border-color: #00ff88; }
#chat-toggle.active { background: #00ff88; color: #000; border-color: #00ff88; }

/* ── Notification badge ────────────────────────────────────────────────────── */
#chat-toggle .chat-badge {
  display: inline-block; background: #ff5555; color: #fff;
  font-size: 5px; padding: 1px 4px; margin-left: 4px; border-radius: 2px;
  animation: jbp 1s infinite;
}
`;
  document.head.appendChild(s);
}

// ── Wire into existing systems ────────────────────────────────────────────────
// Patch agentSpeak so every speech line is also logged to the agent log
const _origAgentSpeak = agentSpeak;
window._agentSpeak_patched = true;
// Note: we override agentSpeak at module scope
const agentSpeakOrig = agentSpeak;
// redeclare is not possible in same scope; instead we wrap via the gateway event handler
// (agentSpeak calls already happen inside handleGatewayEvent which we can hook)

// Patch startMeeting to log the convo
const _origStartMeeting = startMeeting;
// Can't reassign const functions in strict mode — use a flag approach instead
// The logAgentConvo call is added directly inside startMeeting below via monkey-patch
Object.defineProperty(window, '_chatLogMeeting', {
  value: (fromId, toId, topic) => {
    logAgentConvo(fromId, toId, `Delegated: ${topic}`, 'delegation');
  },
  writable: true,
});

// Hook into handleGatewayEvent for manager replies and all speech
// We extend the existing 'agent' event handler
const _origHandleGE = handleGatewayEvent;
window.handleGatewayEvent = function(event) {
  const e = event.event, p = event.payload;

  // Capture manager replies
  if (e === 'agent' && p?.reply) {
    handleManagerReply(p.reply, p.agentId ?? 'main');
  }

  // Capture any text/content fields as manager speech
  if (e === 'agent' && (p?.content || p?.message || p?.text)) {
    const text = p.content ?? p.message ?? p.text;
    const agId = p.agentId ?? 'main';
    if (agId === 'main' || AGENTS.find(a => a.id === agId)?.hierarchyRole === 'manager') {
      logManagerSpeech(text, 'agent');
    }
  }

  // Capture inter-agent communications (delegations, collaboration signals)
  if (e === 'agent' && p?.calledBy && p?.agentId) {
    logAgentConvo(p.calledBy, p.agentId, `Delegated: ${p.tool ?? 'task'}`, 'delegation');
  }
  if (e === 'agent' && p?.collaboratingWith) {
    logAgentConvo(p.agentId ?? 'main', p.collaboratingWith, p.tool ?? 'collaboration', 'collab');
  }

  // Channel messages — log as external comms
  if (e === 'chat' && p?.text) {
    const ch = p.channel ?? p.from ?? 'channel';
    AGENT_LOG.unshift({
      ts: Date.now(), from: ch, to: 'main',
      text: p.text.slice(0, 120),
      key: convoKey(ch, 'main'), type: 'channel',
    });
    if (AGENT_LOG.length > 300) AGENT_LOG.pop();
    if (chatOpen && chatActiveTab === 'log') renderAgentLog();
  }

  // Call original
  _origHandleGE(event);
};

// Also expose wsRef setter so connectToServer can register the socket
window._setChatWs = function(ws) { wsRef = ws; };


// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN MODAL + CONFIG PANEL
// Shown on first launch (no token) or when gateway auth fails.
// Also opened by the ⚙ button for settings.
// ═══════════════════════════════════════════════════════════════════════════════

let _modalMode = 'token'; // 'token' | 'config'
let _hasToken  = false;

function openTokenModal(hint, isError = false) {
  _modalMode = 'token';
  const overlay = document.getElementById('modal-overlay');
  const tv = document.getElementById('modal-token-view');
  const cv = document.getElementById('modal-config-view');
  const errEl = document.getElementById('modal-err');
  const hintEl = document.getElementById('modal-hint-text');
  const cancelBtn = document.getElementById('modal-cancel-btn');
  if (!overlay) return;

  if (tv) tv.style.display = '';
  if (cv) cv.style.display = 'none';
  if (errEl) { errEl.textContent = hint && isError ? hint : ''; errEl.style.color = isError ? '#ff5555' : '#ffd060'; }
  if (hintEl && hint && !isError) hintEl.innerHTML = hint;
  if (cancelBtn) cancelBtn.style.display = _hasToken ? '' : 'none';

  overlay.classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-token-input')?.focus(), 80);
}

window.openConfigModal = function() {
  _modalMode = 'config';
  const overlay = document.getElementById('modal-overlay');
  const tv = document.getElementById('modal-token-view');
  const cv = document.getElementById('modal-config-view');
  if (!overlay) return;
  if (tv) tv.style.display = 'none';
  if (cv) cv.style.display = '';

  // Sync checkboxes with current settings
  const s = loadSettings();
  const el = (id) => document.getElementById(id);
  if (el('cfg-speech'))  el('cfg-speech').checked  = s.speech  !== false;
  if (el('cfg-collab'))  el('cfg-collab').checked  = s.collab  !== false;
  if (el('cfg-chatter')) el('cfg-chatter').checked = s.chatter !== false;

  overlay.classList.remove('hidden');
};

window.closeModal = function() {
  document.getElementById('modal-overlay')?.classList.add('hidden');
  document.getElementById('modal-err') && (document.getElementById('modal-err').textContent = '');
  document.getElementById('cfg-err')   && (document.getElementById('cfg-err').textContent   = '');
};

window.saveTokenFromModal = function() {
  const input = document.getElementById('modal-token-input');
  const errEl = document.getElementById('modal-err');
  const t = input?.value?.trim();
  if (!t) { if (errEl) errEl.textContent = 'Token cannot be empty.'; return; }
  if (errEl) errEl.textContent = '';
  if (errEl) { errEl.style.color = '#ffd060'; errEl.textContent = 'Connecting…'; }
  if (wsRef) wsRef.send(JSON.stringify({ type: 'save-token', token: t }));
  if (input) input.value = '';
};

window.saveTokenFromConfig = function() {
  const input = document.getElementById('cfg-token-input');
  const errEl = document.getElementById('cfg-err');
  const t = input?.value?.trim();
  if (!t) { if (errEl) errEl.textContent = 'Enter a token to replace the current one.'; return; }
  if (errEl) errEl.textContent = '';
  if (wsRef) wsRef.send(JSON.stringify({ type: 'save-token', token: t }));
  if (input) input.value = '';
  if (errEl) { errEl.style.color = '#ffd060'; errEl.textContent = 'Saving…'; }
};

window.resetToken = function() {
  if (!confirm('Clear the saved token? ClawCove will return to demo mode until a new token is entered.')) return;
  if (wsRef) wsRef.send(JSON.stringify({ type: 'clear-token' }));
  closeModal();
};

window.toggleSetting = function(key, val) {
  const s = loadSettings();
  s[key] = val;
  saveSettings(s);
  applySettings(s);
};

// ── Settings persistence (localStorage is not available; use in-memory + reload) ──
// We use window-level vars so settings survive within a session.
const _settings = { speech: true, collab: true, chatter: true };

function loadSettings() { return { ..._settings }; }
function saveSettings(s) { Object.assign(_settings, s); }
function applySettings(s) {
  // speech bubbles, collab lines, chatter controlled via flags read by draw loop
  window._showSpeech  = s.speech  !== false;
  window._showCollab  = s.collab  !== false;
  window._showChatter = s.chatter !== false;
}
applySettings(_settings);

// ── Handle server messages for token flow ─────────────────────────────────────
const _origHandleMsg = handleMsg;
window.handleMsg = function(msg) {
  if (msg.type === 'server-config') {
    _hasToken = !!msg.hasToken;
    if (!_hasToken) {
      // No token — show modal immediately after splash fades
      setTimeout(() => openTokenModal(), 400);
    }
    return;
  }

  if (msg.type === 'needs-token') {
    _hasToken = false;
    const hint = msg.error
      ? `<span style="color:#ff5555">${esc(msg.error)}</span>`
      : null;
    // Don't interrupt if config modal is open
    if (_modalMode === 'config' && !msg.error) return;
    openTokenModal(hint, !!msg.error);
    return;
  }

  if (msg.type === 'token-ok') {
    _hasToken = true;
    closeModal();
    addLog('Token accepted ✓', 'new');
    cityEvent('🔑', 'Gateway token accepted', '#00ff88');
    return;
  }

  if (msg.type === 'token-cleared') {
    _hasToken = false;
    addLog('Token cleared', 'warn');
    return;
  }

  if (msg.type === 'token-error') {
    const errEl = document.getElementById(_modalMode === 'config' ? 'cfg-err' : 'modal-err');
    if (errEl) { errEl.style.color = '#ff5555'; errEl.textContent = msg.error; }
    return;
  }

  _origHandleMsg(msg);
};

