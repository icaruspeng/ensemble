import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./home.css";

type AgentId = "turbo" | "deep" | "sol" | "luna" | "terra" | "claude";
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
    agentId: "claude",
    shortLabel: "Claude",
    label: "Claude Code",
    engine: "reflex",
    model: "claude",
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

export function HomePage({ onNavigate }: { onNavigate: (href: string) => void }) {
  const [rooms, setRooms] = useState<HomeRoom[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [claudeAvailable, setClaudeAvailable] = useState(false);

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>(["turbo"]);
  const [repoUrl, setRepoUrl] = useState("");
  const [importThreadId, setImportThreadId] = useState("");
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [createError, setCreateError] = useState("");
  const [creating, setCreating] = useState(false);

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
    setSelectedAgents((current) => current.filter((agentId) => agentId !== "claude"));
  }, [claudeAvailable]);

  const offeredAgents = useMemo(
    () => AGENT_CHOICES.filter((agent) => agent.agentId !== "claude" || claudeAvailable),
    [claudeAvailable],
  );

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

  return (
    <main className="home-page">
      <header className="home-topbar">
        <a
          className="home-brand"
          href="/"
          aria-label="Ensemble home"
          onClick={(event) => {
            event.preventDefault();
            onNavigate("/");
          }}
        >
          ENSEMBLE
        </a>
        <span className="home-hub-label">MULTI-AGENT TASK HUB</span>
      </header>

      <div className="home-layout">
        <section className="home-hero" aria-labelledby="home-title">
          <span className="home-hero__eyebrow">LIVE COLLABORATIVE AGENTS</span>
          <h1 id="home-title">The multiplayer moment for AI</h1>
          <p>Open a task, choose the agents, and watch every steer and outcome land in one shared room.</p>
          <dl className="home-signal-grid">
            <div>
              <dt>Shared</dt>
              <dd>One living timeline</dd>
            </div>
            <div>
              <dt>Directed</dt>
              <dd>Every outcome attributed</dd>
            </div>
            <div>
              <dt>Live</dt>
              <dd>Preview while agents work</dd>
            </div>
          </dl>
        </section>

        <div className="home-command-stack">
          <section className="home-panel home-task-panel" data-load-state={loadState} aria-labelledby="room-list-title" aria-busy={loadState === "loading"}>
            <header className="home-panel__heading">
              <div>
                <h2 id="room-list-title">Tasks</h2>
                <span>Rooms active in this hub</span>
              </div>
              {loadState === "ready" && <strong>{rooms.length}</strong>}
            </header>

            <div className="home-task-panel__body">
              {loadState === "loading" && (
                <>
                  <span className="home-visually-hidden" role="status">Loading tasks</span>
                  <div className="home-skeleton-list" aria-hidden="true">
                    <span /><span /><span />
                  </div>
                </>
              )}

              {loadState === "error" && (
                <div className="home-state home-state--error" role="alert">
                  <strong>Task feed unavailable</strong>
                  <p>{loadError}</p>
                  <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry</button>
                </div>
              )}

              {loadState === "ready" && !rooms.length && (
                <div className="home-state home-state--empty">
                  <span aria-hidden="true">+</span>
                  <strong>No tasks yet</strong>
                  <p>Create the first room and invite your collaborators.</p>
                </div>
              )}

              {loadState === "ready" && !!rooms.length && (
                <ol className="home-task-list">
                  {rooms.map((room) => {
                    const created = roomDate(room.createdAt);
                    return (
                      <li className="home-task-row" key={room.roomId}>
                        <div className="home-task-row__identity">
                          <strong>{room.name}</strong>
                          <code>{room.roomId}</code>
                        </div>
                        <span className={`home-status home-status--${statusTone(room.status)}`}>
                          <i aria-hidden="true" />{statusLabel(room.status)}
                        </span>
                        <time dateTime={created.iso}>{created.label}</time>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </section>

          <section className="home-panel home-create-panel" aria-labelledby="create-task-title">
            <header className="home-panel__heading">
              <div>
                <h2 id="create-task-title">Create a task</h2>
                <span>Provision a room and invite your team</span>
              </div>
              <span className="home-create-panel__ready">READY</span>
            </header>

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
                  aria-describedby={formErrors.name ? "room-name-error" : undefined}
                />
                {formErrors.name && <p className="home-field-error" id="room-name-error" role="alert">{formErrors.name}</p>}
              </div>

              <div className="home-field">
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
                  placeholder="Describe the outcome this room should produce"
                  aria-invalid={!!formErrors.goal}
                  aria-describedby={formErrors.goal ? "room-goal-error" : "room-goal-help"}
                />
                <span className="home-field-help" id="room-goal-help">This becomes the shared brief for every selected agent.</span>
                {formErrors.goal && <p className="home-field-error" id="room-goal-error" role="alert">{formErrors.goal}</p>}
              </div>

              <fieldset className="home-agent-fieldset" aria-describedby={formErrors.agents ? "room-agents-error" : undefined}>
                <legend>Agents</legend>
                <div className="home-agent-grid">
                  {offeredAgents.map((agent) => {
                    const selected = selectedAgents.includes(agent.agentId);
                    return (
                      <label className={`home-agent-choice${selected ? " home-agent-choice--selected" : ""}`} key={agent.agentId}>
                        <input
                          type="checkbox"
                          value={agent.agentId}
                          checked={selected}
                          onChange={() => toggleAgent(agent.agentId)}
                        />
                        <span className="home-agent-choice__copy">
                          <strong>{agent.shortLabel}</strong>
                          <span>{agent.label}</span>
                          <code>{agent.engine} / {agent.model}</code>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {formErrors.agents && <p className="home-field-error" id="room-agents-error" role="alert">{formErrors.agents}</p>}
              </fieldset>

              <details className="home-import">
                <summary>Import existing project</summary>
                <div className="home-import__fields">
                  <div className="home-field">
                    <label htmlFor="repo-url">Repo URL</label>
                    <input
                      id="repo-url"
                      type="url"
                      inputMode="url"
                      value={repoUrl}
                      onChange={(changeEvent) => {
                        setRepoUrl(changeEvent.target.value);
                        setCreateError("");
                      }}
                      placeholder="https://github.com/team/project"
                      autoComplete="url"
                    />
                  </div>
                  <div className="home-field">
                    <label htmlFor="codex-session-id">Codex session ID (optional)</label>
                    <input
                      id="codex-session-id"
                      value={importThreadId}
                      onChange={(changeEvent) => {
                        setImportThreadId(changeEvent.target.value);
                        setCreateError("");
                      }}
                      placeholder="0191c9d2..."
                      autoComplete="off"
                    />
                  </div>
                </div>
              </details>

              {createError && <div className="home-create-error" role="alert"><strong>Creation failed</strong><span>{createError}</span></div>}

              <button className="home-create-button" type="submit" disabled={creating} data-loading={creating ? "true" : "false"}>
                {creating ? "Creating room..." : "Create task"}
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

export default HomePage;
