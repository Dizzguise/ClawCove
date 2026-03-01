# THE GRID — Master Plan

## New Product Identity
- **Product UI/System name:** The Grid
- **Company:** CK Ops (CK Operations)
- **Tagline:** Enter the Grid

## Positioning
CK Ops is a **private AI operations headquarters**.
It is not a chatbot, not a framework, and not an orchestration toolkit.
It is operational staff, digitally embodied.

## Target Users
- Solo founders
- Lawyers
- Consultants
- SMB operators
- High-leverage individuals
- Technical operators

## Core Outcomes
- Delegates tasks across autonomous agents
- Manages email/comms/git/web automation
- Runs scheduled operations continuously
- Maintains persistent specialized roles
- Spins up temporary task forces for one-off objectives
- Operates live systems with auditability

---

## System Architecture (Python + Node)

### 1) Core Runtime (Python)
Purpose: orchestration brain and operations engine.

Owns:
- agent/session lifecycle
- role-based delegation
- task state machine
- memory isolation boundaries
- channel/provider adapters
- policy and audit logs

### 2) Visual Layer (Node + frontend)
Purpose: live command experience (The Grid).

Owns:
- world rendering
- skin/theme packs
- control/config UX
- event stream visualization
- Ops Board surface

### 3) Bridge Contract (WebSocket + REST)
Purpose: deterministic event semantics.

Canonical event classes:
- `transport` (mail, message ingress, delivery)
- `decision` (triage, delegate, escalate, approve)
- `execution` (tool/provider run)
- `system` (health, auth, reconnect, schedule pulse)

---

## Visual Doctrine

### Core Visual Identity
- Digital operations headquarters
- Dark matte surfaces
- Soft neon accents (cyan/electric blue/subtle red)
- Glass panels and floating panes
- Light trails between agents
- Data pulses instead of spinner-heavy loading
- Minimal typography
- Clean geometry, not cyberpunk clutter
- Motion: intentional, restrained, tactical

### Feel
- Private control room
- Focused, not chaotic
- Tactical, not rebellious
- You are inside your command layer, not a dashboard

---

## The Grid Spatial Model
- Top-down or sectional HQ layout
- Agents represented as nodes/avatars
- Delegation rendered as light-path links
- Rooms/elevators represent abstraction layers
- Active status glow around executing agents
- Meeting room = multi-agent deliberation
- Ops Board = active execution surface
- Cron/automation = timeline rail pulse events

---

## Agent Model
- Persistent named agents with custom identities
- Strict memory separation by default
- Explicit handoff envelopes between agents
- Specialist-first assignment
- Temp workers for burst projects

Task state machine:
`received -> triaged -> delegated -> executing -> reviewed -> replied -> archived`

---

## Integration Set (v1)
Channels:
- Telegram
- Discord
- Twilio

LLM:
- OpenAI (OAuth/API)
- Anthropic
- Ollama

Voice/STT:
- ElevenLabs
- Kokoro
- Whisper cloud
- Whisper/faster-whisper local

---

## Migration Strategy from current codebase
Current repo remains baseline for transition.

Phases:
1. Branding + nomenclature shift (ClawCove -> The Grid in docs/UI copy)
2. Runtime split (Python core + Node visual)
3. Contract-first event bus
4. Config-first UX in Grid console
5. Skin system (Lobster + Batman initial packs)

---

## Immediate Build Plan (Execution)

### Phase 0 — Foundation docs/specs
- finalize event schema
- finalize agent/runtime boundaries
- finalize config schema (single source)

### Phase 1 — Python core scaffold
- `grid_core/` service
- agent registry
- session manager
- task queue + state machine
- adapter stubs (Telegram/Discord/Twilio/OpenAI/Anthropic/Ollama)

### Phase 2 — Node visual refit
- replace ClawCove copy with The Grid
- install Ops Board semantics
- strict intent-first actor rendering

### Phase 3 — Memory and policy
- per-agent memory stores
- handoff envelopes with citations/provenance
- audit trail + replay

### Phase 4 — Operator UX
- in-UI configuration and profile presets
- provider/channel setup flows
- health diagnostics and timeline

