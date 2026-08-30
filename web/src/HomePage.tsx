import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { GracefulState } from "./GracefulState";
import { JellyButtonContent } from "./JellyButtonContent";
import "./home.css";

type AgentId = "turbo" | "deep" | "sol" | "luna" | "terra" | "fable" | "opus" | "sonnet";
type LoadState = "loading" | "ready" | "error";

interface AgentChoice {
  agentId: AgentId;
  shortLabel: string;
  label: string;
  engine: "runner" | "reflex";
  model: string;
}

interface HomeRoom {
  roomId: string;
  name: string;
  status: string;
  createdAt: string | number | null;
}

interface FormErrors {
  name?: string;
  goal?: string;
  agents?: string;
  repoUrl?: string;
  importThreadId?: string;
}

const AGENT_CHOICES: AgentChoice[] = [
  {
    agentId: "turbo",
    shortLabel: "Turbo",
    label: "Codex Turbo",
    engine: "runner",
    model: "gpt-5.3-codex-spark",
  },
  {
    agentId: "deep",
    shortLabel: "Deep",
    label: "Codex Deep",
    engine: "runner",
    model: "gpt-5.5",
  },
  {
    agentId: "sol",
    shortLabel: "Sol",
    label: "GPT-5.6 Sol",
    engine: "runner",
    model: "gpt-5.6-sol",
  },
  {
    agentId: "luna",
    shortLabel: "Luna",
    label: "GPT-5.6 Luna",
    engine: "runner",
    model: "gpt-5.6-luna",
  },
  {
    agentId: "terra",
    shortLabel: "Terra",
    label: "GPT-5.6 Terra",
    engine: "runner",
    model: "gpt-5.6-terra",
  },
  {
    agentId: "fable",
    shortLabel: "Fable",
    label: "Claude Fable 5",
    engine: "reflex",
    model: "claude-fable-5",
  },
  {
    agentId: "opus",
    shortLabel: "Opus",
    label: "Claude Opus 5",
    engine: "reflex",
    model: "claude-opus-5",
  },
  {
    agentId: "sonnet",
    shortLabel: "Sonnet",
    label: "Claude Sonnet 5",
    engine: "reflex",
    model: "claude-sonnet-5",
  },
];

const ROOM_DATE_FORMAT = new Intl.DateTimeFormat([], {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function explicitAvailability(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "enabled", "available"].includes(normalized)) return true;
    if (["false", "no", "disabled", "unavailable"].includes(normalized)) return false;
  }

  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["available", "enabled", "supported"]) {
    if (key in record) return explicitAvailability(record[key]);
  }
  return null;
}

function availableAgentIsClaude(value: unknown) {
  if (typeof value === "string") {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return normalized === "claude" || normalized === "claudecode";
  }

  const record = asRecord(value);
  if (!record) return false;
  const availability = explicitAvailability(record);
  if (availability === false) return false;
  return [record.agentId, record.id, record.name, record.label].some(availableAgentIsClaude);
}

function availableAgentsIncludeClaude(value: unknown) {
  if (Array.isArray(value)) return value.some(availableAgentIsClaude);
  if (typeof value === "string") {
    return value.split(/[,\s]+/).some(availableAgentIsClaude);
  }

  const record = asRecord(value);
  if (!record) return false;
  for (const key of ["claude", "claudeCode", "claude-code"]) {
    if (key in record) return explicitAvailability(record[key]) === true;
  }
  return Object.entries(record).some(([key, entry]) =>
    availableAgentIsClaude(key) && explicitAvailability(entry) !== false,
  );
}

function claudeIsAvailable(payload: unknown) {
  const root = asRecord(payload);
  if (!root) return false;
  const capabilities = asRecord(root.capabilities);

  for (const candidate of [capabilities?.claude, capabilities?.claudeCode, root.claudeAvailable]) {
    const availability = explicitAvailability(candidate);
    if (availability !== null) return availability;
  }

  return availableAgentsIncludeClaude(root.availableAgents)
    || availableAgentsIncludeClaude(capabilities?.availableAgents);
}

function normalizeStatus(value: unknown) {
  const status = nonEmptyString(value)?.toLowerCase();
  if (!status) return "provisioning";
  return status;
}

