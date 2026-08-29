import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMockActors,
  createMockBeats,
  createMockRoom,
  mockPreviewUrl,
  MOCK_DEEP,
  MOCK_TURBO,
} from "./mock";
import type {
  Actor,
  ClientMessage,
  ConnectionStatus,
  EnsembleEvent,
  EventPayloads,
  EventType,
  LedgerRow,
  RoomRecord,
  SessionRole,
} from "./types";

interface WelcomeFrame {
  type: "welcome";
  actorId: string;
  driverActorId: string | null;
  events: EnsembleEvent[];
  room?: RoomRecord;
  role?: SessionRole;
}

interface EventFrame {
  type: "event";
  event: EnsembleEvent;
}

interface ErrorFrame {
  type: "error";
  message?: string;
}

type IncomingFrame = WelcomeFrame | EventFrame | ErrorFrame;

function isEvent(value: unknown): value is EnsembleEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<EnsembleEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.ts === "number" &&
    typeof event.seq === "number" &&
    typeof event.type === "string" &&
    !!event.actor &&
    typeof event.payload === "object"
  );
}

export function mergeEvents(current: EnsembleEvent[], incoming: EnsembleEvent[]) {
  const bySequence = new Map<number, EnsembleEvent>();
  for (const event of current) bySequence.set(event.seq, event);
  for (const event of incoming) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq || a.ts - b.ts);
}

function websocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function applyRoomEvent(room: RoomRecord | null, event: EnsembleEvent) {
  if (!room) return room;
  if (event.type === "room.created") {
    const payload = event.payload as EventPayloads["room.created"];
    return { ...room, name: payload.name, goal: payload.goal };
  }
  if (event.type === "workspace.status") {
    const payload = event.payload as EventPayloads["workspace.status"];
    return { ...room, workspace: { ...room.workspace, status: payload.status, detail: payload.detail } };
  }
  if (event.type === "preview.updated") {
    const payload = event.payload as EventPayloads["preview.updated"];
    return { ...room, workspace: { ...room.workspace, previewUrl: payload.url } };
  }
  if (event.type === "agent.registered") {
    const payload = event.payload as EventPayloads["agent.registered"];
    return {
      ...room,
      agents: room.agents.map((agent) =>
        agent.agentId === payload.agentId
          ? { ...agent, label: payload.label, model: payload.model }
          : agent,
      ),
    };
  }
  return room;
}

export interface UseSessionOptions {
  name: string;
  roomId: string;
  key: string;
  mockMode: boolean;
}

export interface SessionState {
  events: EnsembleEvent[];
  actorId: string | null;
  driverActorId: string | null;
  status: ConnectionStatus;
  transportMessage: string;
  room: RoomRecord | null;
  role: SessionRole | null;
  send: (message: ClientMessage) => boolean;
}

