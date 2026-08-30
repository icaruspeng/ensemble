import type { Actor, AgentSpec, EventPayloads, EventType, RoomRecord } from "./types";

export interface MockBeat<K extends EventType = EventType> {
  at: number;
  id: string;
  actor: Actor;
  type: K;
  payload: EventPayloads[K];
}

export const MOCK_DURATION_MS = 90_000;

const ARJUN: Actor = { id: "act_arjun", name: "Arjun Mehta", kind: "human" };
const PRIYA: Actor = { id: "act_priya", name: "Priya Okafor", kind: "human" };
export const MOCK_TURBO: Actor = { id: "agent_turbo", name: "Codex Turbo", kind: "agent" };
export const MOCK_DEEP: Actor = { id: "agent_deep", name: "Codex Deep", kind: "agent" };
export const MOCK_CODEX = MOCK_TURBO;
export const MOCK_SYSTEM: Actor = { id: "act_ensemble", name: "Ensemble", kind: "system" };

export const MOCK_AGENTS: AgentSpec[] = [
  {
    agentId: "turbo",
    label: "Codex Turbo",
    engine: "runner",
    model: "gpt-5.3-codex-spark",
    color: "#7bc4b2",
  },
  {
    agentId: "deep",
    label: "Codex Deep",
    engine: "runner",
    model: "gpt-5.5",
    color: "#8c83a6",
  },
];

export function createMockRoom(): RoomRecord {
  const roomId = "mock-room";
  const origin = typeof window === "undefined" ? "http://localhost:5173" : window.location.origin;
  return {
    roomId,
    name: "Roomboard launch",
    goal: "Turn a shared wall into a polished, collaborative room for ideas.",
    createdAt: Date.now() - 90_000,
    agents: MOCK_AGENTS.map((agent) => ({ ...agent })),
    invites: { steer: "mock-steer", view: "mock-view" },
    links: {
      steer: `${origin}/s/${roomId}?k=mock-steer&mock=1`,
      view: `${origin}/s/${roomId}?k=mock-view&mock=1`,
    },
    workspace: { status: "provisioning" },
  };
}

export function createMockActors(name: string) {
  const current: Actor = { id: "act_mara", name, kind: "human" };
  return {
    current,
    arjun: ARJUN,
    priya: PRIYA,
    codex: MOCK_CODEX,
    turbo: MOCK_TURBO,
    deep: MOCK_DEEP,
    system: MOCK_SYSTEM,
  };
}

