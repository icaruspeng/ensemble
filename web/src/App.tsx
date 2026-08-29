import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { HomePage } from "./HomePage";
import { ShareDialog } from "./ShareDialog";
import { useSession } from "./useSession";
import type {
  Actor,
  AgentSpec,
  CommentAnchor,
  CommentView,
  ConnectionStatus,
  EnsembleEvent,
  EventPayloads,
  GateView,
  LedgerRow,
  RoomRecord,
  TaskView,
  WorkspaceStatus,
} from "./types";

const TIME_FORMAT = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const TOKEN_FORMAT = new Intl.NumberFormat([], {
  notation: "compact",
  maximumFractionDigits: 1,
});

const AVATAR_COLORS = ["#5e9d91", "#8c83a6", "#b07d68", "#718eae", "#9a8b58", "#8f7392"];
const AGENT_COLORS: Record<string, string> = {
  turbo: "#7bc4b2",
  deep: "#8fa3d1",
  claude: "#d49a72",
};

interface DerivedSession {
  actors: Map<string, Actor>;
  presence: Actor[];
  agents: AgentSpec[];
  registeredAgents: AgentSpec[];
  tasks: TaskView[];
  gates: GateView[];
  comments: CommentView[];
  ledger: LedgerRow[];
  previewUrl: string;
  workspaceStatus: WorkspaceStatus;
  workspaceDetail: string;
}

function payloadOf<K extends keyof EventPayloads>(event: EnsembleEvent, type: K) {
  return event.payload as EventPayloads[K];
}

