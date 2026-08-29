import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";

import { createProvisioner } from "./provision.mjs";
import { createReflexAdapter } from "./reflex-agent.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

const SYSTEM_ACTOR = Object.freeze({
  id: "act_system",
  name: "Ensemble",
  kind: "system",
});

export const BUILTIN_AGENTS = Object.freeze({
  turbo: Object.freeze({
    agentId: "turbo",
    label: "Codex Turbo",
    engine: "runner",
    model: "gpt-5.3-codex-spark",
    color: "#5eead4",
  }),
  deep: Object.freeze({
    agentId: "deep",
    label: "Codex Deep",
    engine: "runner",
    model: "gpt-5.5",
    color: "#a78bfa",
  }),
  sol: Object.freeze({
    agentId: "sol",
    label: "GPT-5.6 Sol",
    engine: "runner",
    model: "gpt-5.6-sol",
    color: "#fbbf24",
  }),
  luna: Object.freeze({
    agentId: "luna",
    label: "GPT-5.6 Luna",
    engine: "runner",
    model: "gpt-5.6-luna",
    color: "#93c5fd",
  }),
  terra: Object.freeze({
    agentId: "terra",
    label: "GPT-5.6 Terra",
    engine: "runner",
    model: "gpt-5.6-terra",
    color: "#86efac",
  }),
  claude: Object.freeze({
    agentId: "claude",
    label: "Claude Code",
    engine: "reflex",
    model: "claude",
    color: "#f59e0b",
  }),
});

const RUNNER_EVENT_TYPES = new Set([
  "agent.turn_started",
  "agent.turn_completed",
  "agent.thought",
  "agent.command",
  "agent.diff",
  "agent.message",
  "crew.actor_post",
  "crew.task_dispatched",
  "crew.task_completed",
  "crew.task_failed",
  "crew.gate_requested",
  "crew.gate_resolved",
  "crew.result_published",
  "preview.updated",
]);

const VIEWER_BLOCKED_MESSAGES = new Set([
  "steer",
  "comment",
  "resolveGate",
  "handoff",
  "interrupt",
]);

function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function newInviteToken() {
  return randomBytes(24).toString("base64url");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonemptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalString(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return asNonemptyString(value) ?? null;
}

function publicActor(actor) {
  return { id: actor.id, name: actor.name, kind: actor.kind };
}

function agentActor(agent) {
  return { id: `act_${agent.agentId}`, name: agent.label, kind: "agent" };
}

function cloneAgent(agent) {
  return {
    agentId: agent.agentId,
    label: agent.label,
    engine: agent.engine,
    model: agent.model,
    ...(agent.reflexAgentId ? { reflexAgentId: agent.reflexAgentId } : {}),
    color: agent.color,
  };
}

function hasExactKeys(payload, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(payload, key)) &&
    Object.keys(payload).every((key) => allowed.has(key))
  );
}

function areStrings(payload, fields) {
  return fields.every((field) => typeof payload[field] === "string");
}

function areNonnegativeNumbers(payload, fields) {
  return fields.every(
    (field) =>
      typeof payload[field] === "number" &&
      Number.isFinite(payload[field]) &&
      payload[field] >= 0,
  );
}

function withDeclaredAgent(payload, normalized) {
  if (!Object.hasOwn(payload, "agentId")) return normalized;
  if (!asNonemptyString(payload.agentId)) return null;
  return { ...normalized, agentId: payload.agentId };
}

