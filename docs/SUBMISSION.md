# Submission draft — copy-paste ready

**Project name:** Ensemble

**One-liner:** The multiplayer moment for AI — live agent sessions your whole team joins, steers, and shares, with receipts.

**Description (short):**
AI is still single-player: every agent session is a chat box only one person can see. Ensemble makes the session a shared place. Create a task, pick a crew of agents (Codex Turbo/Deep, GPT-5.6 Sol/Luna/Terra, Claude Fable/Opus/Sonnet 5 — two providers in one room), and share it like a Google Doc: a can-steer link and a can-view link. Everyone watches the agent think, run commands, and ship diffs live; anyone can propose a steer; the driver gates and dispatches; control hands off like a teammate; an Interrupt button stops mid-flight. Import an existing Codex session by ID and it wakes up in a cloud workspace remembering everything from your solo thread. Every outcome is attributed in the ledger: who steered, which agent, tokens, dollars, what shipped. This is YC's Fall-2026 "Multiplayer AI" RFS, working end to end.

**How we used the sponsor stack:**
- **OpenAI Codex** — the working agents (headless `codex exec --json` / `exec resume`, one persistent thread per agent — which is also what powers session import), and the workforce that BUILT Ensemble: two waves of parallel headless builder sessions, all session IDs in docs/BUILT-BY-CODEX.md. 66 Codex sessions today.
- **Runloop** — a devbox per task, provisioned on demand in ~25 seconds (agent mount, repo clone, live preview tunnel); snapshots as reset/recovery; suspend economics.
- **Reflex** — our session protocol implements Reflex's published-but-unshipped `crew.*` event grammar (actor_post, gate_requested/resolved, task_dispatched, result_published) — the multiplayer layer their schema promises; Claude-family agents run through reflex.runloop.ai with credentials we registered via their API.

**Live demo:** <HUB_URL> (demo room: /s/demo?k=crew to steer, ?k=watch to view)
**Repo:** https://github.com/icaruspeng/ensemble
**Team:** Roy (icaruspeng) — with Claude orchestrating and Codex building.
