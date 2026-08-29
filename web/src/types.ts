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

export interface EventPayloads {
  "actor.joined": { name: string; kind: ActorKind };
  "actor.left": Record<string, never>;
  "driver.changed": { toActorId: string };
  "crew.actor_post": { text: string };
  "crew.task_dispatched": { taskId: string; text: string; byActorId: string };
  "crew.task_completed": { taskId: string; tokens: number; costUsd: number };
  "crew.task_failed": { taskId: string; reason: string };
  "crew.gate_requested": { gateId: string; question: string; taskId: string };
  "crew.gate_resolved": { gateId: string; approved: boolean; byActorId: string };
  "crew.result_published": { taskId: string; summary: string; diffStat: string };
  "agent.turn_started": { taskId: string };
  "agent.turn_completed": { taskId: string; tokens: number; costUsd: number };
  "agent.thought": { text: string };
  "agent.command": { command: string; exitCode?: number };
  "agent.diff": { file: string; patch: string };
  "agent.message": { text: string };
  "comment.created": { commentId: string; anchor: CommentAnchor; text: string };
  "comment.resolved": { commentId: string; byActorId: string; viaTaskId?: string };
  "ledger.updated": { rows: LedgerRow[] };
  "preview.updated": { url: string };
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
  | { type: "steer"; text: string }
  | { type: "comment"; anchor: CommentAnchor; text: string }
  | { type: "resolveGate"; gateId: string; approved: boolean }
  | { type: "handoff"; toActorId: string }
  | { type: "interrupt" };

export type ConnectionStatus = "idle" | "connecting" | "live" | "reconnecting" | "offline";

export interface TaskView {
  taskId: string;
  text: string;
  byActorId: string;
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