function previewDocument(
  stage: "seed" | "notes" | "votes" | "complete",
  includeVotes: boolean,
) {
  const complete = stage === "complete";
  const notes = stage !== "seed";
  const votes = includeVotes && (stage === "votes" || complete);
  const voteControl = (count: number) => votes ? `<button type="button" onclick="vote(this)">${count} votes</button>` : "";
  const cards = notes
    ? `<section class="board">
        <article class="note" style="--note-rgb:111,115,201;--note-tilt:-.35deg"><div class="note-copy"><b>Welcome wall</b><p>Drop one thing the room should build.</p></div><footer><span class="author">mara chen</span>${voteControl(12)}</footer></article>
        <article class="note" style="--note-rgb:133,112,168;--note-tilt:.4deg"><div class="note-copy"><b>Demo rhythm</b><p>Keep each change small and visible.</p></div><footer><span class="author">arjun mehta</span>${voteControl(8)}</footer></article>
        <article class="note" style="--note-rgb:82,121,139;--note-tilt:-.2deg"><div class="note-copy"><b>Ship together</b><p>Hand the driver seat to the next voice.</p></div><footer><span class="author">priya okafor</span>${voteControl(15)}</footer></article>
      </section>`
    : `<section class="empty"><span>+</span><strong>The wall is ready</strong><small>New ideas will appear here.</small></section>`;
  const confetti = complete
    ? `<i class="confetti a"></i><i class="confetti b"></i><i class="confetti c"></i><i class="confetti d"></i>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color-scheme:dark;--canvas:#050505;--panel:#09090a;--text:#f4f4f2;--dim:rgba(244,244,242,.55);--line:rgba(255,255,255,.1);--blue:#2418ff;--blue-soft:rgba(36,24,255,.35);--ease:cubic-bezier(.22,1,.36,1)}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--text);font-family:"Helvetica Neue",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;min-height:100dvh;overflow:auto}.app{min-height:100vh;min-height:100dvh;padding:0 22px 18px;position:relative}.top{min-height:58px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line)}.orb{width:12px;height:12px;flex:0 0 12px;border:1px solid rgba(255,255,255,.28);border-radius:50%;background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.9),var(--blue) 45%,#0a0680 100%);box-shadow:inset 0 1px 1px rgba(255,255,255,.42),0 0 16px var(--blue-soft)}.brand{font-size:15px;font-weight:500;line-height:1;letter-spacing:-.02em;text-transform:lowercase}.room{margin-left:auto;color:var(--dim);font-size:10px;font-weight:500;letter-spacing:.04em;text-transform:lowercase}.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;padding:22px 2px 96px}.note{display:flex;min-width:0;min-height:154px;flex-direction:column;padding:13px;overflow:hidden;border:1px solid rgba(var(--note-rgb),.58);border-radius:14px;background:linear-gradient(145deg,rgba(var(--note-rgb),.075),transparent 58%),var(--panel);color:var(--text);box-shadow:inset 0 1px 0 rgba(255,255,255,.045),0 16px 44px rgba(0,0,0,.2),0 0 30px rgba(var(--note-rgb),.15);transform:rotate(var(--note-tilt));transform-origin:50% 8%}.note-copy{flex:1;min-height:86px;padding:2px}.note b{font-size:14px;font-weight:500;letter-spacing:-.01em}.note p{margin:12px 0 0;color:rgba(244,244,242,.76);font-size:12px;line-height:1.48}.note footer{min-height:31px;display:flex;align-items:center;gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07)}.author{max-width:92px;margin-right:auto;padding:4px 7px;overflow:hidden;border:1px solid rgba(255,255,255,.075);border-radius:999px;background:rgba(255,255,255,.025);color:rgba(244,244,242,.48);font-size:9px;font-weight:500;letter-spacing:.045em;line-height:1;text-overflow:ellipsis;text-transform:lowercase;white-space:nowrap}.note button{min-height:28px;padding:2px 9px;border:1px solid rgba(255,255,255,.09);border-radius:999px;background:transparent;color:rgba(244,244,242,.62);font-family:inherit;font-size:10px;font-weight:600;white-space:nowrap;cursor:pointer}.empty{height:250px;display:grid;place-content:center;text-align:center;gap:7px;color:var(--dim)}.empty span{font-size:32px;font-weight:300}.empty strong{color:rgba(244,244,242,.76);font-size:14px;font-weight:500}.empty small{font-size:11px}.add{position:fixed;right:24px;bottom:22px;width:64px;height:48px;display:grid;place-items:center;padding:0;overflow:visible;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:radial-gradient(circle at 34% 18%,rgba(255,255,255,.46),transparent 24%),var(--blue);box-shadow:inset 0 1px 0 rgba(255,255,255,.42),inset 0 -7px 16px rgba(8,4,96,.24),0 12px 34px var(--blue-soft),0 0 22px rgba(36,24,255,.22);color:#f7f7ff;font-family:inherit;font-size:24px;line-height:1;cursor:pointer}.add:focus-visible,.note button:focus-visible{outline:2px solid #9a95ff;outline-offset:2px}.add:active,.note button:active{transform:scale(.98)}.confetti,.burst{position:absolute;width:7px;height:13px;border-radius:2px}.a{background:#e9c85d;right:8%;top:20%;transform:rotate(24deg)}.b{background:#e98768;right:15%;top:11%;transform:rotate(-18deg)}.c{background:#75bfae;left:45%;top:18%;transform:rotate(45deg)}.d{background:#8d9be7;left:33%;top:10%;transform:rotate(-36deg)}.burst{background:#e98768;animation:burst 520ms cubic-bezier(.16,1,.3,1) both}@keyframes burst{from{opacity:1;transform:translate(0,0) rotate(0)}to{opacity:0;transform:translate(18px,-28px) rotate(80deg)}}@media(max-width:540px){.app{padding:0 14px 14px}.top{min-height:54px}.board{grid-template-columns:1fr;gap:10px;padding-top:16px}.note{min-height:112px}.note-copy{min-height:64px}.note p{margin-top:8px}.room{display:none}.add{right:16px;bottom:16px;width:58px;height:44px}}@media(prefers-reduced-motion:reduce){.burst{animation:none;display:none}.add,.note button{transition:none}}
  </style></head><body><main class="app">${confetti}<header class="top"><span class="orb" aria-hidden="true"></span><span class="brand">roomboard</span><span class="room">shared wall for the room</span></header>${cards}<button class="add" type="button" aria-label="Add a note">+</button></main><script>function vote(button){var value=parseInt(button.textContent,10)+1;button.textContent=value+' votes';if(${complete}){var piece=document.createElement('i');piece.className='burst';var box=button.getBoundingClientRect();piece.style.left=box.left+box.width/2+'px';piece.style.top=box.top+'px';document.body.appendChild(piece);setTimeout(function(){piece.remove()},560)}}</script></body></html>`;
}