function normalizeRooms(payload: unknown): HomeRoom[] {
  const envelope = asRecord(payload);
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(envelope?.rooms)
      ? envelope.rooms
      : [];

  return source.flatMap((value) => {
    const room = asRecord(value);
    if (!room) return [];
    const roomId = nonEmptyString(room.roomId) ?? nonEmptyString(room.id);
    if (!roomId) return [];
    const workspace = asRecord(room.workspace);
    return [{
      roomId,
      name: nonEmptyString(room.name) ?? "Untitled task",
      status: normalizeStatus(room.status ?? workspace?.status),
      createdAt: typeof room.createdAt === "number" || typeof room.createdAt === "string"
        ? room.createdAt
        : null,
    }];
  });
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseError(payload: unknown, fallback: string) {
  if (typeof payload === "string" && payload.trim()) return payload.trim().slice(0, 280);
  const record = asRecord(payload);
  if (!record) return fallback;
  for (const key of ["message", "error", "detail"]) {
    const message = nonEmptyString(record[key]);
    if (message) return message.slice(0, 280);
  }
  return fallback;
}

function repositoryUrlIsValid(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return (
    <p
      className="home-field-error-slot"
      id={id}
      role="alert"
      aria-atomic="true"
      data-visible={message ? "true" : "false"}
    >
      {message ?? ""}
    </p>
  );
}

function roomSourceCandidates(payload: unknown) {
  const root = asRecord(payload);
  if (!root) return [];
  const nestedRoom = asRecord(root.room);
  return nestedRoom ? [root, nestedRoom] : [root];
}

function steerLinkFromResponse(payload: unknown) {
  const sources = roomSourceCandidates(payload);

  for (const source of sources) {
    const links = asRecord(source.links);
    const direct = nonEmptyString(links?.steer) ?? nonEmptyString(source.steerLink);
    if (direct) return direct;
  }

  let roomId: string | null = null;
  let steerToken: string | null = null;
  for (const source of sources) {
    roomId ??= nonEmptyString(source.roomId) ?? nonEmptyString(source.id);
    steerToken ??= nonEmptyString(asRecord(source.invites)?.steer);
  }

  if (!roomId || !steerToken) return null;
  return `/s/${encodeURIComponent(roomId)}?k=${encodeURIComponent(steerToken)}`;
}

function statusLabel(status: string) {
  if (status === "ready") return "Ready";
  if (status === "error") return "Needs attention";
  if (status === "provisioning") return "Provisioning";
  return status.replace(/[_-]+/g, " ").replace(/^./, (character) => character.toUpperCase());
}

function statusTone(status: string) {
  if (status === "ready") return "ready";
  if (status === "error") return "error";
  return "provisioning";
}

function roomDate(value: HomeRoom["createdAt"]) {
  if (value === null) return { label: "Recently created", iso: undefined };
  const numeric = typeof value === "number" && value > 0 && value < 10_000_000_000
    ? value * 1_000
    : value;
  const date = new Date(numeric);
  if (!Number.isFinite(date.getTime())) return { label: "Recently created", iso: undefined };
  return { label: ROOM_DATE_FORMAT.format(date), iso: date.toISOString() };
}

function storedSteerKey(roomId: string) {
  if (typeof window === "undefined") return null;
  try {
    return nonEmptyString(window.localStorage.getItem(`ensemble:steer-key:${roomId}`));
  } catch {
    return null;
  }
}

function useHomeFloatingScrollbar(
  scrollContainerRef: { current: HTMLElement | null },
  trackRef: { current: HTMLDivElement | null },
  thumbRef: { current: HTMLDivElement | null },
) {
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!scrollContainer || !track || !thumb) return;

    let frame = 0;
    let settleTimer = 0;

    const sync = () => {
      frame = 0;
      const scrollRange = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const hasOverflow = scrollRange > 1;
      track.hidden = !hasOverflow;

      if (!hasOverflow) {
        thumb.style.setProperty("--home-scroll-progress", "0");
        track.removeAttribute("data-scrolling");
        return;
      }

      const progress = Math.min(1, Math.max(0, scrollContainer.scrollTop / scrollRange));
      thumb.style.setProperty("--home-scroll-progress", String(progress));
    };

    const scheduleSync = () => {
      if (!frame) frame = window.requestAnimationFrame(sync);
    };

    const onScroll = () => {
      scheduleSync();
      track.dataset.scrolling = "true";
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        track.removeAttribute("data-scrolling");
      }, 140);
    };

    scrollContainer.addEventListener("scroll", onScroll, { passive: true });

    const content = scrollContainer.querySelector<HTMLElement>(".home-layout");
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleSync);
    resizeObserver?.observe(scrollContainer);
    if (content) resizeObserver?.observe(content);
    window.addEventListener("resize", scheduleSync, { passive: true });
    sync();

    return () => {
      scrollContainer.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", scheduleSync);
      resizeObserver?.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, [scrollContainerRef, thumbRef, trackRef]);
}

