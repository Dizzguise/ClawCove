# ⚡ The Grid (formerly ClawCove)

> A digital AI operations headquarters interface, evolving from ClawCove into **The Grid** by CK Ops.

> **Project direction update:** The Grid is a lightweight multi-agent operations platform (Python core + Node visual layer) with first-class visual orchestration. See `docs/PLATFORM_VISION.md` and `docs/THE_GRID_MASTER_PLAN.md`.

Your OpenClaw agents become lobster sprites swimming through a bioluminescent coral city. Buildings represent real system components — Gateway Spire, agent grottos, cron tower, channel coral, skills reef. Everything is generated from your live gateway state and updates in real time as your agents work.

![ClawCove screenshot](https://raw.githubusercontent.com/your-org/clawcove/main/docs/screenshot.png)

---

## Quick start

You need [Node.js 18+](https://nodejs.org) and a running OpenClaw gateway.

```bash
# Clone and install
git clone https://github.com/your-org/clawcove
cd clawcove
npm install

# Run
npm start
```

ClawCove will:
1. Find your `~/.openclaw/openclaw.json` automatically
2. Connect to your gateway as a read-only observer
3. Open `http://127.0.0.1:2788` in your browser
4. Generate your city from live gateway state
5. Stream live events (agent runs, cron jobs, chat) into the visualization

That's it. No config. No changes to OpenClaw needed.

---

## How it works

```
Browser → ws://127.0.0.1:2788/ws → ClawCove server → ws://127.0.0.1:18789 (OpenClaw)
```

ClawCove runs a tiny local server that proxies your gateway WebSocket. The browser never touches the gateway directly — the server handles auth, discovery, and event streaming. Zero CORS issues, token never exposed to the browser.

On first run, ClawCove queries your gateway for:
- `sessions.list` → agent grottos sized by session count and token usage
- `cron.list` → tide clock tower with one hand per job
- `channels.status` → signal coral branches per active channel
- `skills.list` → clawhub reef spikes per installed skill
- `node.list` → node dock with one creature per connected device
- `config.get` → building shapes (model tier, sandbox mode, etc.)
- `health` + `system-presence` → gateway spire status and glow

The resulting city layout is saved to `~/.openclaw/workspace/clawcove/layout.json`. On subsequent runs, building positions are preserved, new buildings appear, and removed buildings slowly sink into the ocean floor.

---

## City layout

| Building | Appears when | Scales with |
|----------|-------------|-------------|
| **Gateway Spire** | Always | Uptime, active sessions |
| **Agent Grottos** | One per agent in config | Model tier (Opus=large, Sonnet=medium, Haiku=small) |
| **Memory Vault** | Always | Session count, total tokens |
| **Tide Clock** | Any cron jobs configured | Job count (tower height) |
| **Signal Coral** | Any channels enabled | Channel count (coral branches) |
| **ClawHub Reef** | Any skills installed | Skill count (coral spikes) |
| **Node Dock** | Any nodes connected | Node count |
| **Lens Cave** | Browser tool enabled | — |

---

## Live events

| Gateway event | City effect |
|--------------|-------------|
| `agent` started | Sprite runs to building, glows |
| `agent` complete | Sprite returns home |
| `cron` fired | Cleo runs to clock tower |
| `chat` inbound | Speech bubble on channel coral |
| `health` update | Spire color changes |
| `presence` joined | New sprite spawns |
| `presence` left | Sprite fades out |

---

## Options

```bash
# Different port
CLAWCOVE_PORT=3000 npm start

# Don't auto-open browser
CLAWCOVE_NO_OPEN=1 npm start

# Point at a specific OpenClaw config
OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json npm start

# Point at a remote gateway (via SSH tunnel)
# ssh -N -L 18789:127.0.0.1:18789 user@yourserver
# then: npm start  (it'll find port 18789 on localhost)
```

---

## Controls

- **Drag** — pan the ocean
- **Click agent** — inspect: model, session, current task, tokens
- **Click building** — inspect: details, cron jobs, channels, agents inside
- **Speed buttons** — ½x / 1x / 2x / 4x simulation speed
- **Minimap** — bottom-right, shows all agents and buildings

---

## Troubleshooting

**"No ~/.openclaw/openclaw.json found"**
OpenClaw isn't installed or hasn't been configured yet. Run `openclaw onboard` first.

**"Gateway not reachable"**
OpenClaw gateway isn't running. Start it with `openclaw gateway` or check `openclaw gateway status`.

**"Gateway rejected connect: unauthorized"**
Your gateway has auth configured but ClawCove couldn't find the token. Make sure `gateway.auth.token` is set in your `~/.openclaw/openclaw.json`. ClawCove reads it automatically.

**City looks wrong / missing buildings**
Delete `~/.openclaw/workspace/clawcove/layout.json` to regenerate from scratch.

---

## What ClawCove does NOT do

- Write anything to your gateway or config (read-only observer)
- Require any changes to OpenClaw
- Expose your gateway token to the browser
- Need any account, API key, or internet connection

---

## Separate from OpenClaw

ClawCove is a completely independent project. It connects to OpenClaw the same way the CLI or Control UI does — as a WebSocket client. No PRs, no forks, no changes to OpenClaw required.

---

## License

MIT
