export type ActorKind = "human" | "agent" | "system";

export interface Actor {
  id: string;
  name: string;
  kind: ActorKind;
}

export interface CommentAnchor {
  file?: string;
  eventId?: string;
}

export interface LedgerRow {
  actorId: string;
  name: string;
  steers: number;
  tokens: number;
  costUsd: number;
  outcomes: string[];
}

export type WorkspaceStatus = "provisioning" | "ready" | "error";

export type SessionRole = "steerer" | "viewer";

export interface AgentSpec {
  agentId: string;
  label: string;
  engine: "runner" | "reflex";
  model: string;
  reflexAgentId?: string;
  color: string;
}

export interface RoomRecord {
  roomId: string;
  name: string;
  goal: string;
  createdAt: number;
  repoUrl?: string;
  importThreadId?: string;
  agents: AgentSpec[];
  invites?: {
    steer: string;
    view: string;
  };
  links?: {
    steer: string;
    view: string;
  };
  workspace: {
    status: WorkspaceStatus;
    detail?: string;
    devboxId?: string;
    previewUrl?: string;
  };
}

export interface RoomSummary {
  id: string;
  roomId?: string;
  name: string;
  status: WorkspaceStatus;
  createdAt: number;
}

export interface EventPayloads {
  "room.created": { name: string; goal: string };
  "workspace.status": { status: WorkspaceStatus; detail?: string };
  "agent.registered": { agentId: string; label: string; model: string };
  "actor.joined": { name: string; kind: ActorKind };
  "actor.left": Record<string, never>;
  "driver.changed": { toActorId: string };
  "crew.actor_post": { text: string; chat?: boolean };
  "crew.task_dispatched": { taskId: string; text: string; byActorId: string; agentId?: string };
  "crew.task_completed": { taskId: string; tokens: number; costUsd: number };
  "crew.task_failed": { taskId: string; reason: string };
  "crew.gate_requested": { gateId: string; question: string; taskId: string };
  "crew.gate_resolved": { gateId: string; approved: boolean; byActorId: string };
  "crew.result_published": { taskId: string; summary: string; diffStat: string; byActorName?: string };
  "agent.turn_started": { taskId: string; agentId?: string };
  "agent.turn_completed": { taskId: string; tokens: number; costUsd: number; agentId?: string };
  "agent.thought": { text: string; agentId?: string };
  "agent.command": { command: string; exitCode?: number; agentId?: string };
  "agent.diff": { file: string; patch: string; agentId?: string };
  "agent.message": { text: string; agentId?: string };
  "comment.created": { commentId: string; anchor: CommentAnchor; text: string };
  "comment.resolved": { commentId: string; byActorId: string; viaTaskId?: string };
  "ledger.updated": { rows: LedgerRow[] };
  "preview.updated": { url: string; agentId?: string };
}

export type EventType = keyof EventPayloads;

export interface EnsembleEvent<K extends EventType = EventType> {
  id: string;
  ts: number;
  seq: number;
  type: K;
  actor: Actor;
  payload: EventPayloads[K];
}

export type ClientMessage =
  | { type: "steer"; text: string; agentId?: string }
  | { type: "chat"; text: string }
  | { type: "comment"; anchor: CommentAnchor; text: string }
  | { type: "resolveGate"; gateId: string; approved: boolean }
  | { type: "handoff"; toActorId: string }
  | { type: "interrupt" }
  | { type: "dropTask"; taskId: string };

export type ConnectionStatus = "idle" | "connecting" | "live" | "reconnecting" | "offline";

export interface TaskView {
  taskId: string;
  text: string;
  byActorId: string;
  agentId?: string;
  status: "queued" | "running" | "completed" | "failed";
}

export interface GateView {
  gateId: string;
  question: string;
  taskId: string;
  requestedBy: Actor;
  resolution?: { approved: boolean; byActorId: string };
}

export interface CommentView {
  commentId: string;
  anchor: CommentAnchor;
  text: string;
  actor: Actor;
  resolved: boolean;
  resolvedByActorId?: string;
  viaTaskId?: string;
}
