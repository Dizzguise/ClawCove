// lib/worldgen.js
// Converts OpenClaw gateway state into a Clawville city layout.
// Deterministic given the same input — same gateway, same city.
// Supports incremental updates: new buildings added, removed ones decay.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ── Deterministic hash → color ────────────────────────────────────────────────
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

function agentColor(id) {
  const h = hashStr(id);
  const hue = h % 360;
  const sat = 60 + (h >> 8) % 30;
  const lit = 45 + (h >> 16) % 20;
  return { hue, sat, lit, css: `hsl(${hue},${sat}%,${lit}%)` };
}

// ── Model → size tier ─────────────────────────────────────────────────────────
function modelTier(model = '') {
  if (model.includes('opus'))   return 'large';
  if (model.includes('sonnet')) return 'medium';
  if (model.includes('haiku'))  return 'small';
  if (model.includes('gpt-4'))  return 'large';
  if (model.includes('gemini')) return 'medium';
  return 'small';
}

const TIER_SIZE = { large: { w: 9, h: 10 }, medium: { w: 8, h: 8 }, small: { w: 7, h: 7 } };

// ── Channel → color ───────────────────────────────────────────────────────────
const CHANNEL_COLORS = {
  whatsapp:  '#00e5a0',
  telegram:  '#44aaff',
  discord:   '#9b5fff',
  slack:     '#ff6b35',
  signal:    '#2090ff',
  imessage:  '#00aaff',
  matrix:    '#00cc88',
  msteams:   '#6264a7',
  zalo:      '#0068ff',
  webchat:   '#ff88cc',
};

// ── Layout zones (tile coordinates) ──────────────────────────────────────────
// Map is 80×56 tiles. Buildings placed in named zones.
const ZONES = {
  center:    { cx: 39, cy: 27 },
  northwest: [{ cx: 20, cy: 18 }, { cx: 12, cy: 22 }, { cx: 28, cy: 14 }],
  northeast: [{ cx: 60, cy: 18 }, { cx: 68, cy: 22 }, { cx: 53, cy: 14 }],
  southwest: [{ cx: 20, cy: 38 }, { cx: 12, cy: 44 }, { cx: 28, cy: 44 }],
  southeast: [{ cx: 60, cy: 38 }, { cx: 68, cy: 44 }, { cx: 53, cy: 44 }],
  south:     [{ cx: 39, cy: 47 }, { cx: 32, cy: 47 }, { cx: 46, cy: 47 }],
};

function placeAt(cx, cy, w, h) {
  return { x: cx - Math.floor(w/2), y: cy - Math.floor(h/2), w, h };
}

