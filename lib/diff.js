// lib/diff.js
// Compares two snapshots of gateway state and emits typed change events.
// Each change event is: { type, action, id, prev, next, ts }

export function diffState(prev, next) {
  const changes = [];
  const ts = Date.now();

  function emit(type, action, id, p, n) {
    changes.push({ type, action, id, prev: p ?? null, next: n ?? null, ts });
  }

  // ── Agents (from config.get) ──────────────────────────────────────────────
  const prevAgents = indexById(agentList(prev));
  const nextAgents = indexById(agentList(next));

  for (const [id, na] of Object.entries(nextAgents)) {
    if (!prevAgents[id]) {
      emit('agent', 'add', id, null, na);
    } else {
      const pa = prevAgents[id];
      if (modelTier(na.model) !== modelTier(pa.model)) {
        emit('agent', 'update', id, pa, na);
      }
    }
  }
  for (const [id, pa] of Object.entries(prevAgents)) {
    if (!nextAgents[id]) emit('agent', 'remove', id, pa, null);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────
  const prevSess = indexBy(sessionList(prev), 'sessionKey');
  const nextSess = indexBy(sessionList(next), 'sessionKey');

  for (const [k, ns] of Object.entries(nextSess)) {
    if (!prevSess[k]) {
      emit('session', 'add', k, null, ns);
    } else {
      const ps = prevSess[k];
      const tokenDelta = (ns.contextTokens ?? 0) - (ps.contextTokens ?? 0);
      if (Math.abs(tokenDelta) > 1000) {
        emit('session', 'update', k, ps, ns);
      }
    }
  }
  for (const [k, ps] of Object.entries(prevSess)) {
    if (!nextSess[k]) emit('session', 'remove', k, ps, null);
  }

  // ── Cron jobs ─────────────────────────────────────────────────────────────
  const prevCron = indexById(cronList(prev));
  const nextCron = indexById(cronList(next));

  for (const [id, nj] of Object.entries(nextCron)) {
    if (!prevCron[id]) {
      emit('cron', 'add', id, null, nj);
    } else {
      const pj = prevCron[id];
      if (nj.enabled !== pj.enabled || nj.schedule !== pj.schedule) {
        emit('cron', 'update', id, pj, nj);
      }
      // Track run count changes
      if ((nj.runCount ?? 0) > (pj.runCount ?? 0)) {
        emit('cron', 'ran', id, pj, nj);
      }
    }
  }
  for (const [id, pj] of Object.entries(prevCron)) {
    if (!nextCron[id]) emit('cron', 'remove', id, pj, null);
  }

  // ── Channels ──────────────────────────────────────────────────────────────
  const prevCh = channelMap(prev);
  const nextCh = channelMap(next);

  for (const [id, nc] of Object.entries(nextCh)) {
    if (!prevCh[id]) {
      emit('channel', 'add', id, null, nc);
    } else {
      const pc = prevCh[id];
      const wasLinked = pc.linked || pc.status === 'linked';
      const isLinked  = nc.linked || nc.status === 'linked';
      if (wasLinked !== isLinked) {
        emit('channel', isLinked ? 'linked' : 'unlinked', id, pc, nc);
      }
    }
  }
  for (const [id, pc] of Object.entries(prevCh)) {
    if (!nextCh[id]) emit('channel', 'remove', id, pc, null);
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  const prevSkills = indexBy(skillList(prev), s => s.id ?? s.name);
  const nextSkills = indexBy(skillList(next), s => s.id ?? s.name);

  for (const [id, ns] of Object.entries(nextSkills)) {
    if (!prevSkills[id]) emit('skill', 'add', id, null, ns);
    else if (ns.version !== prevSkills[id].version) emit('skill', 'update', id, prevSkills[id], ns);
  }
  for (const [id, ps] of Object.entries(prevSkills)) {
    if (!nextSkills[id]) emit('skill', 'remove', id, ps, null);
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const prevNodes = indexBy(nodeList(prev), n => n.id ?? n.deviceId);
  const nextNodes = indexBy(nodeList(next), n => n.id ?? n.deviceId);

  for (const [id, nn] of Object.entries(nextNodes)) {
    if (!prevNodes[id]) emit('node', 'add', id, null, nn);
  }
  for (const [id, pn] of Object.entries(prevNodes)) {
    if (!nextNodes[id]) emit('node', 'remove', id, pn, null);
  }

  // ── Health ────────────────────────────────────────────────────────────────
  const prevHealth = prev?.health?.status ?? prev?.helloOk?.snapshot?.health?.status;
  const nextHealth = next?.health?.status ?? next?.helloOk?.snapshot?.health?.status;
  if (prevHealth && nextHealth && prevHealth !== nextHealth) {
    emit('health', 'change', 'gateway', { status: prevHealth }, { status: nextHealth });
  }

  return changes;
}

// ── Accessor helpers ──────────────────────────────────────────────────────────
function agentList(state) {
  const cfg = state?.config?.config ?? state?.discovered?.config?.config ?? {};
  return cfg?.agents?.list ?? [];
}

function sessionList(state) {
  return state?.sessions?.sessions ?? state?.discovered?.sessions?.sessions ?? [];
}

function cronList(state) {
  return state?.cron?.jobs ?? state?.discovered?.cron?.jobs ?? [];
}

function skillList(state) {
  return state?.skills?.skills ?? state?.discovered?.skills?.skills ?? [];
}

function nodeList(state) {
  return state?.nodes?.nodes ?? state?.discovered?.nodes?.nodes ?? [];
}

function channelMap(state) {
  const ch = state?.channels?.channels ?? state?.discovered?.channels?.channels ?? {};
  // Also check config-based channels
  const cfg = state?.config?.config ?? state?.discovered?.config?.config ?? {};
  const cfgCh = cfg?.channels ?? {};
  const result = { ...ch };
  for (const [k, v] of Object.entries(cfgCh)) {
    if (v && v.enabled !== false && !result[k]) {
      result[k] = { enabled: true, ...v };
    }
  }
  return result;
}

function indexById(arr) {
  return indexBy(arr, x => x.id ?? x.agentId ?? x.name);
}

function indexBy(arr, keyFn) {
  if (!Array.isArray(arr)) return {};
  const fn = typeof keyFn === 'string' ? x => x[keyFn] : keyFn;
  return Object.fromEntries(arr.filter(Boolean).map(x => [fn(x), x]));
}

function modelTier(m = '') {
  if (m.includes('opus'))   return 'large';
  if (m.includes('sonnet')) return 'medium';
  return 'small';
}