export function useSession(options: UseSessionOptions): SessionState;
export function useSession(name: string, mockMode: boolean): SessionState;
export function useSession(
  optionsOrName: UseSessionOptions | string,
  legacyMockMode = false,
): SessionState {
  const options = typeof optionsOrName === "string"
    ? { name: optionsOrName, roomId: "demo", key: "", mockMode: legacyMockMode }
    : optionsOrName;
  const { name, roomId, key, mockMode } = options;
  const [events, setEvents] = useState<EnsembleEvent[]>([]);
  const [actorId, setActorId] = useState<string | null>(null);
  const [driverActorId, setDriverActorId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(name ? "connecting" : "idle");
  const [transportMessage, setTransportMessage] = useState("");
  const [room, setRoom] = useState<RoomRecord | null>(null);
  const [role, setRole] = useState<SessionRole | null>(null);

  const eventsRef = useRef<EnsembleEvent[]>([]);
  const driverRef = useRef<string | null>(null);
  const sendRef = useRef<(message: ClientMessage) => boolean>(() => false);

  const replaceEvents = useCallback((updater: (current: EnsembleEvent[]) => EnsembleEvent[]) => {
    setEvents((current) => {
      const next = updater(current);
      eventsRef.current = next;
      return next;
    });
  }, []);

  const updateDriver = useCallback((next: string | null) => {
    driverRef.current = next;
    setDriverActorId(next);
  }, []);

  useEffect(() => {
    eventsRef.current = [];
    driverRef.current = null;
    setEvents([]);
    setActorId(null);
    setDriverActorId(null);
    setTransportMessage("");
    setRoom(null);
    setRole(null);
    sendRef.current = () => false;

    if (!name) {
      setStatus("idle");
      return;
    }

    if (mockMode) {
      let active = true;
      let sequence = 0;
      let localId = 0;
      let localSteers = 0;
      let storyPausedUntil = 0;
      let latestScriptLedgerRows: LedgerRow[] = [];
      const cancelledTasks = new Set<string>();
      const gateAgents = new Map<string, string>();
      const timers = new Set<number>();
      const { current, arjun, priya, system } = createMockActors(name);
      const mockRoom = createMockRoom();
      const mockRole: SessionRole = key === mockRoom.invites?.view ? "viewer" : "steerer";
      const canonicalHumans = [current, arjun, priya];
      const startedAt = Date.now();

      const emit = <K extends EventType>(
        type: K,
        actor: Actor,
        payload: EventPayloads[K],
        id = `mock_local_${++localId}`,
        ts = Date.now(),
      ) => {
        if (!active) return;
        const event = { id, ts, seq: ++sequence, type, actor, payload } as EnsembleEvent;
        if (type === "driver.changed") {
          updateDriver((payload as EventPayloads["driver.changed"]).toActorId);
        }
        setRoom((currentRoom) => applyRoomEvent(currentRoom, event));
        replaceEvents((currentEvents) => mergeEvents(currentEvents, [event]));
      };

      const later = (delay: number, task: () => void) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          task();
        }, delay);
        timers.add(timer);
      };

      const storyTaskForBeat = (beat: ReturnType<typeof createMockBeats>[number]) => {
        const payload = beat.payload as { taskId?: string; viaTaskId?: string };
        if (payload.taskId) return payload.taskId;
        if (payload.viaTaskId) return payload.viaTaskId;
        if (/votes|vote_fix/.test(beat.id)) return "task_votes";
        if (/theme|preview_complete/.test(beat.id)) return "task_theme";
        if (/pulse/.test(beat.id)) return "task_pulse";
        return undefined;
      };

      const ledgerRowsWithLocalWork = (rows: LedgerRow[]) => {
        const adjusted = rows.map((row) => {
          if (row.actorId === arjun.id && cancelledTasks.has("task_votes")) {
            return { ...row, tokens: 0, costUsd: 0, outcomes: row.outcomes.filter((outcome) => !outcome.includes("upvotes")) };
          }
          if (row.actorId === priya.id && cancelledTasks.has("task_theme")) {
            return { ...row, tokens: 0, costUsd: 0, outcomes: row.outcomes.filter((outcome) => !outcome.includes("Roomboard")) };
          }
          return { ...row, outcomes: [...row.outcomes] };
        });
        const currentRow = adjusted.find((row) => row.actorId === current.id);
        if (currentRow) currentRow.steers += localSteers;
        else adjusted.unshift({ actorId: current.id, name: current.name, steers: localSteers, tokens: 0, costUsd: 0, outcomes: [] });
        return adjusted;
      };

      const publishLocalLedger = () => {
        const baseRows = latestScriptLedgerRows.length
          ? latestScriptLedgerRows
          : canonicalHumans.map((actor) => ({
              actorId: actor.id,
              name: actor.name,
              steers: 0,
              tokens: 0,
              costUsd: 0,
              outcomes: [] as string[],
            }));
        emit("ledger.updated", system, { rows: ledgerRowsWithLocalWork(baseRows) });
      };

      setActorId(current.id);
      updateDriver(mockRole === "viewer" ? arjun.id : current.id);
      setRoom(mockRoom);
      setRole(mockRole);
      setStatus("live");
      setTransportMessage("Mock session running on local time");
      later(2_200, () => setTransportMessage(""));

      const runStoryBeat = (beat: ReturnType<typeof createMockBeats>[number]) => {
          const pauseRemaining = storyPausedUntil - Date.now();
          if (pauseRemaining > 0) {
            later(pauseRemaining + 8, () => runStoryBeat(beat));
            return;
          }
          const storyTaskId = storyTaskForBeat(beat);
          if (storyTaskId && cancelledTasks.has(storyTaskId)) return;
          if (mockRole === "viewer" && beat.id === "mock_driver_current") {
            emit(
              "driver.changed",
              beat.actor,
              { toActorId: arjun.id },
              beat.id,
              Math.max(startedAt + beat.at, Date.now()),
            );
            return;
          }
          if (beat.type === "crew.gate_resolved") {
            const incoming = beat.payload as EventPayloads["crew.gate_resolved"];
            const alreadyResolved = eventsRef.current.some(
              (event) =>
                event.type === "crew.gate_resolved" &&
                (event.payload as EventPayloads["crew.gate_resolved"]).gateId === incoming.gateId,
            );
            if (alreadyResolved) return;
            const activeDriver = canonicalHumans.find((actor) => actor.id === driverRef.current);
            if (activeDriver) {
              emit(
                "crew.gate_resolved",
                activeDriver,
                { ...incoming, byActorId: activeDriver.id },
                beat.id,
                Math.max(startedAt + beat.at, Date.now()),
              );
              return;
            }
          }
          if (beat.type === "crew.task_dispatched") {
            const incoming = beat.payload as EventPayloads["crew.task_dispatched"];
            const alreadyDispatched = eventsRef.current.some(
              (event) =>
                event.type === "crew.task_dispatched" &&
                (event.payload as EventPayloads["crew.task_dispatched"]).taskId === incoming.taskId,
            );
            const gate = eventsRef.current.find(
              (event) =>
                event.type === "crew.gate_requested" &&
                (event.payload as EventPayloads["crew.gate_requested"]).taskId === incoming.taskId,
            );
            const gateId = gate && (gate.payload as EventPayloads["crew.gate_requested"]).gateId;
            const resolution = gateId && eventsRef.current.find(
              (event) =>
                event.type === "crew.gate_resolved" &&
                (event.payload as EventPayloads["crew.gate_resolved"]).gateId === gateId,
            );
            if (alreadyDispatched || (resolution && !(resolution.payload as EventPayloads["crew.gate_resolved"]).approved)) return;
          }
          if (beat.type === "ledger.updated") {
            latestScriptLedgerRows = (beat.payload as EventPayloads["ledger.updated"]).rows;
            emit("ledger.updated", beat.actor, { rows: ledgerRowsWithLocalWork(latestScriptLedgerRows) }, beat.id, Math.max(startedAt + beat.at, Date.now()));
            return;
          }
          if (
            beat.type === "preview.updated" &&
            beat.id === "mock_preview_complete" &&
            cancelledTasks.has("task_votes")
          ) {
            emit(
              "preview.updated",
              beat.actor,
              {
                url: mockPreviewUrl("complete", false),
                agentId: (beat.payload as EventPayloads["preview.updated"]).agentId,
              },
              beat.id,
              Math.max(startedAt + beat.at, Date.now()),
            );
            return;
          }
          emit(beat.type, beat.actor, beat.payload as never, beat.id, Math.max(startedAt + beat.at, Date.now()));
      };

      for (const beat of createMockBeats(name)) {
        later(beat.at, () => runStoryBeat(beat));
      }

      sendRef.current = (message) => {
        if (!active || mockRole === "viewer") return false;
        setTransportMessage("");

        if (message.type === "steer") {
          const text = message.text.trim();
          if (!text) return false;
          const agentId = mockRoom.agents.some((agent) => agent.agentId === message.agentId)
            ? message.agentId
            : mockRoom.agents[0]?.agentId;
          const requestNumber = ++localId;
          const taskId = `task_local_${requestNumber}`;
          const gateId = `gate_local_${requestNumber}`;
          emit("crew.actor_post", current, { text });
          localSteers += 1;
          publishLocalLedger();
          if (driverRef.current === current.id) {
            later(280, () =>
              emit("crew.task_dispatched", system, { taskId, text, byActorId: current.id, agentId }),
            );
          } else {
            if (agentId) gateAgents.set(gateId, agentId);
            later(280, () =>
              emit("crew.gate_requested", system, { gateId, question: `${current.name} wants: ${text} Dispatch?`, taskId }),
            );
          }
          return true;
        }

        if (message.type === "comment") {
          const text = message.text.trim();
          if (!text) return false;
          emit("comment.created", current, {
            commentId: `comment_local_${++localId}`,
            anchor: message.anchor,
            text,
          });
          return true;
        }

        if (message.type === "resolveGate") {
          const alreadyResolved = eventsRef.current.some(
            (event) =>
              event.type === "crew.gate_resolved" &&
              (event.payload as EventPayloads["crew.gate_resolved"]).gateId === message.gateId,
          );
          if (alreadyResolved || driverRef.current !== current.id) return false;
          const request = eventsRef.current.find(
            (event) =>
              event.type === "crew.gate_requested" &&
              (event.payload as EventPayloads["crew.gate_requested"]).gateId === message.gateId,
          );
          emit("crew.gate_resolved", current, {
            gateId: message.gateId,
            approved: message.approved,
            byActorId: current.id,
          });
          if (!message.approved && request) {
            cancelledTasks.add((request.payload as EventPayloads["crew.gate_requested"]).taskId);
            gateAgents.delete(message.gateId);
          }
          if (message.approved && request) {
            const gate = request.payload as EventPayloads["crew.gate_requested"];
            const text = gate.question.replace(/^.+? wants:\s*/, "").replace(/\s*Dispatch\?$/, "");
            const originalAuthor = [...eventsRef.current]
              .reverse()
              .map((event) => event.actor)
              .find((actor) => actor.kind === "human" && gate.question.startsWith(`${actor.name} wants:`));
            const agentId = gateAgents.get(message.gateId) ?? mockRoom.agents[0]?.agentId;
            gateAgents.delete(message.gateId);
            later(320, () =>
              emit("crew.task_dispatched", system, { taskId: gate.taskId, text, byActorId: originalAuthor?.id ?? current.id, agentId }),
            );
          }
          return true;
        }

        if (message.type === "handoff") {
          if (driverRef.current !== current.id || message.toActorId === current.id) return false;
          emit("driver.changed", current, { toActorId: message.toActorId });
          return true;
        }

        if (message.type === "interrupt") {
          if (driverRef.current !== current.id) return false;
          const taskStates = new Map<string, "queued" | "running" | "settled">();
          for (const event of eventsRef.current) {
            if (event.type === "crew.task_dispatched") taskStates.set((event.payload as EventPayloads["crew.task_dispatched"]).taskId, "queued");
            if (event.type === "agent.turn_started") taskStates.set((event.payload as EventPayloads["agent.turn_started"]).taskId, "running");
            if (event.type === "agent.turn_completed") taskStates.set((event.payload as EventPayloads["agent.turn_completed"]).taskId, "settled");
            if (event.type === "crew.task_completed") taskStates.set((event.payload as EventPayloads["crew.task_completed"]).taskId, "settled");
            if (event.type === "crew.task_failed") taskStates.set((event.payload as EventPayloads["crew.task_failed"]).taskId, "settled");
          }
          const activeTaskId = [...taskStates].reverse().find(([, taskStatus]) => taskStatus === "running")?.[0];
          if (!activeTaskId) return false;
          const dispatch = [...eventsRef.current].reverse().find(
            (event) =>
              event.type === "crew.task_dispatched" &&
              (event.payload as EventPayloads["crew.task_dispatched"]).taskId === activeTaskId,
          );
          if (!dispatch) return false;
          const task = dispatch.payload as EventPayloads["crew.task_dispatched"];
          const interruptedAgentId = task.agentId ?? mockRoom.agents[0]?.agentId ?? "turbo";
          const interruptedAgent = interruptedAgentId === "deep" ? MOCK_DEEP : MOCK_TURBO;
          storyPausedUntil = Math.max(storyPausedUntil, Date.now() + 1_400);
          emit("agent.message", interruptedAgent, {
            text: "Turn interrupted. The active task is back in the queue and will resume shortly.",
            agentId: interruptedAgentId,
          });
          emit("crew.task_dispatched", system, task);
          later(1_200, () => emit("agent.turn_started", interruptedAgent, { taskId: activeTaskId, agentId: interruptedAgentId }));
          return true;
        }

        return false;
      };

      return () => {
        active = false;
        for (const timer of timers) window.clearTimeout(timer);
        timers.clear();
        sendRef.current = () => false;
      };
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let reconnectAttempt = 0;
    let welcomed = false;
    let driverAuthoritySeq = -1;

    const connect = () => {
      if (disposed) return;
      setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      setTransportMessage(reconnectAttempt === 0 ? "Opening session" : "Rejoining session");

      const ws = new WebSocket(websocketUrl());
      socket = ws;
      welcomed = false;

      ws.addEventListener("open", () => {
        if (disposed || socket !== ws) return;
        ws.send(JSON.stringify({ type: "join", roomId, name, key }));
      });

      ws.addEventListener("message", (messageEvent) => {
        if (disposed || socket !== ws || typeof messageEvent.data !== "string") return;
        let frame: IncomingFrame;
        try {
          frame = JSON.parse(messageEvent.data) as IncomingFrame;
        } catch {
          setTransportMessage("A malformed server frame was ignored");
          return;
        }

        if (frame.type === "welcome") {
          const replay = Array.isArray(frame.events) ? frame.events.filter(isEvent) : [];
          const replayHighSequence = replay.length ? Math.max(...replay.map((event) => event.seq)) : -1;
          replaceEvents((currentEvents) => {
            if (!currentEvents.length) return mergeEvents([], replay);
            const previousMax = Math.max(...currentEvents.map((event) => event.seq));
            const replayMax = replay.length ? Math.max(...replay.map((event) => event.seq)) : -1;
            const previousIds = new Set(currentEvents.map((event) => event.id));
            const sharesIdentity = replay.some((event) => previousIds.has(event.id));
            if (!replay.length || (replayMax < previousMax && !sharesIdentity)) {
              return mergeEvents([], replay);
            }
            return mergeEvents(currentEvents, replay);
          });
          const replayedRoom = replay.reduce<RoomRecord | null>(
            (currentRoom, event) => applyRoomEvent(currentRoom, event),
            frame.room ?? null,
          );
          setActorId(frame.actorId);
          setRoom(replayedRoom);
          setRole(frame.role ?? "steerer");
          driverAuthoritySeq = replayHighSequence;
          updateDriver(frame.driverActorId ?? null);
          welcomed = true;
          reconnectAttempt = 0;
          setStatus("live");
          setTransportMessage("");
          return;
        }

        if (frame.type === "error") {
          setTransportMessage(frame.message?.trim() || "The server rejected that session action");
          return;
        }

        if (frame.type === "event" && isEvent(frame.event)) {
          if (frame.event.type === "driver.changed" && frame.event.seq > driverAuthoritySeq) {
            driverAuthoritySeq = frame.event.seq;
            updateDriver((frame.event.payload as EventPayloads["driver.changed"]).toActorId);
          }
          setRoom((currentRoom) => applyRoomEvent(currentRoom, frame.event));
          replaceEvents((currentEvents) => mergeEvents(currentEvents, [frame.event]));
        }
      });

      ws.addEventListener("close", () => {
        if (disposed || socket !== ws) return;
        socket = null;
        welcomed = false;
        sendRef.current = () => false;
        const delay = Math.min(500 * 2 ** reconnectAttempt, 8_000) + Math.round(Math.random() * 160);
        reconnectAttempt += 1;
        setStatus(navigator.onLine ? "reconnecting" : "offline");
        setTransportMessage(`Connection lost. Retrying in ${Math.max(1, Math.round(delay / 1_000))}s`);
        retryTimer = window.setTimeout(connect, delay);
      });

      ws.addEventListener("error", () => {
        if (socket === ws) ws.close();
      });

      sendRef.current = (message) => {
        if (!welcomed || socket !== ws || ws.readyState !== WebSocket.OPEN) return false;
        setTransportMessage("");
        ws.send(JSON.stringify(message));
        return true;
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (socket) socket.close();
      sendRef.current = () => false;
    };
  }, [key, mockMode, name, replaceEvents, roomId, updateDriver]);

  const send = useCallback((message: ClientMessage) => sendRef.current(message), []);

  return {
    events,
    actorId,
    driverActorId,
    status,
    transportMessage,
    room,
    role,
    send,
  };
}