export function mockPreviewUrl(
  stage: "seed" | "notes" | "votes" | "complete",
  includeVotes = true,
) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(previewDocument(stage, includeVotes))}`;
}

function mockAgentIdForBeat(beat: MockBeat): "turbo" | "deep" {
  const payload = beat.payload as { agentId?: string; taskId?: string; viaTaskId?: string };
  if (payload.agentId === "deep" || payload.agentId === "turbo") return payload.agentId;
  const taskId = payload.taskId ?? payload.viaTaskId ?? "";
  if (taskId === "task_votes" || taskId === "task_pulse") return "deep";
  if (/votes|vote_fix|pulse|registered_deep/.test(beat.id)) return "deep";
  return "turbo";
}

export function createMockBeats(name: string): MockBeat[] {
  const { current, arjun, priya, codex, turbo, deep, system } = createMockActors(name);

  const beats: MockBeat[] = [
    { at: 20, id: "mock_room_created", actor: system, type: "room.created", payload: { name: "Roomboard launch", goal: "Turn a shared wall into a polished, collaborative room for ideas." } },
    { at: 40, id: "mock_workspace_provisioning", actor: system, type: "workspace.status", payload: { status: "provisioning", detail: "Preparing the Roomboard workspace" } },
    { at: 60, id: "mock_registered_turbo", actor: system, type: "agent.registered", payload: { agentId: "turbo", label: "Codex Turbo", model: "gpt-5.3-codex-spark" } },
    { at: 80, id: "mock_registered_deep", actor: system, type: "agent.registered", payload: { agentId: "deep", label: "Codex Deep", model: "gpt-5.5" } },
    { at: 120, id: "mock_join_current", actor: current, type: "actor.joined", payload: { name: current.name, kind: "human" } },
    { at: 650, id: "mock_driver_current", actor: system, type: "driver.changed", payload: { toActorId: current.id } },
    { at: 2_100, id: "mock_join_arjun", actor: arjun, type: "actor.joined", payload: { name: arjun.name, kind: "human" } },
    { at: 4_100, id: "mock_join_priya", actor: priya, type: "actor.joined", payload: { name: priya.name, kind: "human" } },
    { at: 5_000, id: "mock_workspace_ready", actor: system, type: "workspace.status", payload: { status: "ready", detail: "Workspace and preview tunnel are live" } },
    { at: 5_400, id: "mock_preview_seed", actor: system, type: "preview.updated", payload: { url: mockPreviewUrl("seed") } },
    { at: 6_800, id: "mock_post_notes", actor: current, type: "crew.actor_post", payload: { text: "Add three tactile sticky notes with ideas from the room." } },
    { at: 7_650, id: "mock_dispatch_notes", actor: system, type: "crew.task_dispatched", payload: { taskId: "task_notes", text: "Add three tactile sticky notes with ideas from the room.", byActorId: current.id } },
    { at: 8_550, id: "mock_turn_notes", actor: codex, type: "agent.turn_started", payload: { taskId: "task_notes" } },
    { at: 10_100, id: "mock_thought_notes", actor: codex, type: "agent.thought", payload: { text: "I will keep the existing Roomboard shell and add a compact board model, three visible notes, and a responsive card layout." } },
    { at: 12_400, id: "mock_command_list", actor: codex, type: "agent.command", payload: { command: "rg --files src && sed -n '1,220p' src/App.tsx", exitCode: 0 } },
    { at: 14_800, id: "mock_diff_board", actor: codex, type: "agent.diff", payload: { file: "src/App.tsx", patch: "@@ -6,7 +6,22 @@\n const notes = [\n+  { id: 1, title: 'Welcome wall', body: 'Drop one thing the room should build.' },\n+  { id: 2, title: 'Demo rhythm', body: 'Keep each change small and visible.' },\n+  { id: 3, title: 'Ship together', body: 'Hand the driver seat to the next voice.' },\n ];\n \n export default function App() {\n-  return <EmptyBoard />;\n+  return <Board notes={notes} />;\n }" } },
    { at: 17_300, id: "mock_diff_notes_css", actor: codex, type: "agent.diff", payload: { file: "src/index.css", patch: "@@ -18,3 +18,17 @@\n+.board {\n+  display: grid;\n+  grid-template-columns: repeat(3, minmax(0, 1fr));\n+  gap: 1rem;\n+}\n+.note {\n+  min-height: 10rem;\n+  padding: 1.25rem;\n+  box-shadow: 0 16px 34px rgb(20 24 20 / 14%);\n+}\n+@media (max-width: 640px) {\n+  .board { grid-template-columns: 1fr; }\n+}" } },
    { at: 19_500, id: "mock_command_build_notes", actor: codex, type: "agent.command", payload: { command: "npm run build", exitCode: 0 } },
    { at: 21_300, id: "mock_message_notes", actor: codex, type: "agent.message", payload: { text: "Added three responsive sticky notes to Roomboard. Each note keeps the board legible on phones and the projector." } },
    { at: 22_600, id: "mock_complete_turn_notes", actor: codex, type: "agent.turn_completed", payload: { taskId: "task_notes", tokens: 3_842, costUsd: 0.011526 } },
    { at: 23_700, id: "mock_result_notes", actor: codex, type: "crew.result_published", payload: { taskId: "task_notes", summary: "Three responsive sticky notes are live.", diffStat: "2 files, +29 -1" } },
    { at: 24_500, id: "mock_task_notes_done", actor: codex, type: "crew.task_completed", payload: { taskId: "task_notes", tokens: 3_842, costUsd: 0.011526 } },
    { at: 25_100, id: "mock_preview_notes", actor: system, type: "preview.updated", payload: { url: mockPreviewUrl("notes") } },
    { at: 25_700, id: "mock_ledger_notes", actor: system, type: "ledger.updated", payload: { rows: [{ actorId: current.id, name: current.name, steers: 1, tokens: 3_842, costUsd: 0.011526, outcomes: ["Three responsive sticky notes are live."] }, { actorId: arjun.id, name: arjun.name, steers: 0, tokens: 0, costUsd: 0, outcomes: [] }, { actorId: priya.id, name: priya.name, steers: 0, tokens: 0, costUsd: 0, outcomes: [] }] } },
    { at: 29_700, id: "mock_post_votes", actor: arjun, type: "crew.actor_post", payload: { text: "Give every note a quick upvote control and keep the counts visible." } },
    { at: 30_600, id: "mock_gate_votes", actor: system, type: "crew.gate_requested", payload: { gateId: "gate_votes", question: "Arjun Mehta wants: Give every note a quick upvote control and keep the counts visible. Dispatch?", taskId: "task_votes" } },
    { at: 35_400, id: "mock_gate_votes_resolved", actor: current, type: "crew.gate_resolved", payload: { gateId: "gate_votes", approved: true, byActorId: current.id } },
    { at: 36_300, id: "mock_dispatch_votes", actor: system, type: "crew.task_dispatched", payload: { taskId: "task_votes", text: "Give every note a quick upvote control and keep the counts visible.", byActorId: arjun.id } },
    { at: 37_300, id: "mock_turn_votes", actor: codex, type: "agent.turn_started", payload: { taskId: "task_votes" } },
    { at: 39_600, id: "mock_thought_votes", actor: codex, type: "agent.thought", payload: { text: "Votes should feel immediate without adding server state to the target app. I will use local state and preserve each note's identity." } },
    { at: 41_700, id: "mock_command_find_notes", actor: codex, type: "agent.command", payload: { command: "rg -n \"notes|Board\" src", exitCode: 0 } },
    { at: 43_900, id: "mock_diff_votes", actor: codex, type: "agent.diff", payload: { file: "src/App.tsx", patch: "@@ -12,6 +12,13 @@\n function Note({ note }) {\n+  const [votes, setVotes] = useState(note.votes);\n   return (\n     <article className=\"note\">\n       <h2>{note.title}</h2>\n+      <button className=\"vote\" onClick={() => setVotes(votes + 1)}>\n+        {votes} votes\n+      </button>\n     </article>\n   );\n }" } },
    { at: 46_400, id: "mock_comment_votes", actor: priya, type: "comment.created", payload: { commentId: "comment_votes", anchor: { eventId: "mock_diff_votes", file: "src/App.tsx" }, text: "Keep the vote target large enough for phones." } },
    { at: 48_600, id: "mock_command_votes_fail", actor: codex, type: "agent.command", payload: { command: "npm run build", exitCode: 1 } },
    { at: 50_100, id: "mock_thought_vote_fix", actor: codex, type: "agent.thought", payload: { text: "The seed notes do not have vote values yet. I will add defaults and widen the button target while I am in the component." } },
    { at: 52_200, id: "mock_diff_vote_fix", actor: codex, type: "agent.diff", payload: { file: "src/App.tsx", patch: "@@ -3,3 +3,3 @@\n-  { id: 1, title: 'Welcome wall' },\n+  { id: 1, title: 'Welcome wall', votes: 12 },\n@@ -28,2 +28,3 @@\n .vote {\n+  min-height: 2.75rem;\n }" } },
    { at: 54_000, id: "mock_command_votes_pass", actor: codex, type: "agent.command", payload: { command: "npm run build", exitCode: 0 } },
    { at: 55_500, id: "mock_comment_resolved", actor: codex, type: "comment.resolved", payload: { commentId: "comment_votes", byActorId: codex.id, viaTaskId: "task_votes" } },
    { at: 57_300, id: "mock_message_votes", actor: codex, type: "agent.message", payload: { text: "Upvotes are live with durable note IDs, seeded counts, and phone-sized controls. I also fixed the missing seed values found by the build." } },
    { at: 58_800, id: "mock_complete_turn_votes", actor: codex, type: "agent.turn_completed", payload: { taskId: "task_votes", tokens: 2_816, costUsd: 0.008448 } },
    { at: 59_900, id: "mock_result_votes", actor: codex, type: "crew.result_published", payload: { taskId: "task_votes", summary: "Quick upvotes are active on every note.", diffStat: "2 files, +18 -1" } },
    { at: 60_700, id: "mock_task_votes_done", actor: codex, type: "crew.task_completed", payload: { taskId: "task_votes", tokens: 2_816, costUsd: 0.008448 } },
    { at: 61_100, id: "mock_preview_votes", actor: system, type: "preview.updated", payload: { url: mockPreviewUrl("votes") } },
    { at: 61_500, id: "mock_ledger_votes", actor: system, type: "ledger.updated", payload: { rows: [{ actorId: current.id, name: current.name, steers: 1, tokens: 3_842, costUsd: 0.011526, outcomes: ["Three responsive sticky notes are live."] }, { actorId: arjun.id, name: arjun.name, steers: 1, tokens: 2_816, costUsd: 0.008448, outcomes: ["Quick upvotes are active on every note."] }, { actorId: priya.id, name: priya.name, steers: 0, tokens: 0, costUsd: 0, outcomes: [] }] } },
    { at: 63_800, id: "mock_post_theme", actor: priya, type: "crew.actor_post", payload: { text: "Move the board to an ink-dark theme and celebrate each vote with a little confetti." } },
    { at: 64_700, id: "mock_gate_theme", actor: system, type: "crew.gate_requested", payload: { gateId: "gate_theme", question: "Priya Okafor wants: Move the board to an ink-dark theme and celebrate each vote with a little confetti. Dispatch?", taskId: "task_theme" } },
    { at: 68_200, id: "mock_gate_theme_resolved", actor: current, type: "crew.gate_resolved", payload: { gateId: "gate_theme", approved: true, byActorId: current.id } },
    { at: 69_000, id: "mock_dispatch_theme", actor: system, type: "crew.task_dispatched", payload: { taskId: "task_theme", text: "Move the board to an ink-dark theme and celebrate each vote with a little confetti.", byActorId: priya.id } },
    { at: 69_900, id: "mock_turn_theme", actor: codex, type: "agent.turn_started", payload: { taskId: "task_theme" } },
    { at: 71_000, id: "mock_handoff_priya", actor: current, type: "driver.changed", payload: { toActorId: priya.id } },
    { at: 72_600, id: "mock_thought_theme", actor: codex, type: "agent.thought", payload: { text: "I will shift only the board palette, keep the note colors warm for contrast, and use a short click burst instead of constant animation." } },
    { at: 74_600, id: "mock_command_theme", actor: codex, type: "agent.command", payload: { command: "sed -n '1,260p' src/index.css", exitCode: 0 } },
    { at: 76_300, id: "mock_diff_theme", actor: codex, type: "agent.diff", payload: { file: "src/index.css", patch: "@@ -1,7 +1,10 @@\n :root {\n-  color: #20241f;\n-  background: #edf0eb;\n+  color: #f4f2e9;\n+  background: #121419;\n+  --panel: #1c2028;\n }\n+.confetti { animation: burst 520ms cubic-bezier(.16,1,.3,1); }\n+@media (prefers-reduced-motion: reduce) { .confetti { animation: none; } }" } },
    { at: 78_500, id: "mock_preview_complete", actor: system, type: "preview.updated", payload: { url: mockPreviewUrl("complete") } },
    { at: 80_000, id: "mock_message_theme", actor: codex, type: "agent.message", payload: { text: "Roomboard now has an ink-dark canvas and a brief vote celebration. Reduced-motion visitors get the same vote feedback without the burst." } },
    { at: 81_400, id: "mock_complete_turn_theme", actor: codex, type: "agent.turn_completed", payload: { taskId: "task_theme", tokens: 3_527, costUsd: 0.010581 } },
    { at: 82_400, id: "mock_result_theme", actor: codex, type: "crew.result_published", payload: { taskId: "task_theme", summary: "Dark Roomboard and vote confetti are live.", diffStat: "2 files, +24 -7" } },
    { at: 83_200, id: "mock_task_theme_done", actor: codex, type: "crew.task_completed", payload: { taskId: "task_theme", tokens: 3_527, costUsd: 0.010581 } },
    { at: 84_000, id: "mock_ledger_theme", actor: system, type: "ledger.updated", payload: { rows: [{ actorId: current.id, name: current.name, steers: 1, tokens: 3_842, costUsd: 0.011526, outcomes: ["Three responsive sticky notes are live."] }, { actorId: arjun.id, name: arjun.name, steers: 1, tokens: 2_816, costUsd: 0.008448, outcomes: ["Quick upvotes are active on every note."] }, { actorId: priya.id, name: priya.name, steers: 1, tokens: 3_527, costUsd: 0.010581, outcomes: ["Dark Roomboard and vote confetti are live."] }] } },
    { at: 85_300, id: "mock_post_pulse", actor: priya, type: "crew.actor_post", payload: { text: "Add a small room pulse when a new person joins." } },
    { at: 86_100, id: "mock_dispatch_pulse", actor: system, type: "crew.task_dispatched", payload: { taskId: "task_pulse", text: "Add a small room pulse when a new person joins.", byActorId: priya.id } },
    { at: 86_900, id: "mock_turn_pulse", actor: codex, type: "agent.turn_started", payload: { taskId: "task_pulse" } },
    { at: 87_800, id: "mock_command_pulse_fail", actor: codex, type: "agent.command", payload: { command: "curl -fsS http://localhost:5173/health", exitCode: 7 } },
    { at: 88_800, id: "mock_task_pulse_failed", actor: codex, type: "crew.task_failed", payload: { taskId: "task_pulse", reason: "Preview dev server stopped responding. Task kept for retry." } },
    { at: 89_400, id: "mock_ledger_final", actor: system, type: "ledger.updated", payload: { rows: [{ actorId: current.id, name: current.name, steers: 1, tokens: 3_842, costUsd: 0.011526, outcomes: ["Three responsive sticky notes are live."] }, { actorId: arjun.id, name: arjun.name, steers: 1, tokens: 2_816, costUsd: 0.008448, outcomes: ["Quick upvotes are active on every note."] }, { actorId: priya.id, name: priya.name, steers: 2, tokens: 3_527, costUsd: 0.010581, outcomes: ["Dark Roomboard and vote confetti are live."] }] } },
    { at: 90_000, id: "mock_arjun_left", actor: arjun, type: "actor.left", payload: {} },
  ];

  return beats.map((beat) => {
    const agentId = mockAgentIdForBeat(beat);
    const actor = beat.actor.kind === "agent" ? (agentId === "deep" ? deep : turbo) : beat.actor;
    const carriesAgentId =
      beat.type.startsWith("agent.") ||
      beat.type === "crew.task_dispatched" ||
      (beat.type === "preview.updated" && beat.id !== "mock_preview_seed");

    if (!carriesAgentId && actor === beat.actor) return beat;
    return {
      ...beat,
      actor,
      payload: carriesAgentId
        ? { ...(beat.payload as Record<string, unknown>), agentId }
        : beat.payload,
    } as MockBeat;
  });
}
