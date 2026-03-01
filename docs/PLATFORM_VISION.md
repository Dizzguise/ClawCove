# ClawCove Platform Vision (Phase Shift)

This project is evolving from a visualizer into a lightweight multi-agent runtime + city UI.

## Product Goal
A small, opinionated alternative to OpenClaw-style orchestration, with:
- native multi-agent collaboration,
- visible in-world execution,
- simple setup for common channels/providers,
- strong per-agent identity + memory separation.

## Core Difference
OpenClaw-like capabilities, but **narrower scope** and **first-class visual realism**.

## Required Integrations (from day one)
- Channels: Telegram, Discord, Twilio
- LLM providers: OpenAI (OAuth/API), Anthropic, Ollama
- Voice: ElevenLabs, Kokoro
- STT: Whisper cloud + local faster-whisper

## UX Principle
All config should be manageable in Cove’s dashboard/config menu.
No hidden CLI-only setup for normal users.

## World Simulation Rules
1. Transport/mechanics events are handled by neutral world workers (mailman, etc.).
2. Decision/execution events are handled by real agents (Alfred, Barbara, Ace, etc.).
3. Movement must reflect intent and delegation paths.
4. Agent collaboration is explicit and visible.

## Agent System Rules
- Manager orchestrates and reviews.
- Specialists execute scoped tasks.
- Permanent specialists for recurring roles.
- Temporary workers for one-off bursts.
- Per-agent memory boundaries by default.

## Skin System
- Keep existing lobster skin.
- Add Batman skin pack.
- Architecture should allow additional skin packs later.

## Implementation Phases

### Phase A — Correctness Baseline
- Canonical state model
- Intent router (transport vs decision vs execution)
- Accurate actor attribution (no false main-agent activation)

### Phase B — Runtime Foundation
- Native session/agent orchestration backend
- Agent-to-agent messaging contracts
- Task state machine (`received -> triaged -> delegated -> executing -> reviewed -> replied -> archived`)

### Phase C — Integrations & Config UX
- Built-in provider/channel adapters
- Cove dashboard config flow
- Profile presets + quickstart wizards

### Phase D — Skins & Educational Layer
- Lobster + Batman skins
- Action overlays and readable choreography
- Optional explain-mode for teaching agentic patterns

## Non-goals (for now)
- Full parity with all OpenClaw features
- Enterprise policy surface
- Complex plugin marketplace at v1
