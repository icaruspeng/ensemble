# How Codex built Ensemble

Ensemble was built BY a fleet of Codex agents and demos Codex AS the live in-session agent — Codex on both sides of the product.

## Build-time: parallel Codex builders (headless `codex exec`)

Three parallel non-interactive Codex sessions, each owning one component against a shared contract ([SPEC.md](SPEC.md)), orchestrated by Claude (architecture, contracts, integration, deployment):

| Component | Codex session (thread_id) |
|---|---|
| server/ (Fastify session server) | `01a04ed2-e86b-7fe2-b55f-70e2b65ec328` |
| web/ (React mission-control client) | `01a04ed3-01a1-7ef0-b0c4-e8e2b9b50b13` |
| runner/ + target-app/ (agent harness + seed app) | `01a04ed3-2089-71a1-a90d-395bf484959f` |

V2 (rooms, invites, provisioning, import, multi-agent) was a second parallel wave:

| Component | Codex session (thread_id) |
|---|---|
| server/ V2 (+provision.mjs, reflex-agent.mjs) | `01a04f2a-27d5-7fe2-89cf-51dd7f0e8712` |
| web/ V2 (home, share links, roles, agent lanes) | `01a04f03-0d77-70a0-9674-92f585997f39` |
| runner/ V2 (per-agent threads, import) | `01a04f03-2914-79e2-8755-14fa148c5e2a` |
| Trailmap (the import-demo solo session) | `01a04f0e-69a9-76c0-ad84-12c73977e520` |

Invocation pattern: `codex exec --json --sandbox workspace-write -c sandbox_workspace_write.network_access=true` — full event streams archived in the build logs. (Earlier validation spike session: `01a04ec9-5ac6-77f1-999a-020eb0762ad2`.)

## Run-time: Codex is the multiplayer session's agent

The runner drives `codex exec --json -m gpt-5.3-codex-spark` (first task) and `codex exec resume <thread_id>` (every steer after — one continuous session shared by all participants) inside a Runloop devbox, mapping the JSONL event stream to the session's live timeline and per-person token/cost attribution.
