// lib/config.js
// Reads ~/.openclaw/openclaw.json (or OPENCLAW_CONFIG_PATH) to extract
// the gateway port and token. Zero user configuration required.

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// JSON5-ish: strip // and /* */ comments, trailing commas
function parseJSON5(text) {
  // Fast path for strict JSON (avoids damaging URLs like http://...)
  try { return JSON.parse(text); } catch {}

  // Fallback tolerant parse for JSON5-ish content
  // Remove // line comments (not inside strings)
  let s = text.replace(/\/\/[^\n]*/g, '');
  // Remove /* */ block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(s);
}

function tryRead(p) {
  try {
    if (existsSync(p)) return parseJSON5(readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

export function loadOpenclawConfig() {
  const candidates = [
    process.env.OPENCLAW_CONFIG_PATH,
    join(homedir(), '.openclaw', 'openclaw.json'),
    join(homedir(), '.openclaw', 'openclaw.json5'),
    // common alternative profiles
    join(homedir(), '.openclaw-dev', 'openclaw.json'),
    join(homedir(), '.openclaw-beta', 'openclaw.json'),
  ].filter(Boolean);

  let raw = null;
  let foundPath = null;

  for (const p of candidates) {
    raw = tryRead(p);
    if (raw) { foundPath = p; break; }
  }

  if (!raw) {
    return {
      found: false,
      error: 'No ~/.openclaw/openclaw.json found. Is OpenClaw installed and configured?',
      gatewayUrl: 'ws://127.0.0.1:18789',
      token: null,
      stateDir: join(homedir(), '.openclaw'),
    };
  }

  const port = raw?.gateway?.port ?? 18789;
  const token = raw?.gateway?.auth?.token
    ?? process.env.OPENCLAW_GATEWAY_TOKEN
    ?? null;

  // State dir for persisting clawcove layout
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw');

  return {
    found: true,
    configPath: foundPath,
    gatewayUrl: `ws://127.0.0.1:${port}`,
    gatewayHttpUrl: `http://127.0.0.1:${port}`,
    port,
    token,
    stateDir,
    clawcoveDir: join(stateDir, 'workspace', 'clawcove'),
    raw,
  };
}
