# Ensemble — Multiplayer AI

**One-liner:** Google Docs had its multiplayer moment. Figma had its multiplayer moment. This is AI's: a live Codex agent session that a whole team (or a whole room) joins, watches, steers, comments on, and hands off — with every outcome attributed to the person who directed it.

Built for the Codex Community Hackathon (Aug 29, 2026). Stack: OpenAI Codex (headless CLI) + Runloop devboxes/tunnels + Reflex's `crew.*` event grammar.

## Components

```
[audience phones / laptops]
        │ wss + https
        ▼
┌─ session server (server/) ──────────────┐
│ Fastify + ws, in-memory state, 1 room   │
│ presence · driver token · steer queue   │
│ comments · ledger · event log w/ replay │
└──────────┬──────────────▲───────────────┘
           │ serves       │ POST /ingest  (agent events)
           ▼              │ GET  /next-task (runner polls)
    [web client (web/)]   │
                    ┌─────┴─────────────────┐
                    │ runner (runner/)      │
                    │ wraps codex exec      │
                    │ works on target-app/  │
                    └───────────────────────┘
```

Deployment: session server + web on devbox A (public tunnel = the QR URL). Runner + target-app + codex on devbox B (target-app dev server on its own tunnel = live preview). Local dev: everything runs on localhost.

## Event envelope (the shared contract — DO NOT DRIFT)

Every event, everywhere, is:

```jsonc
{
  "id": "evt_<nanoid>",
  "ts": 1788030000000,          // ms epoch, server-assigned
  "seq": 42,                     // server-assigned, monotonic
  "type": "crew.actor_post",    // see catalog
  "actor": { "id": "act_x", "name": "Sam", "kind": "human" }, // kind: human|agent|system
  "payload": { }
}
```

### Event catalog

Session/presence:
- `actor.joined` {name, kind} · `actor.left` {} · `driver.changed` {toActorId}

Human participation (Reflex crew grammar — keep these exact names):
- `crew.actor_post` {text} — a human steer/instruction posted into the session
- `crew.task_dispatched` {taskId, text, byActorId} — steer accepted into agent queue
- `crew.task_completed` {taskId, tokens, costUsd} / `crew.task_failed` {taskId, reason}
- `crew.gate_requested` {gateId, question, taskId} — agent/system asks a human to decide
- `crew.gate_resolved` {gateId, approved, byActorId}
- `crew.result_published` {taskId, summary, diffStat}

Agent activity (mapped from `codex exec --json` items):
- `agent.turn_started` {taskId} · `agent.turn_completed` {taskId, tokens, costUsd}
- `agent.thought` {text} — reasoning summaries
- `agent.command` {command, exitCode?} — shell commands the agent runs
- `agent.diff` {file, patch} — file changes (unified diff text)
- `agent.message` {text} — agent's final message for a turn

Collaboration:
- `comment.created` {commentId, anchor: {file?, eventId?}, text}
- `comment.resolved` {commentId, byActorId, viaTaskId?}
- `ledger.updated` {rows: [{actorId, name, steers, tokens, costUsd, outcomes: [string]}]}
- `preview.updated` {url}

## Session server (server/) — Node 22, Fastify + ws, NO database (in-memory)

- `GET /` serves the built web client (static from `web/dist`). Must work same-origin over a Runloop tunnel URL (`https://{port}-{key}.tunnel.runloop.ai`) — bind 0.0.0.0, allow any origin.
- **WS `/ws`**: client sends `{type:"join", name}` → server assigns actorId, replies `{type:"welcome", actorId, driverActorId, events:[...full log...]}` then streams `{type:"event", event}` live. Client→server messages: `{type:"steer", text}`, `{type:"comment", anchor, text}`, `{type:"resolveGate", gateId, approved}`, `{type:"handoff", toActorId}` (driver only), `{type:"interrupt"}` (driver only). Heartbeat ping/pong every 15s; drop → `actor.left`.
- **Steer arbitration:** any human's steer → `crew.actor_post` immediately. Driver's steers auto-dispatch (`crew.task_dispatched`, FIFO queue). Non-driver steers open `crew.gate_requested` (question: "Sam wants: …dispatch?") for the driver; approve → dispatched, attributed to the original author.
- **Runner API** (plain HTTP, shared-secret header `x-ensemble-key`):
  - `GET /runner/next-task` → 204 or `{taskId, text, authorName}` (marks started, emits `agent.turn_started`)
  - `POST /runner/events` → body = array of agent.* / crew.* events (server assigns id/ts/seq, fills actor as the agent)
  - `POST /runner/interrupted` → clears current task back to queue
