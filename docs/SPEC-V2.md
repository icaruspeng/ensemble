# Ensemble V2 — multi-task, invites, import, multi-agent

Addendum to [SPEC.md](SPEC.md). V1 contracts stay valid inside a room; V2 adds rooms around them. Anything not changed here behaves exactly as V1.

## Rooms

The server now hosts many **rooms** (a room = one task = one V1 session).

- Room record: `{roomId, name, goal, createdAt, repoUrl?, importThreadId?, agents: AgentSpec[], invites: {steer: token, view: token}, workspace: {status: "provisioning"|"ready"|"error", devboxId?, previewUrl?}}`
- `AgentSpec = {agentId, label, engine: "runner"|"reflex", model, reflexAgentId?, color}`
  - Built-in choices offered by the UI (exact ids):
    - `{agentId:"turbo", label:"Codex Turbo", engine:"runner", model:"gpt-5.3-codex-spark"}`
    - `{agentId:"deep",  label:"Codex Deep",  engine:"runner", model:"gpt-5.5"}`
    - `{agentId:"claude", label:"Claude Code", engine:"reflex", model:"claude"}` (only if server env `REFLEX_API_KEY` set AND claude-code enabled; UI hides it otherwise)
- **HTTP**: `POST /rooms` `{name, goal, agents: [agentId...], repoUrl?, importThreadId?}` → creates room, mints invite tokens, kicks off workspace provisioning, returns full room record incl. links. `GET /rooms/:roomId` → public info (no tokens unless caller has steer role). `GET /rooms` → list (id, name, status, createdAt) for the home page.
- **URLs**: web serves `/` (home) and `/s/:roomId?k=<token>` (session). Server routes any non-API GET to the SPA (history fallback).
- **WS join** gains fields: `{type:"join", roomId, name, key}` where `key` is an invite token. Role: steer token → "steerer" (may steer/comment; driver rules as V1), view token → "viewer" (watch only; server rejects steer/comment/handoff/interrupt from viewers). First steerer to join a room becomes driver.
- All V1 events are now scoped per room. `welcome` adds `{room, role}`.
- **Events added**: `room.created {name, goal}`, `workspace.status {status, detail?}` (timeline shows provisioning progress), `agent.registered {agentId, label, model}`.
- **Every agent event carries `agentId`** in payload (V1 events had one implicit agent). The server stamps `payload.agentId` using the posting runner's declared agent (see runner API) so old runner code still works.

## Steering to a specific agent

- Client steer message gains optional `agentId`: `{type:"steer", text, agentId}`. Default = first agent.
- `crew.task_dispatched` payload gains `agentId`.
- Composer UI: chip selector of the room's agents ("to: Turbo / Deep / Claude").

## Runner API (per-room, per-agent)

- Runner env gains `ROOM_ID` and `AGENTS` (JSON array of its runner-engine AgentSpecs).
- `GET /runner/next-task?roomId=...` → task now includes `agentId` and `model`.
- `POST /runner/events?roomId=...` — events must include `payload.agentId`.
- Runner maintains **one codex thread per agentId** (thread map, resume per agent). For agentId with `importThreadId` set on the room (applies to the FIRST runner agent only): the first invocation is `codex exec resume <importThreadId>` instead of a fresh exec — imported session memory.
- Repo: if room has `repoUrl`, workspace bootstrap clones it as TARGET_DIR (see provisioning); otherwise the Roomboard template is copied in.

## Workspace provisioning (hub-side, Runloop SDK)

New module `server/provision.mjs` (child of the hub process; plain fetch to Runloop REST v1 https://api.runloop.ai/v1 with `RUNLOOP_API_KEY` env):

1. `POST /devboxes` `{name: "ens-<roomId>", mounts:[{type:"agent_mount", agent_name:"codex"}], launch_parameters:{keep_alive_time_seconds: 7200}}`
2. Wait running → write `~/.codex/auth.json` (contents from hub env `CODEX_AUTH_JSON`, base64) via `POST /devboxes/{id}/write_file_contents` (or execute `mkdir -p ~/.codex && echo ... | base64 -d > ~/.codex/auth.json`).
3. Upload the runner+template bundle (baked into the hub deploy at `/home/user/app/workspace-bundle.tgz`; hub streams it via execute `curl` from hub tunnel `GET /bundle` — simplest: hub serves its own bundle file, devbox curls it).
4. If `repoUrl`: `git clone <repoUrl> target` else extract template. Start vite (`--host 0.0.0.0 --port 5173`), enable tunnel (`POST /devboxes/{id}/tunnel` per API — mirror deploy.py logic), emit `preview.updated {url, agentId?}`.
5. Start runner with `SERVER_URL=<hub public url> ROOM_ID ENSEMBLE_KEY AGENTS TARGET_DIR`.
6. Emit `workspace.status ready`. On any failure: `workspace.status error` with detail — room still usable for reflex-engine agents.
- Concurrency guard: max 2 provisioned workspaces alive; LRU-suspend older ones via Runloop API (demo safety under account caps). A "demo" room provisioned at deploy time stays pinned.

## Reflex-engine agents (hub-side adapter)

New module `server/reflex-agent.mjs`: for AgentSpec.engine === "reflex":
- Create: `POST https://reflex.runloop.ai/api/agents` `{name: "<room>-claude", agentType: "claude-code", prompt: <room goal>, authMethod: "claude-max"}` headers `Authorization: Bearer $REFLEX_API_KEY`, `x-organization-id: $REFLEX_ORG`.
- Subscribe `wss://reflex.runloop.ai/api/ws?token=...&organizationId=...`, send `{type:"subscribe", streamId}`; map their frames → our events (stamped with agentId): `turn.started→agent.turn_started`, item frames with agent message/reasoning/command → `agent.message/agent.thought/agent.command`, `turn.completed→agent.turn_completed` (usage tokens), diffs → `agent.diff` where derivable.
- Steer dispatch for this agent: `POST /agents/{id}/message {message: text}` (fall back to queue endpoint if 4xx: `POST /agents/{id}/queue`).
- If creation fails (no credential): emit `workspace.status` detail and hide the agent — never break the room.

## Web V2

- **Home page `/`**: hero line ("The multiplayer moment for AI"), task list, and the create form: name, goal, agent checkboxes (Turbo pre-checked), collapsible "Import existing project" (repo URL + optional Codex session ID), Create button → navigates to the new room's steer link.
- **Share dialog**: header "Share" button → modal with two rows: "Can steer" / "Can view", each with the full link, Copy button, and a QR toggle. Copy = `navigator.clipboard` with fallback.
- **Session page** now reads roomId+key from URL; viewer role hides composer/interrupt/handoff and shows a "view only" badge.
- **Agent lanes**: timeline items tinted per agentId (left border color) with the agent chip on each card; presence bar shows agent avatars distinct from humans (square vs round).
- Steer composer "to:" chips.
- Keep mock mode working (`/?mock=1` renders a fake room).

## Compatibility & migration

- Single-room V1 clients/runners break — that's fine, everything redeploys together. ENSEMBLE_KEY auth unchanged. Event envelope unchanged (only new payload fields).
- deploy.py V2: hub env gains `RUNLOOP_API_KEY`, `CODEX_AUTH_JSON` (base64), `REFLEX_API_KEY`, `REFLEX_ORG`; agent devbox becomes the pinned "demo" room's workspace, pre-provisioned and bound to roomId `demo`.