function fallbackAgentColor(agentId: string) {
  if (AGENT_COLORS[agentId]) return AGENT_COLORS[agentId];
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = (hash * 31 + agentId.charCodeAt(index)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function deriveSession(events: EnsembleEvent[], room: RoomRecord | null): DerivedSession {
  const actors = new Map<string, Actor>();
  const presence = new Map<string, Actor>();
  const agents = new Map<string, AgentSpec>((room?.agents ?? []).map((agent) => [agent.agentId, agent]));
  const registeredAgentIds = new Set<string>();
  const tasks = new Map<string, TaskView>();
  const gates = new Map<string, GateView>();
  const comments = new Map<string, CommentView>();
  let ledger: LedgerRow[] = [];
  let previewUrl = room?.workspace.previewUrl ?? "";
  let workspaceStatus: WorkspaceStatus = room?.workspace.status ?? "provisioning";
  let workspaceDetail = "";

  for (const event of events) {
    actors.set(event.actor.id, event.actor);

    switch (event.type) {
      case "actor.joined": {
        const payload = payloadOf(event, "actor.joined");
        const actor = { ...event.actor, name: payload.name, kind: payload.kind };
        actors.set(actor.id, actor);
        presence.set(actor.id, actor);
        break;
      }
      case "actor.left":
        presence.delete(event.actor.id);
        break;
      case "crew.task_dispatched": {
        const payload = payloadOf(event, "crew.task_dispatched");
        tasks.set(payload.taskId, {
          taskId: payload.taskId,
          text: payload.text,
          byActorId: payload.byActorId,
          agentId: payload.agentId,
          status: "queued",
        });
        break;
      }
      case "agent.turn_started": {
        const payload = payloadOf(event, "agent.turn_started");
        const task = tasks.get(payload.taskId);
        if (task) tasks.set(payload.taskId, { ...task, status: "running" });
        break;
      }
      case "crew.task_completed": {
        const payload = payloadOf(event, "crew.task_completed");
        const task = tasks.get(payload.taskId);
        if (task) tasks.set(payload.taskId, { ...task, status: "completed" });
        break;
      }
      case "crew.task_failed": {
        const payload = payloadOf(event, "crew.task_failed");
        const task = tasks.get(payload.taskId);
        if (task) tasks.set(payload.taskId, { ...task, status: "failed" });
        break;
      }
      case "crew.gate_requested": {
        const payload = payloadOf(event, "crew.gate_requested");
        gates.set(payload.gateId, {
          gateId: payload.gateId,
          question: payload.question,
          taskId: payload.taskId,
          requestedBy: event.actor,
        });
        break;
      }
      case "crew.gate_resolved": {
        const payload = payloadOf(event, "crew.gate_resolved");
        const gate = gates.get(payload.gateId);
        if (gate) {
          gates.set(payload.gateId, {
            ...gate,
            resolution: { approved: payload.approved, byActorId: payload.byActorId },
          });
        }
        break;
      }
      case "comment.created": {
        const payload = payloadOf(event, "comment.created");
        comments.set(payload.commentId, {
          commentId: payload.commentId,
          anchor: payload.anchor,
          text: payload.text,
          actor: event.actor,
          resolved: false,
        });
        break;
      }
      case "comment.resolved": {
        const payload = payloadOf(event, "comment.resolved");
        const comment = comments.get(payload.commentId);
        if (comment) {
          comments.set(payload.commentId, {
            ...comment,
            resolved: true,
            resolvedByActorId: payload.byActorId,
            viaTaskId: payload.viaTaskId,
          });
        }
        break;
      }
      case "ledger.updated":
        ledger = payloadOf(event, "ledger.updated").rows;
        break;
      case "preview.updated":
        previewUrl = payloadOf(event, "preview.updated").url;
        if (previewUrl && workspaceStatus === "provisioning") workspaceStatus = "ready";
        break;
      case "workspace.status": {
        const payload = payloadOf(event, "workspace.status");
        workspaceStatus = payload.status;
        workspaceDetail = payload.detail ?? "";
        break;
      }
      case "agent.registered": {
        const payload = payloadOf(event, "agent.registered");
        const existing = agents.get(payload.agentId);
        agents.set(payload.agentId, {
          agentId: payload.agentId,
          label: payload.label,
          engine: existing?.engine ?? "runner",
          model: payload.model,
          reflexAgentId: existing?.reflexAgentId,
          color: existing?.color ?? fallbackAgentColor(payload.agentId),
        });
        registeredAgentIds.add(payload.agentId);
        break;
      }
      default:
        break;
    }
  }

  return {
    actors,
    presence: [...presence.values()].filter((actor) => actor.kind === "human"),
    agents: [...agents.values()],
    registeredAgents: [...agents.values()].filter((agent) => registeredAgentIds.has(agent.agentId)),
    tasks: [...tasks.values()],
    gates: [...gates.values()].filter((gate) => !gate.resolution),
    comments: [...comments.values()],
    ledger,
    previewUrl,
    workspaceStatus,
    workspaceDetail,
  };
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function colorForActor(actorId: string) {
  let hash = 0;
  for (let index = 0; index < actorId.length; index += 1) {
    hash = (hash * 31 + actorId.charCodeAt(index)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function actorName(actors: Map<string, Actor>, actorId: string | null | undefined) {
  if (!actorId) return "No driver";
  return actors.get(actorId)?.name ?? actorId.replace(/^act_/, "");
}

function formatCost(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`;
}

function formatTokens(value: number) {
  return TOKEN_FORMAT.format(Number.isFinite(value) ? value : 0);
}

function eventTime(ts: number) {
  try {
    return TIME_FORMAT.format(new Date(ts));
  } catch {
    return "--:--:--";
  }
}

function previewHost(url: string) {
  if (!url) return "Waiting for preview";
  if (url.startsWith("data:")) return "Roomboard local preview";
  try {
    return new URL(url, window.location.href).host || "Preview";
  } catch {
    return "Preview";
  }
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

function trapFocus(event: globalThis.KeyboardEvent, container: HTMLElement) {
  if (event.key !== "Tab") return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0);

  if (!focusable.length) {
    event.preventDefault();
    container.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const focusIsInside = active instanceof Node && container.contains(active);

  if (event.shiftKey && (!focusIsInside || active === container || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!focusIsInside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

function Avatar({
  actor,
  size = "medium",
  color,
}: {
  actor: Actor;
  size?: "small" | "medium" | "large";
  color?: string;
}) {
  return (
    <span
      className={`avatar avatar--${size}${actor.kind === "agent" ? " avatar--agent" : ""}`}
      style={{ "--avatar-color": color ?? colorForActor(actor.id) } as CSSProperties}
      aria-hidden="true"
    >
      {actor.kind === "system" ? "EN" : initials(actor.name)}
    </span>
  );
}

function ConnectionMark({ status }: { status: ConnectionStatus }) {
  const label =
    status === "live"
      ? "Live"
      : status === "reconnecting"
        ? "Reconnecting"
        : status === "offline"
          ? "Offline"
          : status === "connecting"
            ? "Connecting"
            : "Idle";
  return (
    <span className={`connection-mark connection-mark--${status}`} title={`Connection: ${label}`}>
      <span className="connection-mark__signal" aria-hidden="true" />
      {label}
    </span>
  );
}

interface HeaderProps {
  actors: Actor[];
  agents: AgentSpec[];
  actorId: string | null;
  driverActorId: string | null;
  isDriver: boolean;
  isViewer: boolean;
  status: ConnectionStatus;
  roomName: string;
  mockMode: boolean;
  onHandoff: (actorId: string) => void;
  onInterrupt: () => void;
  onShare: () => void;
}

function Header({
  actors,
  agents,
  actorId,
  driverActorId,
  isDriver,
  isViewer,
  status,
  roomName,
  mockMode,
  onHandoff,
  onInterrupt,
  onShare,
}: HeaderProps) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <span className="brand-word">ENSEMBLE</span>
        <span className="session-title">{roomName}</span>
        {mockMode && <span className="mode-label">Mock</span>}
        {isViewer && <span className="viewer-badge">View only</span>}
      </div>

      <div className="presence" aria-label="People and agents in this session">
        <ConnectionMark status={status} />
        <div className="presence__avatars">
          {agents.map((agent) => {
            const actor: Actor = { id: `agent:${agent.agentId}`, name: agent.label, kind: "agent" };
            return (
              <span
                className="presence-person presence-person--agent"
                key={agent.agentId}
                title={`${agent.label}, ${agent.model}`}
                role="img"
                aria-label={`${agent.label}, agent using ${agent.model}`}
              >
                <Avatar actor={actor} size="medium" color={agent.color || fallbackAgentColor(agent.agentId)} />
              </span>
            );
          })}
          {actors.map((actor) => {
            const driver = actor.id === driverActorId;
            const self = actor.id === actorId;
            const canHandoff = !isViewer && isDriver && !self;
            const accessibleName = `${actor.name}${self ? ", you" : ""}${driver ? ", current driver" : ""}`;
            const content = (
              <>
                <Avatar actor={actor} size="medium" />
                {driver && <span className="driver-badge">DRIVER</span>}
              </>
            );
            return canHandoff ? (
              <button
                className={`presence-person${driver ? " presence-person--driver" : ""}${self ? " presence-person--self" : ""}`}
                type="button"
                key={actor.id}
                onClick={() => onHandoff(actor.id)}
                title={`Hand driver control to ${actor.name}`}
                aria-label={`Hand driver control to ${accessibleName}`}
              >
                {content}
              </button>
            ) : (
              <span
                className={`presence-person${driver ? " presence-person--driver" : ""}${self ? " presence-person--self" : ""}`}
                key={actor.id}
                title={accessibleName}
                role="img"
                aria-label={accessibleName}
              >
                {content}
              </span>
            );
          })}
        </div>
      </div>

      <div className="topbar__actions">
        {isDriver && !isViewer && (
          <button className="interrupt-button" type="button" onClick={onInterrupt}>
            Interrupt
          </button>
        )}
        <button className="share-button" type="button" onClick={onShare}>
          Share
        </button>
      </div>
    </header>
  );
}

function MetaLine({ actor, ts, label }: { actor: Actor; ts: number; label?: string }) {
  return (
    <div className="event-meta">
      <strong>{actor.name}</strong>
      {label && <span>{label}</span>}
      <time dateTime={new Date(ts).toISOString()}>{eventTime(ts)}</time>
    </div>
  );
}

function CompactEvent({
  title,
  detail,
  tone = "neutral",
  tail,
}: {
  title: string;
  detail?: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "accent";
  tail?: ReactNode;
}) {
  return (
    <div className={`compact-event compact-event--${tone}`}>
      <span className="compact-event__mark" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
      {tail && <div className="compact-event__tail">{tail}</div>}
    </div>
  );
}

function CommentPins({ comments }: { comments: CommentView[] }) {
  if (!comments.length) return null;
  return (
    <div className="comment-pins">
      {comments.map((comment) => (
        <article className={`comment-pin${comment.resolved ? " comment-pin--resolved" : ""}`} key={comment.commentId}>
          <Avatar actor={comment.actor} size="small" />
          <div className="comment-pin__copy">
            <strong>{comment.actor.name}</strong>
            <p>{comment.text}</p>
          </div>
          {comment.resolved && <span className="resolved-check">✓ Resolved</span>}
        </article>
      ))}
    </div>
  );
}

interface CommentTarget {
  anchor: CommentAnchor;
  label: string;
}

function InlineCommentComposer({
  target,
  onCancel,
  onSubmit,
}: {
  target: CommentTarget;
  onCancel: () => void;
  onSubmit: (text: string) => boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const clean = text.trim();
    if (!clean) {
      setError("Write a note before posting.");
      return;
    }
    if (onSubmit(clean)) {
      setText("");
      onCancel();
    } else {
      setError("The note could not be sent while disconnected.");
    }
  };

  return (
    <form className="inline-comment" onSubmit={submit}>
      <label htmlFor={`comment-${target.anchor.eventId}`}>Pin a note to {target.label}</label>
      <div className="inline-comment__row">
        <input
          id={`comment-${target.anchor.eventId}`}
          autoFocus
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError("");
          }}
          placeholder="Be specific about this change"
          aria-invalid={!!error}
          aria-describedby={error ? `comment-${target.anchor.eventId}-error` : undefined}
        />
        <button className="button button--quiet" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button button--accent" type="submit">
          Pin note
        </button>
      </div>
      {error && <p className="form-error" id={`comment-${target.anchor.eventId}-error`} role="alert">{error}</p>}
    </form>
  );
}

function diffLineClass(line: string) {
  if (line.startsWith("@@")) return "diff-line diff-line--hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "diff-line diff-line--add";
  if (line.startsWith("-") && !line.startsWith("---")) return "diff-line diff-line--remove";
  return "diff-line";
}

function diffStat(patch: string) {
  const lines = patch.split("\n");
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removals = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return { additions, removals };
}

function agentIdOfEvent(event: EnsembleEvent) {
  const payload = event.payload as { agentId?: unknown };
  return typeof payload.agentId === "string" && payload.agentId ? payload.agentId : null;
}

function agentShortLabel(agent: AgentSpec) {
  if (agent.agentId === "claude") return "Claude";
  return agent.label.replace(/^Codex\s+/i, "");
}

function AgentChip({ agent, compact = false }: { agent: AgentSpec; compact?: boolean }) {
  return (
    <span
      className={`agent-chip${compact ? " agent-chip--compact" : ""}`}
      style={{ "--agent-color": agent.color || fallbackAgentColor(agent.agentId) } as CSSProperties}
      title={`${agent.label} uses ${agent.model}`}
    >
      {agentShortLabel(agent)}
    </span>
  );
}

interface TimelineEventProps {
  event: EnsembleEvent;
  newest: boolean;
  actors: Map<string, Actor>;
  agents: Map<string, AgentSpec>;
  comments: CommentView[];
  canComment: boolean;
  activeCommentId: string | null;
  onOpenComment: (target: CommentTarget) => void;
  onCloseComment: () => void;
  onSubmitComment: (anchor: CommentAnchor, text: string) => boolean;
}

function TimelineEvent({
  event,
  newest,
  actors,
  agents,
  comments,
  canComment,
  activeCommentId,
  onOpenComment,
  onCloseComment,
  onSubmitComment,
}: TimelineEventProps) {
  const longPressTimer = useRef<number | null>(null);
  const agentId = agentIdOfEvent(event);
  const agent = agentId ? agents.get(agentId) : undefined;
  const commentable = canComment && (event.type === "agent.diff" || event.type === "agent.message");
  const commentTarget: CommentTarget | null =
    !canComment
      ? null
      : event.type === "agent.diff"
      ? { anchor: { eventId: event.id, file: payloadOf(event, "agent.diff").file }, label: payloadOf(event, "agent.diff").file }
      : event.type === "agent.message"
        ? { anchor: { eventId: event.id }, label: "agent message" }
        : null;

  const beginLongPress = (_event: ReactPointerEvent) => {
    if (!commentTarget) return;
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => onOpenComment(commentTarget), 520);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  useEffect(() => cancelLongPress, []);

  const attachedComments = comments.filter(
    (comment) =>
      comment.anchor.eventId === event.id ||
      (!comment.anchor.eventId && event.type === "agent.diff" && comment.anchor.file === payloadOf(event, "agent.diff").file),
  );

  let body: ReactNode;

  switch (event.type) {
    case "room.created": {
      const payload = payloadOf(event, "room.created");
      body = <CompactEvent title={`${payload.name} created`} detail={payload.goal} tone="accent" />;
      break;
    }
    case "workspace.status": {
      const payload = payloadOf(event, "workspace.status");
      const title = payload.status === "ready"
        ? "Workspace ready"
        : payload.status === "error"
          ? "Workspace provisioning failed"
          : "Workspace provisioning";
      body = (
        <CompactEvent
          title={title}
          detail={payload.detail || (payload.status === "provisioning" ? "Preparing the development environment" : "Preview and agents can connect")}
          tone={payload.status === "ready" ? "success" : payload.status === "error" ? "danger" : "warning"}
        />
      );
      break;
    }
    case "agent.registered": {
      const payload = payloadOf(event, "agent.registered");
      body = <CompactEvent title={`${payload.label} joined the room`} detail={payload.model} tone="accent" />;
      break;
    }
    case "actor.joined": {
      const payload = payloadOf(event, "actor.joined");
      body = <CompactEvent title={`${payload.name} joined the room`} detail={payload.kind === "human" ? "Presence connected" : `${payload.kind} connected`} tone="success" />;
      break;
    }
    case "actor.left":
      body = <CompactEvent title={`${event.actor.name} left the room`} detail="Presence disconnected" />;
      break;
    case "driver.changed": {
      const payload = payloadOf(event, "driver.changed");
      body = <CompactEvent title={`Driver handed to ${actorName(actors, payload.toActorId)}`} detail={`Control moved by ${event.actor.name}`} tone="accent" />;
      break;
    }
    case "crew.actor_post": {
      const payload = payloadOf(event, "crew.actor_post");
      body = (
        <article className="human-post">
          <MetaLine actor={event.actor} ts={event.ts} label="steered" />
          <p>{payload.text}</p>
        </article>
      );
      break;
    }
    case "crew.task_dispatched": {
      const payload = payloadOf(event, "crew.task_dispatched");
      body = <CompactEvent title="Task added to the queue" detail={payload.text} tone="accent" tail={<code>{payload.taskId}</code>} />;
      break;
    }
    case "crew.task_completed": {
      const payload = payloadOf(event, "crew.task_completed");
      body = <CompactEvent title="Task completed" detail={payload.taskId} tone="success" tail={<span>{formatTokens(payload.tokens)} tok&nbsp;&nbsp;{formatCost(payload.costUsd)}</span>} />;
      break;
    }
    case "crew.task_failed": {
      const payload = payloadOf(event, "crew.task_failed");
      body = <CompactEvent title="Task failed" detail={payload.reason} tone="danger" tail={<code>{payload.taskId}</code>} />;
      break;
    }
    case "crew.gate_requested": {
      const payload = payloadOf(event, "crew.gate_requested");
      body = (
        <article className="timeline-gate">
          <div className="timeline-gate__label">Driver decision needed</div>
          <p>{payload.question}</p>
          <code>{payload.taskId}</code>
        </article>
      );
      break;
    }
    case "crew.gate_resolved": {
      const payload = payloadOf(event, "crew.gate_resolved");
      body = <CompactEvent title={payload.approved ? "Gate approved" : "Gate dismissed"} detail={`Resolved by ${actorName(actors, payload.byActorId)}`} tone={payload.approved ? "success" : "warning"} tail={<code>{payload.gateId}</code>} />;
      break;
    }
    case "crew.result_published": {
      const payload = payloadOf(event, "crew.result_published");
      body = (
        <article className="result-card">
          <div className="result-card__top"><span>Published result</span><code>{payload.diffStat}</code></div>
          <p>{payload.summary}</p>
        </article>
      );
      break;
    }
    case "agent.turn_started": {
      const payload = payloadOf(event, "agent.turn_started");
      body = <CompactEvent title={`${agent?.label ?? event.actor.name} started a turn`} detail={payload.taskId} tone="accent" />;
      break;
    }
    case "agent.turn_completed": {
      const payload = payloadOf(event, "agent.turn_completed");
      body = <CompactEvent title="Agent turn complete" detail={payload.taskId} tone="success" tail={<span>{formatTokens(payload.tokens)} tok&nbsp;&nbsp;{formatCost(payload.costUsd)}</span>} />;
      break;
    }
    case "agent.thought": {
      const payload = payloadOf(event, "agent.thought");
      body = (
        <details className="thought-block">
          <summary><span>Agent thought</span><span className="thought-block__preview">{payload.text}</span></summary>
          <p>{payload.text}</p>
        </details>
      );
      break;
    }
    case "agent.command": {
      const payload = payloadOf(event, "agent.command");
      const hasExit = payload.exitCode !== undefined;
      body = (
        <div className="command-block">
          <span className="command-prompt" aria-hidden="true">$</span>
          <code>{payload.command}</code>
          {hasExit && <span className={`exit-code${payload.exitCode === 0 ? " exit-code--ok" : " exit-code--bad"}`}>exit {payload.exitCode}</span>}
        </div>
      );
      break;
    }
    case "agent.diff": {
      const payload = payloadOf(event, "agent.diff");
      const stat = diffStat(payload.patch);
      body = (
        <div
          className={commentTarget ? "annotatable" : undefined}
          onPointerDown={beginLongPress}
          onPointerUp={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onPointerMove={cancelLongPress}
        >
          <details className="diff-block">
            <summary>
              <span className="diff-file">{payload.file}</span>
              <span className="diff-stat"><b>+{stat.additions}</b><i>-{stat.removals}</i></span>
              {commentTarget && (
                <button
                  className="pin-action"
                  type="button"
                  onClick={(clickEvent) => {
                    clickEvent.preventDefault();
                    clickEvent.stopPropagation();
                    onOpenComment(commentTarget);
                  }}
                >
                  Pin note
                </button>
              )}
            </summary>
            <pre
              className="diff-code"
              onClick={() => commentTarget && onOpenComment(commentTarget)}
              title={commentTarget ? "Click to pin a note to this diff" : undefined}
            >
              <code>{payload.patch.split("\n").map((line, index) => <span className={diffLineClass(line)} key={`${event.id}-${index}`}>{line || " "}</span>)}</code>
            </pre>
          </details>
        </div>
      );
      break;
    }
    case "agent.message": {
      const payload = payloadOf(event, "agent.message");
      body = (
        <article
          className={`agent-message${commentTarget ? " annotatable" : ""}`}
          onClick={() => commentTarget && onOpenComment(commentTarget)}
          onPointerDown={beginLongPress}
          onPointerUp={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onPointerMove={cancelLongPress}
          title={commentTarget ? "Click to pin a note to this message" : undefined}
        >
          <div className="agent-message__top">
            <MetaLine actor={event.actor} ts={event.ts} label="reported" />
            {commentTarget && (
              <button
                className="pin-action"
                type="button"
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation();
                  onOpenComment(commentTarget);
                }}
              >
                Pin note
              </button>
            )}
          </div>
          <p>{payload.text}</p>
        </article>
      );
      break;
    }
    case "comment.created": {
      const payload = payloadOf(event, "comment.created");
      body = <CompactEvent title={`${event.actor.name} pinned a note`} detail={payload.anchor.file ?? "Agent message"} tone="warning" tail={<span>{payload.text}</span>} />;
      break;
    }
    case "comment.resolved": {
      const payload = payloadOf(event, "comment.resolved");
      body = <CompactEvent title="Pinned note resolved" detail={payload.viaTaskId ? `Resolved in ${payload.viaTaskId}` : `Resolved by ${actorName(actors, payload.byActorId)}`} tone="success" />;
      break;
    }
    case "ledger.updated": {
      const payload = payloadOf(event, "ledger.updated");
      body = <CompactEvent title="Attribution ledger updated" detail={`${payload.rows.length} ${payload.rows.length === 1 ? "contributor" : "contributors"}`} />;
      break;
    }
    case "preview.updated": {
      const payload = payloadOf(event, "preview.updated");
      body = <CompactEvent title="Live preview refreshed" detail={previewHost(payload.url)} tone="accent" />;
      break;
    }
    default:
      body = <CompactEvent title={`Unknown event: ${String(event.type)}`} detail="This event was preserved in the session log." />;
  }

  return (
    <li
      role="article"
      className={`event-row${newest ? " event-row--new" : ""}${commentable ? " event-row--commentable" : ""}${agent ? " event-row--agent" : ""}`}
      data-event-type={event.type}
      data-agent-id={agentId ?? undefined}
      style={{
        "--avatar-color": agent?.color || colorForActor(event.actor.id),
        "--agent-color": agent?.color || (agentId ? fallbackAgentColor(agentId) : undefined),
      } as CSSProperties}
    >
      <div className="event-rail">
        <Avatar actor={event.actor} size="small" color={agent?.color} />
        <span className="event-rail__line" aria-hidden="true" />
      </div>
      <div className={`event-main${agent ? " event-main--agent" : ""}`}>
        {agent && <AgentChip agent={agent} />}
        {body}
        <CommentPins comments={attachedComments} />
        {activeCommentId === event.id && commentTarget && (
          <InlineCommentComposer
            target={commentTarget}
            onCancel={onCloseComment}
            onSubmit={(text) => onSubmitComment(commentTarget.anchor, text)}
          />
        )}
      </div>
    </li>
  );
}

function Timeline({
  events,
  actors,
  agents,
  comments,
  canComment,
  onComment,
}: {
  events: EnsembleEvent[];
  actors: Map<string, Actor>;
  agents: Map<string, AgentSpec>;
  comments: CommentView[];
  canComment: boolean;
  onComment: (anchor: CommentAnchor, text: string) => boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);

  useEffect(() => {
    if (!followTail.current || !scrollRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events.length]);

  return (
    <section className="timeline-panel" aria-label="Living session timeline">
      <header className="panel-heading timeline-heading">
        <div>
          <h1>Living timeline</h1>
          <span>Agent work and room direction in one stream</span>
        </div>
        <span className="event-count">{events.length} events</span>
      </header>
      <div
        className="timeline-scroll"
        ref={scrollRef}
        onScroll={(scrollEvent) => {
          const element = scrollEvent.currentTarget;
          followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
      >
        {!events.length ? (
          <div className="timeline-empty">
            <div className="timeline-empty__mark" aria-hidden="true">E</div>
            <strong>The room is listening</strong>
            <p>The first steer, agent command, or teammate arrival will appear here.</p>
          </div>
        ) : (
          <ol className="timeline-list" role="feed" aria-live="polite" aria-relevant="additions">
            {events.map((event, index) => (
              <TimelineEvent
                key={event.id}
                event={event}
                newest={index === events.length - 1}
                actors={actors}
                agents={agents}
                comments={comments}
                canComment={canComment}
                activeCommentId={activeCommentId}
                onOpenComment={(target) => setActiveCommentId(target.anchor.eventId ?? null)}
                onCloseComment={() => setActiveCommentId(null)}
                onSubmitComment={onComment}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function PreviewPanel({
  url,
  status,
  detail,
  roomName,
}: {
  url: string;
  status: WorkspaceStatus;
  detail: string;
  roomName: string;
}) {
  const ready = status === "ready";
  return (
    <section className="preview-panel" aria-label="Live app preview">
      <header className="panel-heading preview-heading">
        <div>
          <h2>Live preview</h2>
          <span>{ready ? previewHost(url) : status === "error" ? "Workspace error" : "Provisioning workspace"}</span>
        </div>
        {ready && url && !url.startsWith("data:") && (
          <a href={url} target="_blank" rel="noreferrer">Open</a>
        )}
      </header>
      <div className="preview-stage">
        {ready && url ? (
          <iframe
            key={url}
            src={url}
            title={`${roomName} live application preview`}
            sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className={`preview-empty preview-empty--${status}`}>
            <span className="preview-empty__frame" aria-hidden="true">
              {status === "provisioning" && <i />}
            </span>
            <strong>
              {status === "provisioning"
                ? "Preparing your workspace"
                : status === "error"
                  ? "Workspace unavailable"
                  : "Preview tunnel not published"}
            </strong>
            <p>
              {detail || (status === "provisioning"
                ? "The repository, preview, and agent runtimes are being connected."
                : status === "error"
                  ? "The room remains available for connected agents."
                  : "The live app will dock here after the first preview update.")}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function Composer({
  text,
  setText,
  onSend,
  status,
  isDriver,
  agents,
  selectedAgentId,
  onSelectAgent,
  error,
  mobile = false,
  taskCount = 0,
  gateCount = 0,
  onOpenSheet,
}: {
  text: string;
  setText: (text: string) => void;
  onSend: () => void;
  status: ConnectionStatus;
  isDriver: boolean;
  agents: AgentSpec[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  error: string;
  mobile?: boolean;
  taskCount?: number;
  gateCount?: number;
  onOpenSheet?: (sheet: "queue" | "gates") => void;
}) {
  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <form
      className={`steer-composer${mobile ? " steer-composer--mobile" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <div className="composer-label">
        <label htmlFor={mobile ? "mobile-steer" : "desktop-steer"}>Steer the room</label>
        <span>{isDriver ? "Dispatches directly" : "Driver review required"}</span>
      </div>
      {!!agents.length && (
        <div className="composer-target" role="group" aria-label="Choose an agent for this steer">
          <span>to:</span>
          <div className="composer-target__chips">
            {agents.map((agent) => (
              <button
                key={agent.agentId}
                type="button"
                className={agent.agentId === selectedAgentId ? "is-selected" : ""}
                style={{ "--agent-color": agent.color || fallbackAgentColor(agent.agentId) } as CSSProperties}
                aria-pressed={agent.agentId === selectedAgentId}
                onClick={() => onSelectAgent(agent.agentId)}
              >
                {agentShortLabel(agent)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="composer-input-row">
        <textarea
          id={mobile ? "mobile-steer" : "desktop-steer"}
          rows={mobile ? 1 : 2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKey}
          placeholder="Describe the next visible change"
          disabled={status !== "live"}
          aria-invalid={!!error}
          aria-describedby={error ? `${mobile ? "mobile" : "desktop"}-steer-error` : undefined}
        />
        <button className="send-button" type="submit" disabled={status !== "live" || !text.trim()}>
          Send
        </button>
      </div>
      {mobile && (
        <div className="mobile-panel-actions">
          <button type="button" onClick={() => onOpenSheet?.("queue")}>Queue <b>{taskCount}</b></button>
          <button type="button" onClick={() => onOpenSheet?.("gates")}>Gates <b>{gateCount}</b></button>
        </div>
      )}
      {error && <p className="form-error" id={`${mobile ? "mobile" : "desktop"}-steer-error`} role="alert">{error}</p>}
    </form>
  );
}

function TaskQueue({
  tasks,
  actors,
  agents,
}: {
  tasks: TaskView[];
  actors: Map<string, Actor>;
  agents: Map<string, AgentSpec>;
}) {
  const visibleTasks = tasks.filter((task) => task.status !== "completed");
  return (
    <section className="control-section task-queue">
      <header className="control-section__heading">
        <h3>Task queue</h3>
        <span>{visibleTasks.length}</span>
      </header>
      <div className="control-section__body">
        {!visibleTasks.length ? (
          <div className="control-empty"><strong>Queue clear</strong><span>The next accepted steer lands here.</span></div>
        ) : (
          visibleTasks.map((task) => (
            <article className={`task-item task-item--${task.status}`} key={task.taskId}>
              <div className="task-item__top">
                <span className="task-status-wrap">
                  <span className="task-status">{task.status}</span>
                  {task.agentId && agents.has(task.agentId) && <AgentChip agent={agents.get(task.agentId)!} compact />}
                </span>
                <code>{task.taskId}</code>
              </div>
              <p>{task.text}</p>
              <span className="task-author">Directed by {actorName(actors, task.byActorId)}</span>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function GatePanel({
  gates,
  isDriver,
  driverName,
  onResolve,
}: {
  gates: GateView[];
  isDriver: boolean;
  driverName: string;
  onResolve: (gateId: string, approved: boolean) => boolean;
}) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const pendingTimers = useRef<Set<number>>(new Set<number>());

  useEffect(() => () => {
    for (const timer of pendingTimers.current) window.clearTimeout(timer);
    pendingTimers.current.clear();
  }, []);

  useEffect(() => {
    const openIds = new Set(gates.map((gate) => gate.gateId));
    setPending((current) => new Set([...current].filter((id) => openIds.has(id))));
  }, [gates]);

  const resolve = (gateId: string, approved: boolean) => {
    if (pending.has(gateId)) return;
    if (onResolve(gateId, approved)) {
      setPending((current) => new Set(current).add(gateId));
      const timer = window.setTimeout(() => {
        pendingTimers.current.delete(timer);
        setPending((current) => {
          const next = new Set(current);
          next.delete(gateId);
          return next;
        });
      }, 5_000);
      pendingTimers.current.add(timer);
    }
  };

  return (
    <section className="control-section gate-panel">
      <header className="control-section__heading">
        <h3>Gates</h3>
        <span className={gates.length ? "count-alert" : ""}>{gates.length}</span>
      </header>
      <div className="control-section__body">
        {!gates.length ? (
          <div className="control-empty"><strong>No decisions waiting</strong><span>Teammate steers will pause here for the driver.</span></div>
        ) : (
          gates.map((gate) => (
            <article className="gate-card" key={gate.gateId}>
              <div className="gate-card__top"><span>Decision needed</span><code>{gate.taskId}</code></div>
              <p>{gate.question}</p>
              {isDriver ? (
                <div className="gate-actions">
                  <button className="button button--quiet" disabled={pending.has(gate.gateId)} type="button" onClick={() => resolve(gate.gateId, false)}>Dismiss</button>
                  <button className="button button--accent" disabled={pending.has(gate.gateId)} type="button" onClick={() => resolve(gate.gateId, true)}>Approve</button>
                </div>
              ) : (
                <span className="gate-waiting">Waiting for {driverName}</span>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function MobileSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.querySelector<HTMLElement>(".app-shell");
    app?.setAttribute("inert", "");
    sheetRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (sheetRef.current) trapFocus(event, sheetRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      app?.removeAttribute("inert");
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={sheetRef} tabIndex={-1} className="mobile-sheet" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label={`Close ${title}`}>Close</button>
        </header>
        <div className="mobile-sheet__body">{children}</div>
      </section>
    </div>
  );
}

function Ledger({ rows, presence }: { rows: LedgerRow[]; presence: Actor[] }) {
  const displayRows = rows.length
    ? rows
    : presence.map((actor) => ({ actorId: actor.id, name: actor.name, steers: 0, tokens: 0, costUsd: 0, outcomes: [] }));

  return (
    <footer className="ledger" aria-label="Attribution ledger">
      <div className="ledger__title">
        <span>Attribution</span>
        <strong>Ledger</strong>
      </div>
      <div className="ledger__rows">
        {!displayRows.length ? (
          <span className="ledger-empty">Contributions will be attributed as the room works.</span>
        ) : (
          displayRows.map((row) => {
            const actor: Actor = { id: row.actorId, name: row.name, kind: "human" };
            return (
              <article className="ledger-person" key={row.actorId}>
                <Avatar actor={actor} size="small" />
                <div className="ledger-person__identity">
                  <strong>{row.name}</strong>
                  <div
                    className="ledger-person__outcomes"
                    role="region"
                    aria-label={`${row.name} outcomes`}
                    tabIndex={0}
                  >
                    {row.outcomes.length ? row.outcomes.join(" | ") : "No published outcome yet"}
                  </div>
                </div>
                <dl>
                  <div><dt>steers</dt><dd>{row.steers}</dd></div>
                  <div><dt>tokens</dt><dd>{formatTokens(row.tokens)}</dd></div>
                  <div><dt>cost</dt><dd>{formatCost(row.costUsd)}</dd></div>
                </dl>
              </article>
            );
          })
        )}
      </div>
    </footer>
  );
}

function JoinDialog({ initialName, mockMode, onJoin }: { initialName: string; mockMode: boolean; onJoin: (name: string) => void }) {
  const [name, setName] = useState(initialName || (mockMode ? "Mara Chen" : ""));
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".app-shell");
    app?.setAttribute("inert", "");
    const nameInput = dialogRef.current?.querySelector<HTMLInputElement>("input");
    if (nameInput) nameInput.focus();
    else dialogRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (dialogRef.current) trapFocus(event, dialogRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      app?.removeAttribute("inert");
    };
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) {
      setError("Enter the name your teammates will recognize.");
      return;
    }
    onJoin(clean.slice(0, 48));
  };

  return (
    <div className="join-overlay">
      <section ref={dialogRef} tabIndex={-1} className="join-dialog" role="dialog" aria-modal="true" aria-labelledby="join-title">
        <div className="join-dialog__brand">ENSEMBLE</div>
        <h1 id="join-title">Join the live build</h1>
        <p>Watch the agents work and join your team while the room builds.</p>
        <form onSubmit={submit}>
          <label htmlFor="join-name">Your name</label>
          <input
            id="join-name"
            autoFocus
            autoComplete="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            placeholder="How should the room know you?"
            aria-invalid={!!error}
            aria-describedby={error ? "join-name-error" : "join-name-help"}
          />
          <span className="input-help" id="join-name-help">This name appears in the room presence.</span>
          {error && <p className="form-error" id="join-name-error" role="alert">{error}</p>}
          <button className="join-button" type="submit">Enter session</button>
        </form>
        {mockMode && <span className="join-dialog__mock">Standalone two-agent session</span>}
      </section>
    </div>
  );
}

type RoomWithLinkVariants = RoomRecord & {
  links?: { steer?: string; view?: string; canSteer?: string; canView?: string };
  steerLink?: string;
  viewLink?: string;
};

function absoluteUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    return new URL(value, window.location.origin).href;
  } catch {
    return undefined;
  }
}

function roomInviteLinks(
  room: RoomRecord | null,
  roomId: string,
  key: string,
  role: "steerer" | "viewer" | null,
  mockMode: boolean,
) {
  const shaped = room as RoomWithLinkVariants | null;
  const buildFromToken = (token: string | undefined) => {
    if (!token) return undefined;
    const url = new URL(`/s/${encodeURIComponent(roomId)}`, window.location.origin);
    url.searchParams.set("k", token);
    if (mockMode) url.searchParams.set("mock", "1");
    return url.href;
  };
  const currentRoleLink = () => {
    if (!key) return undefined;
    return buildFromToken(key);
  };

  const steerLink = absoluteUrl(shaped?.links?.steer ?? shaped?.links?.canSteer ?? shaped?.steerLink)
    ?? buildFromToken(shaped?.invites?.steer)
    ?? (role === "steerer" ? currentRoleLink() : undefined);
  const viewLink = absoluteUrl(shaped?.links?.view ?? shaped?.links?.canView ?? shaped?.viewLink)
    ?? buildFromToken(shaped?.invites?.view)
    ?? (role === "viewer" ? currentRoleLink() : undefined);
  return { steerLink, viewLink };
}

function MobileViewerControls({
  taskCount,
  gateCount,
  onOpenSheet,
}: {
  taskCount: number;
  gateCount: number;
  onOpenSheet: (sheet: "queue" | "gates") => void;
}) {
  return (
    <div className="mobile-viewer-controls" aria-label="View-only session controls">
      <span>View only</span>
      <button type="button" onClick={() => onOpenSheet("queue")}>Queue <b>{taskCount}</b></button>
      <button type="button" onClick={() => onOpenSheet("gates")}>Gates <b>{gateCount}</b></button>
    </div>
  );
}

function SessionPage({
  roomId,
  keyToken,
  params,
  mockMode,
}: {
  roomId: string;
  keyToken: string;
  params: URLSearchParams;
  mockMode: boolean;
}) {
  const queryName = (params.get("name") ?? "").trim();
  const [joinedName, setJoinedName] = useState(queryName);
  const [steerText, setSteerText] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [composerError, setComposerError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [mobileSheet, setMobileSheet] = useState<"queue" | "gates" | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const session = useSession({ name: joinedName, roomId, key: keyToken, mockMode });
  const derived = useMemo(() => deriveSession(session.events, session.room), [session.events, session.room]);

  const presence = useMemo(() => {
    if (!session.actorId || derived.presence.some((actor) => actor.id === session.actorId)) return derived.presence;
    return [{ id: session.actorId, name: joinedName, kind: "human" as const }, ...derived.presence];
  }, [derived.presence, joinedName, session.actorId]);

  const actors = useMemo(() => {
    const directory = new Map(derived.actors);
    for (const actor of presence) directory.set(actor.id, actor);
    return directory;
  }, [derived.actors, presence]);

  const agentDirectory = useMemo(
    () => new Map(derived.agents.map((agent) => [agent.agentId, agent])),
    [derived.agents],
  );

  const isViewer = session.role === "viewer";
  const isDriver = !!session.actorId && session.actorId === session.driverActorId;
  const driverName = actorName(actors, session.driverActorId);
  const visibleTaskCount = derived.tasks.filter((task) => task.status !== "completed").length;
  const roomName = session.room?.name ?? (mockMode ? "Roomboard multi-agent build" : `Session ${roomId}`);
  const shareLinks = useMemo(
    () => roomInviteLinks(session.room, roomId, keyToken, session.role, mockMode),
    [keyToken, mockMode, roomId, session.role, session.room],
  );

  useEffect(() => {
    document.title = `${mockMode ? "Mock | " : ""}${roomName} | Ensemble`;
  }, [mockMode, roomName]);

  useEffect(() => {
    if (!derived.agents.length) {
      setSelectedAgentId("");
      return;
    }
    if (!derived.agents.some((agent) => agent.agentId === selectedAgentId)) {
      setSelectedAgentId(derived.agents[0].agentId);
    }
  }, [derived.agents, selectedAgentId]);

  useEffect(() => {
    if (!actionMessage) return;
    const timer = window.setTimeout(() => setActionMessage(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [actionMessage]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeMobileSheetAtDesktop = () => {
      if (desktop.matches) setMobileSheet(null);
    };

    closeMobileSheetAtDesktop();
    desktop.addEventListener("change", closeMobileSheetAtDesktop);
    return () => desktop.removeEventListener("change", closeMobileSheetAtDesktop);
  }, []);

  const sendSteer = () => {
    const text = steerText.trim();
    if (!text) {
      setComposerError("Describe the change you want to make.");
      return;
    }
    if (isViewer) {
      setComposerError("This invite is view only.");
      return;
    }
    if (!session.send({ type: "steer", text, agentId: selectedAgentId || undefined })) {
      setComposerError("The steer could not be sent while disconnected.");
      return;
    }
    setSteerText("");
    setComposerError("");
  };

  const sendComment = (anchor: CommentAnchor, text: string) =>
    !isViewer && session.send({ type: "comment", anchor, text });

  const resolveGate = (gateId: string, approved: boolean) => {
    const sent = session.send({ type: "resolveGate", gateId, approved });
    setActionMessage(sent ? (approved ? "Gate approved" : "Gate dismissed") : "The gate could not be resolved.");
    return sent;
  };

  const handoff = (toActorId: string) => {
    const sent = session.send({ type: "handoff", toActorId });
    setActionMessage(sent ? `Driver control handed to ${actorName(actors, toActorId)}` : "Driver control could not be handed off.");
  };

  const interrupt = () => {
    const sent = session.send({ type: "interrupt" });
    setActionMessage(sent ? "Interrupt sent. The task will return to the queue." : "The active turn could not be interrupted.");
  };

  const transportNotice = session.transportMessage || actionMessage;

  return (
    <>
      <main className={`app-shell${isViewer ? " app-shell--viewer" : ""}`}>
        <Header
          actors={presence}
          agents={derived.registeredAgents}
          actorId={session.actorId}
          driverActorId={session.driverActorId}
          isDriver={isDriver}
          isViewer={isViewer}
          status={session.status}
          roomName={roomName}
          mockMode={mockMode}
          onHandoff={handoff}
          onInterrupt={interrupt}
          onShare={() => setShareOpen(true)}
        />

        <div className="workspace">
          <Timeline
            events={session.events}
            actors={actors}
            agents={agentDirectory}
            comments={derived.comments}
            canComment={!isViewer}
            onComment={sendComment}
          />
          <aside className="right-rail" aria-label="Preview and session controls">
            <PreviewPanel
              url={derived.previewUrl}
              status={derived.workspaceStatus}
              detail={derived.workspaceDetail}
              roomName={roomName}
            />
            <div className={`control-deck${isViewer ? " control-deck--viewer" : ""}`}>
              {!isViewer && (
                <Composer
                  text={steerText}
                  setText={(text) => {
                    setSteerText(text);
                    setComposerError("");
                  }}
                  onSend={sendSteer}
                  status={session.status}
                  isDriver={isDriver}
                  agents={derived.agents}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={setSelectedAgentId}
                  error={composerError}
                />
              )}
              <div className="queue-gate-grid">
                <TaskQueue tasks={derived.tasks} actors={actors} agents={agentDirectory} />
                <GatePanel gates={derived.gates} isDriver={isDriver && !isViewer} driverName={driverName} onResolve={resolveGate} />
              </div>
            </div>
          </aside>
        </div>

        {isViewer ? (
          <MobileViewerControls
            taskCount={visibleTaskCount}
            gateCount={derived.gates.length}
            onOpenSheet={setMobileSheet}
          />
        ) : (
          <div className="mobile-composer-wrap">
            <Composer
              text={steerText}
              setText={(text) => {
                setSteerText(text);
                setComposerError("");
              }}
              onSend={sendSteer}
              status={session.status}
              isDriver={isDriver}
              agents={derived.agents}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
              error={composerError}
              mobile
              taskCount={visibleTaskCount}
              gateCount={derived.gates.length}
              onOpenSheet={setMobileSheet}
            />
          </div>
        )}

        <Ledger rows={derived.ledger} presence={presence} />
      </main>

      {transportNotice && <div className="status-toast" role="status">{transportNotice}</div>}

      {mobileSheet === "queue" && (
        <MobileSheet title="Task queue" onClose={() => setMobileSheet(null)}>
          <TaskQueue tasks={derived.tasks} actors={actors} agents={agentDirectory} />
        </MobileSheet>
      )}
      {mobileSheet === "gates" && (
        <MobileSheet title="Driver gates" onClose={() => setMobileSheet(null)}>
          <GatePanel gates={derived.gates} isDriver={isDriver && !isViewer} driverName={driverName} onResolve={resolveGate} />
        </MobileSheet>
      )}

      {!joinedName && <JoinDialog initialName={queryName} mockMode={mockMode} onJoin={setJoinedName} />}
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} {...shareLinks} />
    </>
  );
}

interface BrowserRoute {
  pathname: string;
  search: string;
}

function readBrowserRoute(): BrowserRoute {
  return { pathname: window.location.pathname, search: window.location.search };
}

function NotFound({ onHome }: { onHome: () => void }) {
  useEffect(() => {
    document.title = "Session not found | Ensemble";
  }, []);

  return (
    <main className="not-found-page">
      <div>
        <span className="brand-word">ENSEMBLE</span>
        <h1>Session not found</h1>
        <p>This link does not point to an Ensemble room.</p>
        <button type="button" onClick={onHome}>Back home</button>
      </div>
    </main>
  );
}

export default function App() {
  const [route, setRoute] = useState<BrowserRoute>(readBrowserRoute);

  useEffect(() => {
    const onPopState = () => setRoute(readBrowserRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (href: string) => {
    const destination = new URL(href, window.location.href);
    if (destination.origin !== window.location.origin) {
      window.location.assign(destination.href);
      return;
    }
    window.history.pushState({}, "", `${destination.pathname}${destination.search}${destination.hash}`);
    setRoute(readBrowserRoute());
  };

  const params = new URLSearchParams(route.search);
  const mockMode = params.get("mock") === "1";
  const sessionMatch = route.pathname.match(/^\/s\/([^/]+)\/?$/);

  if (mockMode && route.pathname === "/") {
    const keyToken = params.get("k") || (params.get("role") === "view" ? "mock-view" : "mock-steer");
    return <SessionPage key={`mock:${keyToken}`} roomId="mock" keyToken={keyToken} params={params} mockMode />;
  }

  if (route.pathname === "/" || route.pathname === "") {
    return <HomePage onNavigate={navigate} />;
  }

  if (sessionMatch) {
    const roomId = decodeURIComponent(sessionMatch[1]);
    return (
      <SessionPage
        key={`${roomId}:${params.get("k") ?? ""}:${mockMode}`}
        roomId={roomId}
        keyToken={params.get("k") ?? ""}
        params={params}
        mockMode={mockMode}
      />
    );
  }

  return <NotFound onHome={() => navigate("/")} />;
}