- **Ledger:** on every `agent.turn_completed`, attribute tokens/cost to the task's author; on `crew.result_published`, append the outcome string to that author's row; emit `ledger.updated`.
- Config via env: `PORT` (default 8080), `ENSEMBLE_KEY`.

## Runner (runner/) — Node 22 script, wraps codex CLI

- Loop: poll `GET /runner/next-task` every 1s. On task: run codex on `target-app/`:
  - First task: `codex exec --json --sandbox danger-full-access --skip-git-repo-check -C <targetDir> "<prompt>"`
  - Later tasks: `codex exec resume --last --json ... "<prompt>"` (same session = shared context).
  - Prompt template: `[Directed by ${authorName} in a live multiplayer session] ${text}. Keep changes small and immediately visible in the running app. Do not restart the dev server; it hot-reloads.`
- Parse stdout JSONL → map to `agent.*` events → POST to `/runner/events` in small batches (≤500ms buffer). Map: reasoning→`agent.thought`, command execution→`agent.command`, file change/apply_patch→`agent.diff`, agent message→`agent.message`, `turn.completed` token usage→`agent.turn_completed` {tokens, costUsd≈tokens*3e-6}. On success also emit `crew.result_published` (summary = first line of agent message, diffStat from diffs) and `crew.task_completed`.
- `POST /runner/interrupt` from server (runner exposes tiny HTTP on :8091): SIGKILL the codex child, report `/runner/interrupted`. Resume still works via `codex exec resume --last`.
- Env: `SERVER_URL`, `ENSEMBLE_KEY`, `TARGET_DIR`.

## Web client (web/) — Vite + React + TS, mobile-first

Single page, dark theme, feels like mission control meets Figma. Layout:
- **Stage view (desktop/projector):** header = session name + presence avatars (initials, colored) + driver badge; left 60% = live timeline (the agent's stream: thoughts collapsed, commands as terminal lines, diffs as collapsible code blocks, agent messages as cards; every crew.actor_post inline with the author's avatar — the "living document"); right 40% = live app preview iframe (`preview.updated` url) on top, steer composer + task queue + gates below; footer strip = **ledger** (per-person: steers · tokens · $ · outcomes).
- **Phone view (<768px):** presence + timeline + composer; queue/gates as sheets.
- Interactions: steer composer (anyone); gate cards with Approve/Dismiss (driver); handoff via tapping a presence avatar (driver); Interrupt button (driver, red); comment = long-press/click a diff or agent message → pin note → `comment.created`; resolved comments get a green check.
- Join flow: `/?name=` prefill; else name prompt. Show a QR of the current URL in the header (tiny lib or inline canvas QR).
- Reconnect logic: on WS drop, retry w/ backoff, re-join with same name, dedupe via seq.
- Polish bar: this is demoed on a projector to a jury. Space is precious; typography must be crisp; live events should *animate in*. No lorem ipsum anywhere.

## Target app (target-app/) — the thing the agent builds live

Tiny Vite+React app, deliberately minimal seed: "**Roomboard** — a shared wall for the room" (title bar + empty board). The demo's steers will add: sticky notes, colors, dark mode, vote buttons, confetti — small, instantly visible changes. Dev server on :5173, `--host 0.0.0.0`, hot reload. Nothing fancy; it exists to be transformed live.

## Non-goals (today)

Auth, persistence, multiple rooms, scaling. In-memory + one room + shared-secret is correct for a 6-hour build.