function normalizeRunnerPayload(type, payload) {
  const base = { ...payload };
  delete base.agentId;

  switch (type) {
    case "preview.updated":
      if (!hasExactKeys(base, ["url"]) || !areStrings(base, ["url"])) return null;
      return withDeclaredAgent(payload, { url: base.url });
    case "agent.turn_started":
      if (!hasExactKeys(base, ["taskId"]) || !areStrings(base, ["taskId"])) {
        return null;
      }
      return withDeclaredAgent(payload, { taskId: base.taskId });
    case "agent.turn_completed":
      if (
        !hasExactKeys(base, ["taskId", "tokens", "costUsd"]) ||
        !areStrings(base, ["taskId"]) ||
        !areNonnegativeNumbers(base, ["tokens", "costUsd"])
      ) {
        return null;
      }
      return withDeclaredAgent(payload, {
        taskId: base.taskId,
        tokens: base.tokens,
        costUsd: base.costUsd,
      });
    case "agent.thought":
    case "agent.message":
      if (!hasExactKeys(base, ["text"]) || !areStrings(base, ["text"])) {
        return null;
      }
      return withDeclaredAgent(payload, { text: base.text });
    case "agent.command": {
      if (
        !hasExactKeys(base, ["command"], ["exitCode"]) ||
        !areStrings(base, ["command"]) ||
        (Object.hasOwn(base, "exitCode") && !Number.isInteger(base.exitCode))
      ) {
        return null;
      }
      const normalized = { command: base.command };
      if (Object.hasOwn(base, "exitCode")) normalized.exitCode = base.exitCode;
      return withDeclaredAgent(payload, normalized);
    }
    case "agent.diff":
      if (
        !hasExactKeys(base, ["file", "patch"]) ||
        !areStrings(base, ["file", "patch"])
      ) {
        return null;
      }
      return withDeclaredAgent(payload, { file: base.file, patch: base.patch });
    case "crew.actor_post":
      if (!hasExactKeys(base, ["text"]) || !areStrings(base, ["text"])) {
        return null;
      }
      return withDeclaredAgent(payload, { text: base.text });
    case "crew.task_dispatched":
      if (
        !hasExactKeys(base, ["taskId", "text", "byActorId"]) ||
        !areStrings(base, ["taskId", "text", "byActorId"])
      ) {
        return null;
      }
      return withDeclaredAgent(payload, {
        taskId: base.taskId,
        text: base.text,
        byActorId: base.byActorId,
      });
    case "crew.task_completed":
      if (
        !hasExactKeys(base, ["taskId", "tokens", "costUsd"]) ||
        !areStrings(base, ["taskId"]) ||
        !areNonnegativeNumbers(base, ["tokens", "costUsd"])
      ) {
        return null;
      }
      return withDeclaredAgent(payload, {
        taskId: base.taskId,
        tokens: base.tokens,
        costUsd: base.costUsd,
      });
    case "crew.task_failed":
      if (
        !hasExactKeys(base, ["taskId", "reason"]) ||
        !areStrings(base, ["taskId", "reason"])
      ) {
        return null;
      }
      return withDeclaredAgent(payload, { taskId: base.taskId, reason: base.reason });
    case "crew.gate_requested":
      if (
        !hasExactKeys(base, ["gateId", "question", "taskId"]) ||
        !areStrings(base, ["gateId", "question", "taskId"])
      ) {
        return null;
      }
      return withDeclaredAgent(payload, {
        gateId: base.gateId,
        question: base.question,
        taskId: base.taskId,
      });
    case "crew.gate_resolved":
      if (
        !hasExactKeys(base, ["gateId", "approved", "byActorId"]) ||
        !areStrings(base, ["gateId", "byActorId"]) ||
        typeof base.approved !== "boolean"
      ) {
        return null;
      }
      return withDeclaredAgent(payload, {
        gateId: base.gateId,
        approved: base.approved,
        byActorId: base.byActorId,
      });
    case "crew.result_published":
      if (
        !hasExactKeys(base, ["taskId", "summary", "diffStat"]) ||
        !areStrings(base, ["taskId", "summary", "diffStat"])
      ) {
        return null;
      }
      return withDeclaredAgent(payload, {
        taskId: base.taskId,
        summary: base.summary,
        diffStat: base.diffStat,
      });
    default:
      return null;
  }
}

function inviteMatches(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function safeDetail(error, secrets = []) {
  let detail = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) detail = detail.replaceAll(secret, "[redacted]");
  }
  return detail.replace(/\s+/g, " ").trim().slice(0, 500) || "Unknown error";
}

