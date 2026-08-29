# Chat room + foldable panes (post-submission sprint, for the 7 PM stage)

Goal: the session page splits its left column into two foldable panes, and people can talk without steering — a group chat where humans and agents converse.

## Server (tiny)
- New WS message `{type:"chat", text}` — allowed for steerers AND viewers (talking is not steering). Emits `crew.actor_post` with payload `{text, chat: true}`. No task, no gate, no ledger steer increment.
- Nothing else changes: agent replies are the existing `agent.message` events.

## Web
- **Two panes replace the single timeline** in the left column:
  1. **💬 chat** — renders `crew.actor_post` (all) and `agent.message` as group-chat bubbles: avatar + name + time, humans right-aligned or color-coded, agents with their orb/color. Auto-scrolls.
  2. **🛠 work log** — everything else (thoughts, commands, diffs, turn/task/gate/workspace events), denser than today: font-size 12px, tighter spacing ("make the timeline smaller").
- **Both panes foldable**: header bar with a chevron; collapsed = just the header with an unread-count badge; state in localStorage.
- **Composer gains a mode switch**: two tabs — `steer` (today's behavior, agent chips visible) and `chat` (sends {type:"chat"}, no agent chips). Enter sends in both.
- Mobile: chat pane is primary; work log folded by default.
- Steer posts appear in chat too (they are actor_posts) with a small "→ steer" marker; chat:true posts have no marker.
