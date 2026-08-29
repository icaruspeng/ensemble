# Ensemble — the multiplayer moment for AI

*Codex Community Hackathon, San Francisco — August 29, 2026*

Google Docs had its multiplayer moment. Figma had its multiplayer moment. **AI hasn't** — every agent session is a private chat box, and the best "collaboration" anyone can offer is a read-only transcript link. Meanwhile agents are taking on work that runs for hours and touches whole teams.

Ensemble makes the agent session a **shared place**: a live Codex agent working in a Runloop devbox, with a whole room of people inside the session — watching it think, steering it mid-flight, gating each other's requests, handing off control, and getting **per-person receipts** for every outcome.

> This is YC's Fall 2026 RFS ["Multiplayer AI"](https://www.ycombinator.com/rfs#multiplayer-ai), working end-to-end.

## What it does

- **Create a task** — name it, state the goal, pick your crew: *Codex Turbo* (gpt-5.3-codex-spark), *Codex Deep* (gpt-5.5), *Claude Code* (via Reflex). Each task gets its own **Runloop devbox workspace, provisioned on demand**, with a live app preview on a public tunnel URL.
- **Invite like a Google Doc** — every task mints *can-steer* and *can-view* links (the QR is just one rendering). Anyone with a steer link dispatches work directly, like an editor in a shared doc; the **driver** keeps Interrupt, task removal, and handoff (tap an avatar). Viewers watch everything — and can talk in the room's chat.
- **A living whiteboard** — every task's app starts from an interactive, signed Roomboard (add/edit/vote/delete sticky notes, each stamped with its author) that the room then reshapes through the agents, live.
- **Steer the room** — anyone's instruction flows through arbitration (`crew.gate_requested` → driver approves) to a **live Codex agent**; thoughts, commands, and diffs stream to everyone; the app hot-reloads in the shared preview. Direct any steer to a specific agent with the "to:" chips.
- **Import your solo session** — paste a repo URL and your existing Codex session ID: the agent wakes up in a fresh devbox *with the full memory of the session you started alone* — now multiplayer.
- **Receipts** — the ledger attributes every outcome: who steered, which agent, how many tokens, how many dollars, what shipped.

## How the sponsor stack is load-bearing

| | |
|---|---|
| **OpenAI Codex** | The working agents: headless `codex exec --json` / `exec resume` per agent (one persistent thread each — that's also what powers session import). And Codex **built Ensemble itself**: parallel non-interactive builder sessions, IDs in [docs/BUILT-BY-CODEX.md](docs/BUILT-BY-CODEX.md). |
| **Runloop** | Every task = a devbox provisioned on demand (micro-VM, Codex agent mount, snapshot reset, suspend economics); every preview and the app itself served over Runloop tunnels. |
| **Reflex** | The session protocol **is Reflex's published-but-unshipped `crew.*` event grammar** (`crew.actor_post`, `gate_requested`, `escalation`, `result_published`) — we built the multiplayer layer their schema promises. Reflex-engine agents (Claude Code) run through reflex.runloop.ai's control plane and stream over its WebSocket. |

## Architecture

```
phones/laptops ──wss──> hub devbox (Runloop, public tunnel)
                         Fastify session server + React client
                         rooms · roles · gates · ledger · crew.* events
                            │  provisions per-task workspaces (Runloop API)
                            ▼
                        task devbox (Runloop, Codex agent mount)
                         runner ⇄ codex exec --json (thread per agent)
                         target app + hot reload ── public tunnel preview
                        (reflex-engine agents: reflex.runloop.ai control plane)
```

## Run it

```bash
# local
cd server && npm install && ENSEMBLE_KEY=dev npm start        # :8080
cd target-app && npm install && npm run dev                    # :5173
cd runner && SERVER_URL=http://localhost:8080 ENSEMBLE_KEY=dev \
  ROOM_ID=demo AGENTS='[{"agentId":"turbo","engine":"runner","model":"gpt-5.3-codex-spark"}]' \
  TARGET_DIR=../target-app node index.mjs

# cloud (two Runloop devboxes + tunnels)
RUNLOOP_API_KEY=... python deploy/deploy_v2.py
```

## Built in 6 hours, by the thing itself

The three core components were written by three parallel headless Codex sessions against a shared spec ([docs/SPEC.md](docs/SPEC.md), [docs/SPEC-V2.md](docs/SPEC-V2.md)), orchestrated by Claude, tested and integrated live — then the deployed product's own agent kept building the demo app while a room full of people steered it. Codex on both sides of the glass.