function deriveRunnerUrl(previewUrl) {
  try {
    const url = new URL(previewUrl);
    url.hostname = url.hostname.replace(/^5173-/, "8091-");
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isApiPath(pathname) {
  return (
    pathname === "/healthz" ||
    pathname === "/bundle" ||
    pathname === "/ws" ||
    pathname === "/rooms" ||
    pathname.startsWith("/rooms/") ||
    pathname === "/runner" ||
    pathname.startsWith("/runner/")
  );
}

function envFlagEnabled(value, fallback = true) {
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(String(value).toLowerCase());
}

export async function buildServer(options = {}) {
  const ensembleKey = options.ensembleKey ?? process.env.ENSEMBLE_KEY;
  if (!ensembleKey) throw new Error("ENSEMBLE_KEY is required");

  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const webDist = resolve(options.webDist ?? resolve(SERVER_DIR, "../web/dist"));
  const bundlePath = options.bundlePath ?? process.env.BUNDLE_PATH;
  const publicUrl = asNonemptyString(options.publicUrl ?? process.env.PUBLIC_URL)?.replace(
    /\/+$/,
    "",
  );
  const reflexApiKey = options.reflexApiKey ?? process.env.REFLEX_API_KEY;
  const reflexFeatureEnabled = envFlagEnabled(
    options.claudeEnabled ?? process.env.REFLEX_CLAUDE_ENABLED,
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
  });

  const state = { rooms: new Map(), clients: new Set(), background: new Set() };
  let closing = false;

  const provisioner =
    options.provisioner ??
    createProvisioner({
      env:
        options.provisionerEnv ??
        { ...process.env, DEMO_ROOM: "0", DEMO_WORKSPACE_JSON: "" },
      apiKey: options.runloopApiKey ?? process.env.RUNLOOP_API_KEY,
      codexAuthJsonBase64:
        options.codexAuthJsonBase64 ??
        options.codexAuthBase64 ??
        process.env.CODEX_AUTH_JSON,
      fetchImpl,
      logger: app.log,
      maxLive: options.maxLiveWorkspaces ?? 2,
    });
  const reflexAdapter =
    options.reflexAdapter ??
    createReflexAdapter({
      apiKey: reflexApiKey,
      organizationId: options.reflexOrg ?? process.env.REFLEX_ORG,
      fetchImpl,
      webSocketFactory: options.webSocketFactory,
      logger: app.log,
    });
  const reflexEnabled =
    (options.reflexEnabled ?? reflexFeatureEnabled) && reflexAdapter.configured === true;

  app.decorate("ensembleState", state);
  app.decorate("ensembleProvisioner", provisioner);
  app.decorate("ensembleReflex", reflexAdapter);

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 2 * 1024 * 1024 },
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header(
      "access-control-allow-headers",
      "content-type,x-ensemble-key,x-ensemble-invite,authorization",
    );
    return payload;
  });

  app.options("/*", async (_request, reply) => reply.code(204).send());
  app.options("/", async (_request, reply) => reply.code(204).send());

  function requestOrigin(request) {
    if (publicUrl) return publicUrl;
    const forwardedHost = request.headers["x-forwarded-host"];
    const host =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(",")[0] ??
      request.headers.host;
    const forwardedProto = request.headers["x-forwarded-proto"];
    const protocol =
      (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(",")[0] ??
      request.protocol ??
      "http";
    return host ? `${protocol}://${host}` : "http://127.0.0.1";
  }

  function roomRecord(room, { includeSecrets = false, origin = publicUrl } = {}) {
    const record = {
      roomId: room.roomId,
      name: room.name,
      goal: room.goal,
      createdAt: room.createdAt,
      ...(room.repoUrl ? { repoUrl: room.repoUrl } : {}),
      ...(room.importThreadId ? { importThreadId: room.importThreadId } : {}),
      agents: room.agents.map(cloneAgent),
      workspace: { ...room.workspace },
    };

    if (includeSecrets) {
      record.invites = { ...room.invites };
      if (origin) {
        const base = origin.replace(/\/+$/, "");
        record.links = {
          steer: `${base}/s/${encodeURIComponent(room.roomId)}?k=${encodeURIComponent(room.invites.steer)}`,
          view: `${base}/s/${encodeURIComponent(room.roomId)}?k=${encodeURIComponent(room.invites.view)}`,
        };
      }
    }
    return record;
  }

  function createRoomState({
    roomId = newId("room"),
    name,
    goal,
    agents,
    repoUrl,
    importThreadId,
    invites,
    workspace,
    pinned = false,
  }) {
    return {
      roomId,
      name,
      goal,
      createdAt: Date.now(),
      ...(repoUrl ? { repoUrl } : {}),
      ...(importThreadId ? { importThreadId } : {}),
      agents: agents.map(cloneAgent),
      invites: invites ?? { steer: newInviteToken(), view: newInviteToken() },
      workspace: workspace ?? { status: "provisioning" },
      pinned,
      runnerUrl: null,
      seq: 0,
      events: [],
      clients: new Set(),
      actors: new Map(),
      driverActorId: null,
      taskQueue: [],
      currentTask: null,
      tasks: new Map(),
      gates: new Map(),
      comments: new Map(),
      ledger: new Map(),
      agentRegistrations: new Map(),
      reflexDispatchChains: new Map(),
    };
  }

  function sendJson(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  function sendProtocolError(client, message) {
    sendJson(client.socket, { type: "error", message });
  }

  function broadcast(room, event, exceptClient = null) {
    const message = JSON.stringify({ type: "event", event });
    for (const client of room.clients) {
      if (client === exceptClient || !client.actor || client.socket.readyState !== 1) {
        continue;
      }
      client.socket.send(message);
    }
  }

  function emit(room, type, actor, payload, exceptClient = null) {
    const event = {
      id: newId("evt"),
      ts: Date.now(),
      seq: ++room.seq,
      type,
      actor: publicActor(actor),
      payload,
    };
    room.events.push(event);
    broadcast(room, event, exceptClient);
    return event;
  }

  function ledgerRows(room) {
    return [...room.ledger.values()].map((row) => ({
      actorId: row.actorId,
      name: row.name,
      steers: row.steers,
      tokens: row.tokens,
      costUsd: row.costUsd,
      outcomes: [...row.outcomes],
    }));
  }

  function ensureLedgerRow(room, actor) {
    let row = room.ledger.get(actor.id);
    if (!row) {
      row = {
        actorId: actor.id,
        name: actor.name,
        steers: 0,
        tokens: 0,
        costUsd: 0,
        outcomes: [],
      };
      room.ledger.set(actor.id, row);
    }
    return row;
  }

  function emitLedger(room, exceptClient = null) {
    return emit(
      room,
      "ledger.updated",
      SYSTEM_ACTOR,
      { rows: ledgerRows(room) },
      exceptClient,
    );
  }

  function emitWorkspaceStatus(room, status, detail) {
    room.workspace.status = status;
    const payload = { status };
    if (detail) payload.detail = detail;
    return emit(room, "workspace.status", SYSTEM_ACTOR, payload);
  }

  function registerVisibleAgent(room, agent) {
    emit(room, "agent.registered", SYSTEM_ACTOR, {
      agentId: agent.agentId,
      label: agent.label,
      model: agent.model,
    });
  }

  function initialRoomEvents(room) {
    emit(room, "room.created", SYSTEM_ACTOR, { name: room.name, goal: room.goal });
    for (const agent of room.agents.filter(({ engine }) => engine === "runner")) {
      registerVisibleAgent(room, agent);
    }
    emitWorkspaceStatus(room, room.workspace.status);
  }

  function trackBackground(promise, label) {
    const tracked = Promise.resolve(promise)
      .catch((error) => {
        app.log.error({ err: error, label }, "background task failed");
      })
      .finally(() => state.background.delete(tracked));
    state.background.add(tracked);
    return tracked;
  }

  function roomForId(rawRoomId) {
    const roomId = asNonemptyString(rawRoomId);
    return roomId ? state.rooms.get(roomId) ?? null : null;
  }

  function findAgent(room, agentId) {
    return room.agents.find((agent) => agent.agentId === agentId) ?? null;
  }

  function processAgentSideEffects(room, event) {
    const taskId = event.payload.taskId;
    const task = typeof taskId === "string" ? room.tasks.get(taskId) : null;

    if (event.type === "crew.gate_requested") {
      room.gates.set(event.payload.gateId, {
        gateId: event.payload.gateId,
        task: null,
        relatedTaskId: event.payload.taskId,
        status: "pending",
        dispatchOnApprove: false,
      });
    }
    if (event.type === "crew.gate_resolved") {
      const gate = room.gates.get(event.payload.gateId);
      if (gate?.status === "pending") {
        gate.status = event.payload.approved ? "approved" : "dismissed";
      }
    }
    if (event.type === "agent.turn_completed" && task) {
      const row = ensureLedgerRow(room, task.author);
      row.tokens += event.payload.tokens;
      row.costUsd += event.payload.costUsd;
      if (findAgent(room, task.agentId)?.engine === "reflex") task.status = "completed";
      emitLedger(room);
    }
    if (event.type === "crew.result_published" && task) {
      ensureLedgerRow(room, task.author).outcomes.push(event.payload.summary);
      emitLedger(room);
    }
    if (
      (event.type === "crew.task_completed" || event.type === "crew.task_failed") &&
      task
    ) {
      task.status = event.type === "crew.task_completed" ? "completed" : "failed";
      if (room.currentTask?.taskId === task.taskId) room.currentTask = null;
    }
  }

  function ingestMappedAgentEvent(room, agentId, type, rawPayload) {
    if (!RUNNER_EVENT_TYPES.has(type) || !isObject(rawPayload)) return null;
    const agent = findAgent(room, agentId);
    if (!agent) return null;
    const normalized = normalizeRunnerPayload(type, { ...rawPayload, agentId });
    if (!normalized) return null;
    if (type.startsWith("agent.")) normalized.agentId = agentId;
    const event = emit(room, type, agentActor(agent), normalized);
    processAgentSideEffects(room, event);
    return event;
  }

  async function registerReflexAgent(room, agentId) {
    const agent = findAgent(room, agentId);
    if (!agent || agent.engine !== "reflex") return;
    let unavailableDetail = null;
    try {
      const created = await reflexAdapter.createAgent(roomRecord(room), cloneAgent(agent), {
        emit(type, payload) {
          if (type === "workspace.status" && isObject(payload)) {
            unavailableDetail = asNonemptyString(payload.detail);
            return;
          }
          if (closing) return;
          ingestMappedAgentEvent(room, agentId, type, payload);
        },
      });
      if (closing) return;
      const reflexAgentId =
        asNonemptyString(created?.reflexAgentId) ?? asNonemptyString(created?.id);
      if (!reflexAgentId) {
        throw new Error(unavailableDetail ?? "Reflex did not return an agent id");
      }
      const current = findAgent(room, agentId);
      if (!current) return;
      current.reflexAgentId = reflexAgentId;
      registerVisibleAgent(room, current);
    } catch (error) {
      if (closing) return;
      room.agents = room.agents.filter((candidate) => candidate.agentId !== agentId);
      const reason = unavailableDetail ?? safeDetail(error, [reflexApiKey]);
      const detail = reason.startsWith("Claude Code unavailable:")
        ? reason
        : `Claude Code unavailable: ${reason}`;
      if (room.agents.length === 0) room.workspace.status = "error";
      emit(room, "workspace.status", SYSTEM_ACTOR, {
        status: room.workspace.status,
        detail,
      });
    }
  }

  async function provisionWorkspace(room, origin) {
    const runnerAgents = room.agents.filter(({ engine }) => engine === "runner");
    if (runnerAgents.length === 0) {
      emitWorkspaceStatus(room, "ready", "No runner workspace required");
      return;
    }
    let provisioningFailureReported = false;
    let previewEmittedUrl = null;
    try {
      if (!origin) {
        throw new Error("PUBLIC_URL is required for workspace provisioning");
      }
      const result = await provisioner.provision(roomRecord(room), {
        hubUrl: origin,
        ensembleKey,
        onProgress(event) {
          if (!isObject(event)) return;
          if (event.type === "preview.updated") {
            const url = asNonemptyString(event.url);
            if (!url || url === previewEmittedUrl) return;
            previewEmittedUrl = url;
            room.workspace.previewUrl = url;
            emit(room, "preview.updated", SYSTEM_ACTOR, {
              url,
              agentId: runnerAgents[0].agentId,
            });
            return;
          }
          if (event.type !== "workspace.status") return;
          const status = ["provisioning", "ready", "error"].includes(event.status)
            ? event.status
            : "provisioning";
          if (status === "ready") return;
          if (status === "error") provisioningFailureReported = true;
          if (status === "error" && /suspend/i.test(String(event.detail ?? ""))) {
            room.runnerUrl = null;
          }
          emitWorkspaceStatus(
            room,
            status,
            asNonemptyString(event.detail) ?? undefined,
          );
        },
        onSuspend(event) {
          room.runnerUrl = null;
          if (room.workspace.status === "error") return;
          const reason = isObject(event) ? event.reason : null;
          emitWorkspaceStatus(
            room,
            "error",
            reason === "lru"
              ? "Workspace suspended to stay within the live workspace cap"
              : "Workspace suspended",
          );
        },
      });
      if (closing) return;
      const devboxId = asNonemptyString(result?.devboxId);
      const previewUrl = asNonemptyString(result?.previewUrl);
      if (!devboxId || !previewUrl) {
        throw new Error("Provisioner did not return devboxId and previewUrl");
      }
      room.workspace.devboxId = devboxId;
      room.workspace.previewUrl = previewUrl;
      room.runnerUrl =
        asNonemptyString(result.runnerUrl) ?? deriveRunnerUrl(room.workspace.previewUrl);
      if (previewUrl !== previewEmittedUrl) {
        emit(room, "preview.updated", SYSTEM_ACTOR, {
          url: previewUrl,
          agentId: runnerAgents[0].agentId,
        });
      }
      emitWorkspaceStatus(room, "ready");
    } catch (error) {
      if (closing) return;
      if (!provisioningFailureReported) {
        emitWorkspaceStatus(
          room,
          "error",
          safeDetail(error, [
            ensembleKey,
            options.runloopApiKey,
            process.env.RUNLOOP_API_KEY,
          ]),
        );
      }
    }
  }

  function initializeRoom(room, origin) {
    for (const agent of [...room.agents]) {
      if (agent.engine === "reflex") {
        const registration = registerReflexAgent(room, agent.agentId);
        room.agentRegistrations.set(agent.agentId, registration);
        trackBackground(
          registration.finally(() => {
            if (room.agentRegistrations.get(agent.agentId) === registration) {
              room.agentRegistrations.delete(agent.agentId);
            }
          }),
          `reflex register ${room.roomId}/${agent.agentId}`,
        );
      }
    }
    trackBackground(provisionWorkspace(room, origin), `provision ${room.roomId}`);
  }

  async function dispatchReflexTask(room, task, agentId) {
    const displayAgent = findAgent(room, agentId) ?? BUILTIN_AGENTS[agentId];
    try {
      const registration = room.agentRegistrations.get(agentId);
      if (registration) await registration;
      const agent = findAgent(room, agentId);
      if (!agent) throw new Error("agent is unavailable");
      if (!agent.reflexAgentId) throw new Error("agent is still starting");
      task.status = "started";
      const result = await reflexAdapter.steer(agent.reflexAgentId, task.text, {
        roomId: room.roomId,
        agentId: agent.agentId,
        taskId: task.taskId,
      });
      if (result?.ok === false) throw new Error(result.error ?? "Reflex rejected the steer");
    } catch (error) {
      task.status = "failed";
      emit(room, "crew.task_failed", agentActor(displayAgent), {
        taskId: task.taskId,
        reason: safeDetail(error, [reflexApiKey]),
      });
    }
  }

  function dispatchTask(room, task) {
    const agent = findAgent(room, task.agentId);
    if (!agent) {
      task.status = "failed";
      emit(room, "crew.task_failed", SYSTEM_ACTOR, {
        taskId: task.taskId,
        reason: "The selected agent is unavailable",
      });
      return;
    }
    task.status = "queued";
    emit(room, "crew.task_dispatched", task.author, {
      taskId: task.taskId,
      text: task.text,
      byActorId: task.author.id,
      agentId: task.agentId,
    });
    if (agent.engine === "runner") room.taskQueue.push(task);
    else {
      const previous = room.reflexDispatchChains.get(agent.agentId) ?? Promise.resolve();
      const dispatch = previous.then(() =>
        dispatchReflexTask(room, task, agent.agentId),
      );
      room.reflexDispatchChains.set(agent.agentId, dispatch);
      trackBackground(
        dispatch.finally(() => {
          if (room.reflexDispatchChains.get(agent.agentId) === dispatch) {
            room.reflexDispatchChains.delete(agent.agentId);
          }
        }),
        `reflex steer ${room.roomId}/${task.taskId}`,
      );
    }
  }

  function handleSteer(client, rawText, rawAgentId) {
    const { room } = client;
    const text = asNonemptyString(rawText);
    if (!text) {
      sendProtocolError(client, "A steer needs text");
      return;
    }
    const requestedAgentId =
      rawAgentId === undefined ? room.agents[0]?.agentId : asNonemptyString(rawAgentId);
    const selectedAgent = requestedAgentId ? findAgent(room, requestedAgentId) : null;
    if (!selectedAgent) {
      sendProtocolError(client, "The selected agent is not available in this room");
      return;
    }

    const author = client.actor;
    emit(room, "crew.actor_post", author, { text });
    const task = {
      taskId: newId("task"),
      text,
      author,
      authorName: author.name,
      agentId: selectedAgent.agentId,
      model: selectedAgent.model,
      status: "proposed",
    };
    room.tasks.set(task.taskId, task);
    if (author.id === room.driverActorId) dispatchTask(room, task);
    else {
      const gateId = newId("gate");
      task.gateId = gateId;
      room.gates.set(gateId, {
        gateId,
        task,
        status: "pending",
        dispatchOnApprove: true,
      });
      emit(room, "crew.gate_requested", author, {
        gateId,
        question: `${author.name} wants: ${text}…dispatch?`,
        taskId: task.taskId,
      });
    }
    ensureLedgerRow(room, author).steers += 1;
    emitLedger(room);
  }

  function handleComment(client, rawAnchor, rawText) {
    const text = asNonemptyString(rawText);
    if (!text || !isObject(rawAnchor)) {
      sendProtocolError(client, "A comment needs an anchor and text");
      return;
    }
    const anchor = {};
    if (asNonemptyString(rawAnchor.file)) anchor.file = rawAnchor.file;
    if (asNonemptyString(rawAnchor.eventId)) anchor.eventId = rawAnchor.eventId;
    if (!anchor.file && !anchor.eventId) {
      sendProtocolError(client, "A comment anchor needs file or eventId");
      return;
    }
    const commentId = newId("comment");
    client.room.comments.set(commentId, {
      commentId,
      anchor,
      text,
      author: client.actor,
      resolved: false,
    });
    emit(client.room, "comment.created", client.actor, { commentId, anchor, text });
  }

  function handleGateResolution(client, gateId, approved) {
    const { room } = client;
    if (client.actor.id !== room.driverActorId) {
      sendProtocolError(client, "Only the driver can resolve a gate");
      return;
    }
    if (typeof gateId !== "string" || typeof approved !== "boolean") {
      sendProtocolError(client, "A gate resolution needs gateId and approved");
      return;
    }
    const gate = room.gates.get(gateId);
    if (!gate || gate.status !== "pending") {
      sendProtocolError(client, "That gate is not pending");
      return;
    }
    gate.status = approved ? "approved" : "dismissed";
    if (gate.task) gate.task.status = approved ? "approved" : "dismissed";
    emit(room, "crew.gate_resolved", client.actor, {
      gateId,
      approved,
      byActorId: client.actor.id,
    });
    if (approved && gate.dispatchOnApprove && gate.task) dispatchTask(room, gate.task);
  }

  function handleHandoff(client, toActorId) {
    const { room } = client;
    if (client.actor.id !== room.driverActorId) {
      sendProtocolError(client, "Only the driver can hand off");
      return;
    }
    const target = typeof toActorId === "string" ? room.actors.get(toActorId) : null;
    if (!target || target.role !== "steerer") {
      sendProtocolError(client, "The handoff target must be a present steerer");
      return;
    }
    room.driverActorId = toActorId;
    emit(room, "driver.changed", client.actor, { toActorId });
  }

  async function handleInterrupt(client) {
    const { room } = client;
    if (client.actor.id !== room.driverActorId) {
      sendProtocolError(client, "Only the driver can interrupt");
      return;
    }
    const targetRunnerUrl = room.runnerUrl;
    if (!targetRunnerUrl) {
      sendProtocolError(client, "Runner workspace is not available for this room");
      return;
    }
    try {
      const response = await fetchImpl(new URL("/runner/interrupt", targetRunnerUrl), {
        method: "POST",
        headers: { "x-ensemble-key": ensembleKey },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        app.log.warn(
          { roomId: room.roomId, statusCode: response.status },
          "runner rejected interrupt",
        );
      }
    } catch (error) {
      app.log.warn(
        { err: error, roomId: room.roomId },
        "could not reach runner interrupt endpoint",
      );
    }
  }

  function nextDriver(room) {
    for (const client of room.actors.values()) {
      if (client.role === "steerer") return client.actor.id;
    }
    return null;
  }

  function removeClient(client) {
    if (client.removed) return;
    client.removed = true;
    state.clients.delete(client);
    if (!client.actor || !client.room) return;
    const { room } = client;
    const departed = client.actor;
    room.clients.delete(client);
    room.actors.delete(departed.id);
    emit(room, "actor.left", departed, {});
    if (room.driverActorId === departed.id) {
      room.driverActorId = nextDriver(room);
      emit(room, "driver.changed", SYSTEM_ACTOR, { toActorId: room.driverActorId });
    }
  }

  function joinClient(client, message) {
    if (client.actor) {
      sendProtocolError(client, "This connection has already joined");
      return;
    }
    const room = roomForId(message.roomId);
    const name = asNonemptyString(message.name);
    if (!room || !name) {
      sendProtocolError(client, "Join needs a valid roomId and name");
      return;
    }
    let role;
    if (inviteMatches(message.key, room.invites.steer)) role = "steerer";
    else if (inviteMatches(message.key, room.invites.view)) role = "viewer";
    else {
      sendProtocolError(client, "The room invite is invalid");
      return;
    }

    const actor = { id: newId("act"), name, kind: "human" };
    client.actor = actor;
    client.room = room;
    client.role = role;
    room.clients.add(client);
    room.actors.set(actor.id, client);
    ensureLedgerRow(room, actor);
    provisioner.touch?.(room.roomId);

    emit(room, "actor.joined", actor, { name: actor.name, kind: actor.kind }, client);
    if (role === "steerer" && room.driverActorId === null) {
      room.driverActorId = actor.id;
      emit(room, "driver.changed", SYSTEM_ACTOR, { toActorId: actor.id }, client);
    }
    emitLedger(room, client);
    sendJson(client.socket, {
      type: "welcome",
      actorId: actor.id,
      driverActorId: room.driverActorId,
      room: roomRecord(room, {
        includeSecrets: role === "steerer",
        origin: client.origin,
      }),
      role,
      events: room.events,
    });
  }

  app.get("/ws", { websocket: true }, (socket, request) => {
    const client = {
      socket,
      actor: null,
      room: null,
      role: null,
      origin: requestOrigin(request),
      alive: true,
      removed: false,
    };
    state.clients.add(client);

    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("message", (buffer) => {
      let message;
      try {
        message = JSON.parse(buffer.toString());
      } catch {
        sendProtocolError(client, "Message must be valid JSON");
        return;
      }
      if (!isObject(message) || typeof message.type !== "string") {
        sendProtocolError(client, "Message needs a type");
        return;
      }
      if (!client.actor) {
        if (message.type !== "join") {
          sendProtocolError(client, "Join before sending session messages");
          return;
        }
        joinClient(client, message);
        return;
      }
      if (client.role === "viewer" && VIEWER_BLOCKED_MESSAGES.has(message.type)) {
        sendProtocolError(client, `View-only guests cannot send ${message.type}`);
        return;
      }
      if (VIEWER_BLOCKED_MESSAGES.has(message.type)) {
        provisioner.touch?.(client.room.roomId);
      }
      switch (message.type) {
        case "steer":
          handleSteer(client, message.text, message.agentId);
          break;
        case "comment":
          handleComment(client, message.anchor, message.text);
          break;
        case "resolveGate":
          handleGateResolution(client, message.gateId, message.approved);
          break;
        case "handoff":
          handleHandoff(client, message.toActorId);
          break;
        case "interrupt":
          void handleInterrupt(client);
          break;
        default:
          sendProtocolError(client, "Unknown message type");
      }
    });
    socket.on("close", () => removeClient(client));
    socket.on("error", (error) => {
      app.log.debug({ err: error }, "websocket client error");
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of state.clients) {
      if (client.socket.readyState !== 1) continue;
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  async function requireRunnerKey(request, reply) {
    if (request.headers["x-ensemble-key"] !== ensembleKey) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  }

  function runnerRoom(request, reply) {
    if (!asNonemptyString(request.query?.roomId)) {
      reply.code(400).send({ error: "roomId query parameter is required" });
      return null;
    }
    const room = roomForId(request.query.roomId);
    if (!room) {
      reply.code(404).send({ error: "room not found" });
      return null;
    }
    return room;
  }

  function resolveRunnerAgentId(room, payload, queryAgentId) {
    const declared =
      asNonemptyString(payload.agentId) ?? asNonemptyString(queryAgentId) ?? null;
    const task =
      typeof payload.taskId === "string" ? room.tasks.get(payload.taskId) ?? null : null;
    const assigned = task?.agentId ?? (!declared ? room.currentTask?.agentId : null) ?? null;
    if (declared && assigned && declared !== assigned) return null;
    const agentId =
      assigned ??
      declared ??
      room.agents.find(({ engine }) => engine === "runner")?.agentId ??
      null;
    const agent = agentId ? findAgent(room, agentId) : null;
    return agent?.engine === "runner" ? agentId : null;
  }

  app.get(
    "/runner/next-task",
    { onRequest: requireRunnerKey },
    async (request, reply) => {
      const room = runnerRoom(request, reply);
      if (!room) return reply;
      if (room.currentTask) return reply.code(204).send();
      let task = room.taskQueue.shift();
      while (task && task.status !== "queued") task = room.taskQueue.shift();
      if (!task) return reply.code(204).send();
      const agent = findAgent(room, task.agentId);
      if (!agent || agent.engine !== "runner") {
        task.status = "failed";
        return reply.code(204).send();
      }
      task.status = "started";
      room.currentTask = task;
      emit(room, "agent.turn_started", agentActor(agent), {
        taskId: task.taskId,
        agentId: task.agentId,
      });
      return {
        taskId: task.taskId,
        text: task.text,
        authorName: task.authorName,
        agentId: task.agentId,
        model: agent.model,
      };
    },
  );

  app.post(
    "/runner/events",
    { onRequest: requireRunnerKey },
    async (request, reply) => {
      const room = runnerRoom(request, reply);
      if (!room) return reply;
      if (!Array.isArray(request.body)) {
        return reply.code(400).send({ error: "body must be an array" });
      }
      const normalizedEvents = [];
      for (const candidate of request.body) {
        if (
          !isObject(candidate) ||
          !RUNNER_EVENT_TYPES.has(candidate.type) ||
          !isObject(candidate.payload)
        ) {
          return reply.code(400).send({ error: "invalid runner event" });
        }
        const payload = normalizeRunnerPayload(candidate.type, candidate.payload);
        if (!payload) {
          return reply.code(400).send({ error: "invalid runner event payload" });
        }
        const agentId = resolveRunnerAgentId(room, payload, request.query?.agentId);
        if (!agentId) {
          return reply.code(400).send({ error: "invalid or mismatched agentId" });
        }
        if (candidate.type.startsWith("agent.")) payload.agentId = agentId;
        else if (Object.hasOwn(payload, "agentId")) payload.agentId = agentId;
        normalizedEvents.push({ type: candidate.type, payload, agentId });
      }
      for (const candidate of normalizedEvents) {
        const agent = findAgent(room, candidate.agentId);
        const event = emit(room, candidate.type, agentActor(agent), candidate.payload);
        processAgentSideEffects(room, event);
      }
      return { ok: true };
    },
  );

  app.post(
    "/runner/interrupted",
    { onRequest: requireRunnerKey },
    async (request, reply) => {
      const room = runnerRoom(request, reply);
      if (!room) return reply;
      if (room.currentTask) {
        room.currentTask.status = "queued";
        room.taskQueue.unshift(room.currentTask);
        room.currentTask = null;
      }
      return reply.code(204).send();
    },
  );

  function validateRoomInput(body) {
    if (!isObject(body)) return { error: "body must be an object" };
    const name = asNonemptyString(body.name);
    const goal = asNonemptyString(body.goal);
    if (!name || !goal) return { error: "name and goal are required" };
    if (!Array.isArray(body.agents) || body.agents.length === 0) {
      return { error: "select at least one agent" };
    }
    if (!body.agents.every((agentId) => typeof agentId === "string")) {
      return { error: "agents must be agent ids" };
    }
    if (new Set(body.agents).size !== body.agents.length) {
      return { error: "agents must not contain duplicates" };
    }
    const agents = [];
    for (const agentId of body.agents) {
      const builtIn = BUILTIN_AGENTS[agentId];
      if (!builtIn || (agentId === "claude" && !reflexEnabled)) {
        return { error: `agent ${agentId} is unavailable` };
      }
      agents.push(cloneAgent(builtIn));
    }
    const repoUrl = optionalString(body.repoUrl);
    const importThreadId = optionalString(body.importThreadId);
    if (repoUrl === null || importThreadId === null) {
      return { error: "repoUrl and importThreadId must be non-empty strings" };
    }
    if (name.length > 120 || goal.length > 10_000) {
      return { error: "room name or goal is too long" };
    }
    if ((repoUrl?.length ?? 0) > 2_000 || (importThreadId?.length ?? 0) > 500) {
      return { error: "import details are too long" };
    }
    return { name, goal, agents, repoUrl, importThreadId };
  }

  app.post("/rooms", async (request, reply) => {
    const validated = validateRoomInput(request.body);
    if (validated.error) return reply.code(400).send({ error: validated.error });
    const room = createRoomState(validated);
    state.rooms.set(room.roomId, room);
    initialRoomEvents(room);
    const origin = requestOrigin(request);
    setImmediate(() => {
      if (!closing) initializeRoom(room, publicUrl);
    });
    return reply
      .code(201)
      .send(roomRecord(room, { includeSecrets: true, origin }));
  });

  app.get("/rooms", async () =>
    [...state.rooms.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((room) => ({
        id: room.roomId,
        name: room.name,
        status: room.workspace.status,
        createdAt: room.createdAt,
      })),
  );

  app.get("/rooms/:roomId", async (request, reply) => {
    const room = roomForId(request.params.roomId);
    if (!room) return reply.code(404).send({ error: "room not found" });
    provisioner.touch?.(room.roomId);
    const queryKey = request.query?.k;
    const headerKey = request.headers["x-ensemble-invite"];
    const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const key =
      (typeof queryKey === "string" && queryKey) ||
      (typeof headerKey === "string" && headerKey) ||
      bearer;
    return roomRecord(room, {
      includeSecrets: inviteMatches(key, room.invites.steer),
      origin: requestOrigin(request),
    });
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/bundle", async (_request, reply) => {
    if (!bundlePath || !existsSync(bundlePath)) {
      return reply.code(404).send({ error: "workspace bundle is unavailable" });
    }
    reply.header("cache-control", "no-store");
    reply.type("application/gzip");
    return reply.send(createReadStream(bundlePath));
  });

  const demoEnabled = options.demoRoom ?? envFlagEnabled(process.env.DEMO_ROOM, false);
  if (demoEnabled) {
    const rawDemoWorkspace = options.demoWorkspace ?? process.env.DEMO_WORKSPACE_JSON;
    let demoWorkspace;
    try {
      demoWorkspace =
        typeof rawDemoWorkspace === "string"
          ? JSON.parse(rawDemoWorkspace)
          : rawDemoWorkspace;
    } catch (error) {
      throw new Error(`DEMO_WORKSPACE_JSON is invalid: ${error.message}`);
    }
    if (
      !isObject(demoWorkspace) ||
      !asNonemptyString(demoWorkspace.devboxId) ||
      !asNonemptyString(demoWorkspace.previewUrl)
    ) {
      throw new Error("DEMO_WORKSPACE_JSON needs devboxId and previewUrl");
    }
    const demo = createRoomState({
      roomId: "demo",
      name: options.demoName ?? "Ensemble Demo",
      goal:
        options.demoGoal ??
        "Build Roomboard together through a live multiplayer AI session",
      agents: [BUILTIN_AGENTS.turbo],
      invites: {
        steer: options.demoSteerToken ?? process.env.DEMO_STEER_TOKEN ?? newInviteToken(),
        view: options.demoViewToken ?? process.env.DEMO_VIEW_TOKEN ?? newInviteToken(),
      },
      workspace: {
        status: "ready",
        devboxId: demoWorkspace.devboxId,
        previewUrl: demoWorkspace.previewUrl,
      },
      pinned: true,
    });
    demo.runnerUrl =
      asNonemptyString(demoWorkspace.runnerUrl) ?? deriveRunnerUrl(demoWorkspace.previewUrl);
    state.rooms.set(demo.roomId, demo);
    initialRoomEvents(demo);
    emit(demo, "preview.updated", SYSTEM_ACTOR, {
      url: demo.workspace.previewUrl,
      agentId: demo.agents[0].agentId,
    });
    provisioner.registerPinned?.(
      demo.roomId,
      {
        devboxId: demo.workspace.devboxId,
        previewUrl: demo.workspace.previewUrl,
        runnerUrl: demo.runnerUrl,
      },
      {
        onSuspend(event) {
          demo.runnerUrl = null;
          emitWorkspaceStatus(
            demo,
            "error",
            isObject(event) && event.reason === "lru"
              ? "Workspace suspended to stay within the live workspace cap"
              : "Workspace suspended",
          );
        },
      },
    );
  }

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: false,
      index: false,
    });
    app.get("/", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/*", async (request, reply) => {
      const pathname = new URL(request.raw.url, "http://ensemble.local").pathname;
      if (isApiPath(pathname)) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    const missingWeb = async (_request, reply) =>
      reply.code(503).send({ error: "Web client has not been built yet" });
    app.get("/", missingWeb);
    app.get("/*", async (request, reply) => {
      const pathname = new URL(request.raw.url, "http://ensemble.local").pathname;
      if (isApiPath(pathname)) return reply.code(404).send({ error: "not found" });
      return missingWeb(request, reply);
    });
  }

  app.addHook("onClose", async () => {
    closing = true;
    clearInterval(heartbeat);
    for (const client of state.clients) {
      client.removed = true;
      client.socket.terminate();
    }
    state.clients.clear();
    for (const room of state.rooms.values()) {
      room.clients.clear();
      room.actors.clear();
    }
    await Promise.allSettled([
      Promise.resolve(reflexAdapter.close?.()),
      Promise.resolve(provisioner.close?.()),
    ]);
    await Promise.allSettled([...state.background]);
  });

  return app;
}

async function start() {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const app = await buildServer();
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await app.listen({ host: "0.0.0.0", port });
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