// ── Main world gen ────────────────────────────────────────────────────────────
export function generateWorld(state) {
  const { helloOk, discovered } = state;
  const cfg = discovered?.config?.config ?? {};
  const agentsCfg = cfg?.agents?.list ?? cfg?.agents ?? [];
  const sessionsList = discovered?.sessions?.sessions ?? [];
  const cronJobs = discovered?.cron?.jobs ?? [];
  const channelsStatus = discovered?.channels ?? {};
  const skillsList = discovered?.skills?.skills ?? [];
  const nodesList = discovered?.nodes?.nodes ?? [];
  const health = discovered?.health ?? helloOk?.snapshot?.health ?? {};
  const uptime = helloOk?.snapshot?.uptimeMs ?? 0;

  const buildings = [];
  const agents = [];

  // ── GATEWAY SPIRE (always) ─────────────────────────────────────────────────
  const activeSessions = sessionsList.filter(s => s.contextTokens > 0).length;
  const spireH = Math.min(14, 8 + Math.floor(activeSessions / 2));
  buildings.push({
    id: 'gateway',
    kind: 'gateway',
    name: 'The Spire',
    label: 'GATEWAY SPIRE',
    ...placeAt(ZONES.center.cx, ZONES.center.cy, 8, spireH),
    accent: '#00e5ff',
    wall: '#041428',
    roof: '#021020',
    details: {
      url: `ws://127.0.0.1:${cfg?.gateway?.port ?? 18789}`,
      uptime: formatUptime(uptime),
      sessions: activeSessions,
      status: health?.status ?? 'unknown',
    },
    activities: ['Routing RPC…','Broadcasting presence…','Health ping OK','Syncing config…'],
    shape: 'tower',
  });

  // ── AGENT GROTTOS (one per configured agent) ───────────────────────────────
  const agentDefs = agentsCfg.length > 0 ? agentsCfg : [{ id: 'main' }];
  const agentZones = [
    ...ZONES.northwest,
    ...ZONES.northeast,
    { cx: 20, cy: 27 },
    { cx: 58, cy: 27 },
  ];

  agentDefs.forEach((agDef, i) => {
    const agId = agDef.id ?? `agent-${i}`;
    const model = agDef.model ?? cfg?.agents?.defaults?.model ?? 'claude-sonnet-4-6';
    const tier = modelTier(model);
    const size = TIER_SIZE[tier];
    const color = agentColor(agId);
    const zone = agentZones[i % agentZones.length];
    const isMain = agId === 'main';

    // Find live session for this agent
    const session = sessionsList.find(s => s.agentId === agId || (isMain && s.sessionKey?.includes(':main:')));
    const tokens = session?.contextTokens ?? 0;

    buildings.push({
      id: `agent-${agId}`,
      kind: 'agent',
      agentId: agId,
      name: isMain ? "Molty's Grotto" : `${capitalize(agId)} Reef`,
      label: isMain ? "MAIN GROTTO" : `${agId.toUpperCase()} REEF`,
      ...placeAt(zone.cx, zone.cy, size.w, size.h),
      accent: color.css,
      wall: darken(color.hue, color.sat),
      roof: darker(color.hue, color.sat),
      details: { model, tier, agentId: agId, tokens: `${Math.round(tokens/1000)}k` },
      activities: ['Planning actions…','Running tool…','Reflecting…','Composing reply…'],
    });

    // Spawn a lobster agent sprite
    agents.push({
      id: agId,
      name: isMain ? 'Molty' : capitalize(agId),
      role: isMain ? 'Main Agent' : `${capitalize(agId)} Agent`,
      homeBuilding: `agent-${agId}`,
      color: color.css,
      colorHue: color.hue,
      model,
      tier,
      startX: zone.cx,
      startY: zone.cy + size.h + 2,
      session: session ?? null,
    });
  });

  // ── MEMORY VAULT (always, size scales with sessions) ──────────────────────
  const totalTokens = sessionsList.reduce((a, s) => a + (s.contextTokens ?? 0), 0);
  const vaultSize = sessionsList.length > 10 ? { w: 10, h: 9 } : { w: 9, h: 8 };
  buildings.push({
    id: 'db',
    kind: 'database',
    name: 'Memory Vault',
    label: 'MEMORY VAULT',
    ...placeAt(ZONES.south[0].cx, ZONES.south[0].cy, vaultSize.w, vaultSize.h),
    accent: '#ffd060',
    wall: '#181000',
    roof: '#0e0a00',
    details: {
      sessions: sessionsList.length,
      totalTokens: `${Math.round(totalTokens/1000)}k`,
      engine: 'SQLite+JSON',
    },
    activities: ['Writing memory…','Pruning old context…','Indexing…','Reading session…'],
  });

  // ── CRON TOWER (if jobs exist) ────────────────────────────────────────────
  if (cronJobs.length > 0) {
    const towerH = Math.min(12, 7 + cronJobs.length);
    buildings.push({
      id: 'cron',
      kind: 'cron',
      name: 'Tide Clock',
      label: 'TIDE CLOCK',
      ...placeAt(ZONES.south[1].cx, ZONES.south[1].cy, 7, towerH),
      accent: '#cc88ff',
      wall: '#0e0418',
      roof: '#070010',
      details: {
        jobs: cronJobs.length,
        enabled: cronJobs.filter(j => j.enabled !== false).length,
        next: cronJobs[0]?.schedule ?? '—',
      },
      activities: ['Checking schedule…','Firing job…','Health check…','Gmail Pub/Sub…'],
      shape: 'tower',
      cronJobs: cronJobs.map(j => ({
        id: j.id,
        schedule: j.schedule,
        enabled: j.enabled !== false,
        label: j.label ?? j.id,
      })),
    });

    // Cleo - cron worker sprite
    agents.push({
      id: 'cleo',
      name: 'Cleo',
      role: 'Cron Worker',
      homeBuilding: 'cron',
      color: '#ffd060',
      colorHue: 45,
      model: 'cron',
      tier: 'small',
      startX: ZONES.south[1].cx + 4,
      startY: ZONES.south[1].cy + 4,
      session: null,
    });
  }

  // ── CHANNEL CORAL (if channels active) ────────────────────────────────────
  const activeChannels = getActiveChannels(channelsStatus, cfg);
  if (activeChannels.length > 0) {
    buildings.push({
      id: 'channels',
      kind: 'channels',
      name: 'Signal Coral',
      label: 'SIGNAL CORAL',
      ...placeAt(ZONES.northeast[0].cx + 8, ZONES.northeast[0].cy + 10, 9, 7),
      accent: '#ff88cc',
      wall: '#180408',
      roof: '#0e0205',
      details: {
        active: activeChannels.length,
        channels: activeChannels.map(c => c.id).join(', '),
      },
      activities: activeChannels.map(c => `${capitalize(c.id)} msg in…`),
      channels: activeChannels,
    });

    // One agent sprite per channel that has a dedicated agent
    const channelAgents = agentDefs.filter(a =>
      a.id !== 'main' &&
      activeChannels.some(c => a.id?.includes(c.id) || c.agentId === a.id)
    );
    // Channel agents already handled via agentDefs loop above
  }

  // ── SKILLS REEF (if skills installed) ─────────────────────────────────────
  if (skillsList.length > 0) {
    buildings.push({
      id: 'skills',
      kind: 'skills',
      name: 'ClawHub Reef',
      label: 'CLAWHUB REEF',
      ...placeAt(ZONES.southwest[0].cx, ZONES.southwest[0].cy, 8, 7),
      accent: '#00ff88',
      wall: '#041810',
      roof: '#020e06',
      details: {
        installed: skillsList.length,
        skills: skillsList.slice(0,4).map(s => s.id ?? s.name).join(', '),
      },
      activities: skillsList.map(s => `Loading ${s.id ?? s.name}…`).slice(0, 4),
      skills: skillsList,
    });
  }

  // ── NODE DOCK (if nodes connected) ────────────────────────────────────────
  if (nodesList.length > 0) {
    buildings.push({
      id: 'nodes',
      kind: 'nodes',
      name: 'Node Dock',
      label: 'NODE DOCK',
      ...placeAt(ZONES.southwest[1].cx, ZONES.southwest[1].cy, 8, 7),
      accent: '#44ddff',
      wall: '#041820',
      roof: '#020e14',
      details: {
        connected: nodesList.length,
        types: [...new Set(nodesList.map(n => n.deviceFamily ?? 'node'))].join(', '),
      },
      activities: nodesList.map(n => `${n.displayName ?? 'Node'} online…`).slice(0, 4),
      nodes: nodesList,
    });
  }

  // ── BROWSER CAVE (if browser tool configured) ─────────────────────────────
  const browserEnabled = cfg?.tools?.browser?.enabled !== false &&
    agentDefs.some(a => (a.tools ?? cfg?.agents?.defaults?.tools ?? [])
      .some?.(t => typeof t === 'string' ? t.includes('browser') : t?.name?.includes('browser')));

  if (browserEnabled || cfg?.tools?.browser) {
    buildings.push({
      id: 'browser',
      kind: 'tool',
      name: 'Lens Cave',
      label: 'LENS CAVE',
      ...placeAt(ZONES.southeast[1].cx, ZONES.southeast[1].cy, 8, 7),
      accent: '#44aaff',
      wall: '#041420',
      roof: '#020c14',
      details: { engine: 'Chrome/CDP', status: 'standby' },
      activities: ['Taking snapshot…','Clicking element…','Navigating URL…','Extracting data…'],
    });
  }

  return {
    version: 1,
    generatedAt: Date.now(),
    buildings,
    agents,
    meta: {
      agentCount: agentDefs.length,
      sessionCount: sessionsList.length,
      cronJobCount: cronJobs.length,
      channelCount: activeChannels.length,
      skillCount: skillsList.length,
      nodeCount: nodesList.length,
      gatewayUptime: uptime,
      health: health?.status ?? 'unknown',
    },
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────
export function loadSavedLayout(clawvilleDir) {
  const p = join(clawvilleDir, 'layout.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function saveLayout(clawvilleDir, layout) {
  try {
    mkdirSync(clawvilleDir, { recursive: true });
    writeFileSync(join(clawvilleDir, 'layout.json'), JSON.stringify(layout, null, 2));
  } catch (e) {
    console.warn('[clawville] could not save layout:', e.message);
  }
}

// Merge new layout with saved layout: preserve positions, add new buildings, mark removed
export function mergeLayouts(saved, fresh) {
  if (!saved) return fresh;

  const merged = { ...fresh };
  const freshIds = new Set(fresh.buildings.map(b => b.id));
  const savedById = Object.fromEntries(saved.buildings.map(b => [b.id, b]));

  merged.buildings = fresh.buildings.map(b => {
    const old = savedById[b.id];
    if (old && old.x !== undefined) {
      // Preserve position from saved layout
      return { ...b, x: old.x, y: old.y };
    }
    return b;
  });

  // Add decay markers for removed buildings
  const removedBuildings = saved.buildings
    .filter(b => !freshIds.has(b.id))
    .map(b => ({ ...b, decaying: true, decayStart: Date.now() }));

  merged.buildings = [...merged.buildings, ...removedBuildings];
  return merged;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getActiveChannels(channelsStatus, cfg) {
  const active = [];
  const knownChannels = [
    'whatsapp','telegram','discord','slack','signal','imessage',
    'matrix','msteams','zalo','webchat',
  ];

  // From channels.status response
  if (channelsStatus?.channels) {
    for (const [id, info] of Object.entries(channelsStatus.channels)) {
      if (info?.enabled || info?.linked || info?.status === 'linked') {
        active.push({ id, color: CHANNEL_COLORS[id] ?? '#aaaaaa', ...info });
      }
    }
    return active;
  }

  // Fall back to config
  for (const ch of knownChannels) {
    const chCfg = cfg?.channels?.[ch];
    if (chCfg && chCfg.enabled !== false) {
      active.push({ id: ch, color: CHANNEL_COLORS[ch] ?? '#aaaaaa' });
    }
  }
  return active;
}

function formatUptime(ms) {
  if (!ms) return 'unknown';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h%24}h`;
  if (h > 0) return `${h}h ${m%60}m`;
  return `${m}m`;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function darken(hue, sat) {
  return `hsl(${hue},${sat}%,12%)`;
}

function darker(hue, sat) {
  return `hsl(${hue},${sat}%,8%)`;
}
