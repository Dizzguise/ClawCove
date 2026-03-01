// lib/state-model.js
// Canonical state normalization for deterministic rendering/polling.

export function normalizeDiscoveredState(input = {}) {
  const discovered = input?.discovered ?? input;
  const cfg = discovered?.config?.config ?? {};

  const agents = normalizeAgents(cfg?.agents);
  const sessions = normalizeSessions(discovered?.sessions?.sessions ?? []);
  const cronJobs = (discovered?.cron?.jobs ?? []).filter(Boolean);
  const channels = discovered?.channels?.channels ?? {};
  const skills = discovered?.skills?.skills ?? [];
  const nodes = discovered?.nodes?.nodes ?? [];
  const health = discovered?.health ?? input?.helloOk?.snapshot?.health ?? {};

  return {
    cfg,
    agents,
    sessions,
    cronJobs,
    channels,
    skills,
    nodes,
    health,
    discovered,
  };
}

export function normalizeAgents(agentsCfg) {
  if (Array.isArray(agentsCfg?.list)) return agentsCfg.list.filter(a => a?.id);
  if (Array.isArray(agentsCfg)) return agentsCfg.filter(a => a?.id);
  return [{ id: 'main', default: true, name: 'main' }];
}

export function detectManagerAgentId(agents = []) {
  const explicit = agents.find(a => a?.default === true || a?.isDefault === true);
  return explicit?.id ?? agents[0]?.id ?? 'main';
}

export function normalizeSessions(list) {
  return (list ?? []).filter(Boolean).map(s => {
    const parsedAgentId = parseAgentIdFromSessionKey(s?.sessionKey);
    return {
      ...s,
      parsedAgentId,
      agentId: s?.agentId ?? parsedAgentId ?? 'main',
      contextTokens: Number(s?.contextTokens ?? 0),
    };
  });
}

export function parseAgentIdFromSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== 'string') return null;
  const m = /^agent:([^:]+):/.exec(sessionKey);
  return m?.[1] ?? null;
}