function HomeFloatingScrollbar({
  scrollContainerRef,
}: {
  scrollContainerRef: { current: HTMLElement | null };
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  useHomeFloatingScrollbar(scrollContainerRef, trackRef, thumbRef);

  return (
    <div className="home-floating-scrollbar" ref={trackRef} hidden aria-hidden="true">
      <div className="home-floating-scrollbar__thumb" ref={thumbRef} />
    </div>
  );
}

export function HomePage({ onNavigate }: { onNavigate: (href: string) => void }) {
  const pageRef = useRef<HTMLElement>(null);
  const [rooms, setRooms] = useState<HomeRoom[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [claudeAvailable, setClaudeAvailable] = useState(false);

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [importThreadId, setImportThreadId] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>(["turbo"]);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingRooms, setDeletingRooms] = useState<Record<string, boolean>>({});
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    document.title = "Ensemble | Multiplayer AI";
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");
    setLoadError("");

    void (async () => {
      try {
        const response = await fetch("/rooms", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await readResponse(response);
        if (!response.ok) {
          throw new Error(responseError(payload, `Rooms could not be loaded (${response.status}).`));
        }
        setRooms(normalizeRooms(payload));
        setClaudeAvailable(claudeIsAvailable(payload));
        setLoadState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setRooms([]);
        setClaudeAvailable(false);
        setLoadError(error instanceof Error ? error.message : "Rooms could not be loaded.");
        setLoadState("error");
      }
    })();

    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    if (claudeAvailable) return;
    const reflexIds = new Set(
      AGENT_CHOICES.filter((agent) => agent.engine === "reflex").map((agent) => agent.agentId),
    );
    setSelectedAgents((current) => current.filter((agentId) => !reflexIds.has(agentId)));
  }, [claudeAvailable]);

  const offeredAgents = useMemo(
    () => AGENT_CHOICES.filter((agent) => agent.engine !== "reflex" || claudeAvailable),
    [claudeAvailable],
  );

  if (loadState === "loading" || creating) {
    return (
      <GracefulState
        kind="loading"
        message={creating ? "creating a runloop workspace" : "loading tasks"}
        fullScreen
      />
    );
  }

  const toggleAgent = (agentId: AgentId) => {
    setSelectedAgents((current) => current.includes(agentId)
      ? current.filter((candidate) => candidate !== agentId)
      : [...current, agentId]);
    setFormErrors((current) => ({ ...current, agents: undefined }));
    setCreateError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating) return;

    const cleanName = name.trim().replace(/\s+/g, " ");
    const cleanGoal = goal.trim();
    const cleanRepoUrl = repoUrl.trim();
    const cleanImportThreadId = importThreadId.trim();
    const nextErrors: FormErrors = {};
    if (!cleanName) nextErrors.name = "Name this task so the room can identify it.";
    if (!cleanGoal) nextErrors.goal = "Describe what the agents should accomplish.";
    if (!selectedAgents.length) nextErrors.agents = "Select at least one agent.";
    if (cleanName.length > 120) nextErrors.name = "Keep the task name under 120 characters.";
    if (cleanGoal.length > 10_000) nextErrors.goal = "Keep the goal under 10,000 characters.";
    if (cleanRepoUrl && !repositoryUrlIsValid(cleanRepoUrl)) {
      nextErrors.repoUrl = "Enter a valid http or https repository URL.";
    } else if (cleanRepoUrl.length > 2_000) {
      nextErrors.repoUrl = "Keep the repository URL under 2,000 characters.";
    }
    if (cleanImportThreadId.length > 500) {
      nextErrors.importThreadId = "Keep the Codex session ID under 500 characters.";
    }

    if (Object.keys(nextErrors).length) {
      setFormErrors(nextErrors);
      setCreateError("");
      return;
    }

    const agents = AGENT_CHOICES
      .filter((agent) => selectedAgents.includes(agent.agentId))
      .map((agent) => agent.agentId);
    const body: Record<string, unknown> = { name: cleanName, goal: cleanGoal, agents };
    if (cleanRepoUrl) body.repoUrl = cleanRepoUrl;
    if (cleanImportThreadId) body.importThreadId = cleanImportThreadId;

    setCreating(true);
    setCreateError("");
    setFormErrors({});

    try {
      const response = await fetch("/rooms", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = await readResponse(response);
      if (!response.ok) {
        throw new Error(responseError(payload, `The task could not be created (${response.status}).`));
      }
      const steerLink = steerLinkFromResponse(payload);
      if (!steerLink) {
        throw new Error("The room was created, but its steer link was missing from the response.");
      }
      onNavigate(steerLink);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "The task could not be created.");
      setCreating(false);
    }
  };

  const deleteRoom = async (roomId: string) => {
    if (roomId === "demo" || deletingRooms[roomId]) return;

    const steerKey = storedSteerKey(roomId);
    if (!steerKey) return;

    setDeletingRooms((current) => ({ ...current, [roomId]: true }));
    setDeleteErrors((current) => {
      const next = { ...current };
      delete next[roomId];
      return next;
    });

    try {
      const response = await fetch(`/rooms/${encodeURIComponent(roomId)}`, {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          "x-ensemble-invite": steerKey,
        },
      });
      const payload = await readResponse(response);
      if (!response.ok) {
        throw new Error(responseError(payload, `The task could not be deleted (${response.status}).`));
      }

      setRooms((current) => current.filter((room) => room.roomId !== roomId));
      try {
        window.localStorage.removeItem(`ensemble:steer-key:${roomId}`);
      } catch {
        // The room is already gone; storage cleanup is best effort.
      }
    } catch (error) {
      setDeleteErrors((current) => ({
        ...current,
        [roomId]: error instanceof Error ? error.message : "The task could not be deleted.",
      }));
    } finally {
      setDeletingRooms((current) => {
        const next = { ...current };
        delete next[roomId];
        return next;
      });
    }
  };

  return (
    <main className="home-page" ref={pageRef}>
      <HomeFloatingScrollbar scrollContainerRef={pageRef} />
      <div className="home-layout">
        <section className="home-hero" aria-labelledby="home-title">
          <span className="home-hero__orb" aria-hidden="true" />
          <h1 id="home-title">ensemble</h1>
          <p>the multiplayer moment for ai</p>
        </section>

        <div className="home-command-stack">
          <section className="home-panel home-task-panel" data-load-state={loadState} aria-labelledby="room-list-title">
            <h2 className="home-visually-hidden" id="room-list-title">Tasks</h2>

            <div className="home-task-panel__body">
              {loadState === "error" && (
                <div className="home-state home-state--error" role="alert">
                  <strong>Task feed unavailable</strong>
                  <p>{loadError}</p>
                  <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry</button>
                </div>
              )}

              {loadState === "ready" && !rooms.length && (
                <span className="home-visually-hidden" role="status">No tasks yet</span>
              )}

              {loadState === "ready" && !!rooms.length && (
                <ol className="home-task-list">
                  {rooms.map((room, index) => {
                    const created = roomDate(room.createdAt);
                    const steerKey = room.roomId === "demo" ? null : storedSteerKey(room.roomId);
                    const roomHref = `/s/${encodeURIComponent(room.roomId)}${steerKey ? `?k=${encodeURIComponent(steerKey)}` : ""}`;
                    const deleting = !!deletingRooms[room.roomId];
                    const deleteError = deleteErrors[room.roomId];
                    return (
                      <li
                        className="home-task-row"
                        key={room.roomId}
                        aria-busy={deleting || undefined}
                        data-deleting={deleting ? "true" : undefined}
                      >
                        <div
                          className={`home-task-row__identity hint hint--align-start${index === 0 ? " hint--below" : ""}`}
                          data-hint={created.label === "Recently created" ? created.label : `Created ${created.label}`}
                        >
                          <strong>{room.name}</strong>
                          {deleteError && (
                            <p className="home-task-row__delete-error" role="alert">{deleteError}</p>
                          )}
                        </div>
                        <span className={`home-status home-status--${statusTone(room.status)}`}>
                          <i aria-hidden="true" />{statusLabel(room.status)}
                        </span>
                        <div className="home-task-row__actions">
                          <a
                            className="home-task-row__open"
                            href={roomHref}
                            aria-label={`Open ${room.name}`}
                            onClick={(event) => {
                              event.preventDefault();
                              onNavigate(roomHref);
                            }}
                          >
                            open
                          </a>
                          {steerKey && (
                            <button
                              className={`home-task-row__delete hint hint--align-end${index === 0 ? " hint--below" : ""}`}
                              type="button"
                              disabled={deleting}
                              aria-label={deleting ? `Deleting ${room.name}` : `Delete ${room.name}`}
                              data-hint={deleting ? "Deleting task" : "Delete task"}
                              onClick={() => void deleteRoom(room.roomId)}
                            >
                              <span aria-hidden="true">{deleting ? "…" : "×"}</span>
                            </button>
                          )}
                          <span className="home-visually-hidden" role="status" aria-live="polite">
                            {deleting ? `Deleting ${room.name}.` : ""}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </section>

          <section className="home-panel home-create-panel" aria-labelledby="create-task-title">
            <h2 className="home-visually-hidden" id="create-task-title">Create a task</h2>

            <form className="home-create-form" onSubmit={submit} noValidate aria-busy={creating}>
              <div className="home-field">
                <label htmlFor="room-name">Name</label>
                <input
                  id="room-name"
                  value={name}
                  onChange={(changeEvent) => {
                    setName(changeEvent.target.value);
                    setFormErrors((current) => ({ ...current, name: undefined }));
                    setCreateError("");
                  }}
                  placeholder="Launch room"
                  autoComplete="off"
                  aria-invalid={!!formErrors.name}
                  aria-describedby="room-name-error"
                />
                <FieldError id="room-name-error" message={formErrors.name} />
              </div>

              <div
                className="home-field hint hint--below hint--align-start"
                data-hint="Describe the outcome this room should produce. This becomes the shared brief for every selected agent."
              >
                <label htmlFor="room-goal">Goal</label>
                <textarea
                  id="room-goal"
                  rows={4}
                  value={goal}
                  onChange={(changeEvent) => {
                    setGoal(changeEvent.target.value);
                    setFormErrors((current) => ({ ...current, goal: undefined }));
                    setCreateError("");
                  }}
                  aria-invalid={!!formErrors.goal}
                  aria-describedby="room-goal-error"
                />
                <FieldError id="room-goal-error" message={formErrors.goal} />
              </div>

              <fieldset className="home-agent-fieldset" aria-describedby="room-agents-error">
                <legend>Agents</legend>
                <div className="home-agent-grid">
                  {offeredAgents.map((agent) => {
                    const selected = selectedAgents.includes(agent.agentId);
                    return (
                      <label
                        className={`home-agent-choice hint hint--below${selected ? " home-agent-choice--selected" : ""}`}
                        data-hint={`${agent.engine} / ${agent.model}`}
                        data-agent-id={agent.agentId}
                        key={agent.agentId}
                      >
                        <input
                          type="checkbox"
                          value={agent.agentId}
                          checked={selected}
                          onChange={() => toggleAgent(agent.agentId)}
                        />
                        <span
                          className="home-agent-choice__orb"
                          data-agent-id={agent.agentId}
                          aria-hidden="true"
                        />
                        <span className="home-agent-choice__copy">
                          <strong>{agent.shortLabel}</strong>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <FieldError id="room-agents-error" message={formErrors.agents} />
              </fieldset>

              <details className="home-import">
                <summary>Import existing project</summary>
                <div className="home-import__fields">
                  <div className="home-field">
                    <label htmlFor="room-repo-url">Repository URL</label>
                    <input
                      id="room-repo-url"
                      type="url"
                      inputMode="url"
                      value={repoUrl}
                      onChange={(changeEvent) => {
                        setRepoUrl(changeEvent.target.value);
                        setFormErrors((current) => ({ ...current, repoUrl: undefined }));
                        setCreateError("");
                      }}
                      placeholder="https://github.com/team/project"
                      autoComplete="url"
                      aria-invalid={!!formErrors.repoUrl}
                      aria-describedby="room-repo-url-error"
                    />
                    <FieldError id="room-repo-url-error" message={formErrors.repoUrl} />
                  </div>

                  <div className="home-field">
                    <label htmlFor="room-thread-id">Codex session ID</label>
                    <input
                      id="room-thread-id"
                      value={importThreadId}
                      onChange={(changeEvent) => {
                        setImportThreadId(changeEvent.target.value);
                        setFormErrors((current) => ({ ...current, importThreadId: undefined }));
                        setCreateError("");
                      }}
                      placeholder="Optional"
                      autoComplete="off"
                      aria-invalid={!!formErrors.importThreadId}
                      aria-describedby="room-thread-id-error"
                    />
                    <FieldError id="room-thread-id-error" message={formErrors.importThreadId} />
                  </div>
                </div>
              </details>

              <FieldError
                id="room-create-error"
                message={createError
                  ? `Creation failed: ${createError}`
                  : formErrors.repoUrl || formErrors.importThreadId
                    ? "Check the import fields."
                    : undefined}
              />

              <button className="home-create-button btn-jelly" type="submit">
                <JellyButtonContent>Create task</JellyButtonContent>
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

export default HomePage;
