# Ensemble — demo script (2:30) + pitch notes

## Setup (before walking up)
- Hub tunnel URL open on the projector laptop (stage view), driver = presenter.
- Agent devbox warm, runner idle, target-app (Roomboard) seeded and hot-reloading in the preview pane.
- Phone in pocket already joined as a second participant (backup steerer).
- QR of the hub URL visible in the app header.
- Backup: screen recording of a full rehearsal on the desktop.

## Script

**0:00 — The line.**
"Google Docs had its multiplayer moment. Figma had its multiplayer moment. AI hasn't — every one of us works with agents alone, in a chat box only we can see. This is Ensemble: an agent session the whole room can join."

**0:15 — The QR.**
"Scan this. You're not getting a read-only link — you're stepping into the session."
(Presence bar fills with avatars as people join. Let it breathe for 5 seconds — this visual is the RFS thesis on screen.)

**0:30 — The agent is already working.**
"This is a live Codex agent in a Runloop devbox, building the app on the right. Watch it think, run commands, write code — all of us see the same living session."
Presenter steers: "Add a sticky-note board with a big + button." → agent works (~20s), preview hot-reloads, notes appear.

**0:55 — The multiplayer beat (the wow).**
"But here's the thing — I'm nobody special."
Ask the audience: "Someone steer it. Anything." Their steer pops up as a gate card (name attached). Approve it on stage. Agent does it. Preview updates. **Their name is on the timeline next to the change.**
(Fallback if crowd is shy: the pocket phone posts "make it confetti when you add a note".)

**1:30 — Handoff.**
"Working WITH agents means handing off like teammates." Tap an avatar → driver badge moves to them (pick the judge if one joined). "You have the keys — your steers dispatch instantly now." Their steer runs without a gate.

**1:50 — Interrupt + accountability.**
(If agent is mid-task:) hit Interrupt. "Mid-flight control, like grabbing a colleague's shoulder."
Point at the ledger strip: "And every outcome is attributed: who steered, what it cost, what shipped. Sam — 2 steers, 41k tokens, $0.12, shipped the board. That's teamwork with receipts."

**2:10 — Close.**
"Everything you watched: OpenAI Codex doing the work, a Runloop devbox as the workspace, Reflex's crew event grammar as the protocol — one session, N humans. AI's multiplayer moment. We're Ensemble."

## Q&A ammo
- "Is it real?" — yes: live codex exec on a devbox; show the JSONL event stream page if pressed.
- Codex usage story: Codex agents BUILT Ensemble (3 parallel builders + this session's thread ids saved in docs/BUILT-BY-CODEX.md) AND Codex is the live driver inside it.
- Why Runloop/Reflex: isolation + instant boxes; crew.* is Reflex's own published-but-unshipped multiplayer grammar — we built the missing layer.
- Scale story: one session today; rooms are cheap — a devbox per session, suspend when idle (scale-to-zero economics).
- YC RFS: this is "Multiplayer AI" (Aaron Epstein, Fall 2026) working end-to-end.

## Failure playbook
- Venue wifi dies → two browser windows on the laptop, same beats.
- Agent flails on a steer → Interrupt (it's a feature), re-steer with something rehearsed ("dark mode").
- Tunnel dies → restart daemon via deploy state; worst case: rehearsal recording.

## Rehearsed steers (known-good, 15-25s each on spark)
1. "Add a sticky-note board: click + to add a yellow note with editable text."
2. "Make it confetti when a note is added."
3. "Add dark mode with a toggle in the header."
4. "Add a vote button on each note with a count."

## Import-demo asset (created 12:15 PM day-of)
- Repo: https://github.com/icaruspeng/trailmap (public) — "Trailmap", hiking checklist built in a genuine solo Codex session
- Codex session/thread id to paste in the import flow: `01a04f0e-69a9-76c0-ad84-12c73977e520`
- Beat: create task "Trailmap, together" → import repo + thread id → first steer: "add a weather row for the trailhead" → agent continues WITH MEMORY of its solo build.
