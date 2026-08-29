import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNNER_URL = "http://127.0.0.1:8091";

const AGENT_ACTOR = Object.freeze({
  id: "act_codex",
  name: "Codex",
  kind: "agent",
});

const SYSTEM_ACTOR = Object.freeze({
  id: "act_system",
  name: "Ensemble",
  kind: "system",
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

function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonemptyString(value) {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

function publicActor(actor) {
  return { id: actor.id, name: actor.name, kind: actor.kind };
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

function normalizeRunnerPayload(type, payload) {
  switch (type) {
    case "preview.updated":
      if (!hasExactKeys(payload, ["url"]) || !areStrings(payload, ["url"])) {
        return null;
      }
      return { url: payload.url };
    case "agent.turn_started":
      if (!hasExactKeys(payload, ["taskId"]) || !areStrings(payload, ["taskId"])) {
        return null;
      }
      return { taskId: payload.taskId };
    case "agent.turn_completed":
      if (
        !hasExactKeys(payload, ["taskId", "tokens", "costUsd"]) ||
        !areStrings(payload, ["taskId"]) ||
        !areNonnegativeNumbers(payload, ["tokens", "costUsd"])
      ) {
        return null;
      }
      return {
        taskId: payload.taskId,
        tokens: payload.tokens,
        costUsd: payload.costUsd,
      };
    case "agent.thought":
    case "agent.message":
      if (!hasExactKeys(payload, ["text"]) || !areStrings(payload, ["text"])) {
        return null;
      }
      return { text: payload.text };
    case "agent.command": {
      if (
        !hasExactKeys(payload, ["command"], ["exitCode"]) ||
        !areStrings(payload, ["command"]) ||
        (Object.hasOwn(payload, "exitCode") && !Number.isInteger(payload.exitCode))
      ) {
        return null;
      }
      const normalized = { command: payload.command };
      if (Object.hasOwn(payload, "exitCode")) normalized.exitCode = payload.exitCode;
      return normalized;
    }
    case "agent.diff":
      if (
        !hasExactKeys(payload, ["file", "patch"]) ||
        !areStrings(payload, ["file", "patch"])
      ) {
        return null;
      }
      return { file: payload.file, patch: payload.patch };
    case "crew.actor_post":
      if (!hasExactKeys(payload, ["text"]) || !areStrings(payload, ["text"])) {
        return null;
      }
      return { text: payload.text };
    case "crew.task_dispatched":
      if (
        !hasExactKeys(payload, ["taskId", "text", "byActorId"]) ||
        !areStrings(payload, ["taskId", "text", "byActorId"])
      ) {
        return null;
      }
      return {
        taskId: payload.taskId,
        text: payload.text,
        byActorId: payload.byActorId,
      };
    case "crew.task_completed":
      if (
        !hasExactKeys(payload, ["taskId", "tokens", "costUsd"]) ||
        !areStrings(payload, ["taskId"]) ||
        !areNonnegativeNumbers(payload, ["tokens", "costUsd"])
      ) {
        return null;
      }
      return {
        taskId: payload.taskId,
        tokens: payload.tokens,
        costUsd: payload.costUsd,
      };
    case "crew.task_failed":
      if (
        !hasExactKeys(payload, ["taskId", "reason"]) ||
        !areStrings(payload, ["taskId", "reason"])
      ) {
        return null;
      }
      return { taskId: payload.taskId, reason: payload.reason };
    case "crew.gate_requested":
      if (
        !hasExactKeys(payload, ["gateId", "question", "taskId"]) ||
        !areStrings(payload, ["gateId", "question", "taskId"])
      ) {
        return null;
      }
      return {
        gateId: payload.gateId,
        question: payload.question,
        taskId: payload.taskId,
      };
    case "crew.gate_resolved":
      if (
        !hasExactKeys(payload, ["gateId", "approved", "byActorId"]) ||
        !areStrings(payload, ["gateId", "byActorId"]) ||
        typeof payload.approved !== "boolean"
      ) {
        return null;
      }
      return {
        gateId: payload.gateId,
        approved: payload.approved,
        byActorId: payload.byActorId,
      };
    case "crew.result_published":
      if (
        !hasExactKeys(payload, ["taskId", "summary", "diffStat"]) ||
        !areStrings(payload, ["taskId", "summary", "diffStat"])
      ) {
        return null;
      }
      return {
        taskId: payload.taskId,
        summary: payload.summary,
        diffStat: payload.diffStat,
      };
    default:
      return null;
  }
}

export async function buildServer(options = {}) {
  const ensembleKey = options.ensembleKey ?? process.env.ENSEMBLE_KEY;
  if (!ensembleKey) {
    throw new Error("ENSEMBLE_KEY is required");
  }

  const runnerUrl = options.runnerUrl ?? process.env.RUNNER_URL ?? DEFAULT_RUNNER_URL;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const webDist = options.webDist ?? resolve(SERVER_DIR, "../web/dist");
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 10 * 1024 * 1024,
  });

  const state = {
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
  };

  app.decorate("ensembleState", state);

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 2 * 1024 * 1024 },
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,x-ensemble-key");
    return payload;
  });

  app.options("/*", async (_request, reply) => reply.code(204).send());
  app.options("/", async (_request, reply) => reply.code(204).send());

  function sendJson(socket, message) {
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(message));
  }

  function sendProtocolError(client, message) {
    sendJson(client.socket, { type: "error", message });
  }

  function broadcast(event, exceptClient = null) {
    const message = JSON.stringify({ type: "event", event });
    for (const client of state.clients) {
      if (client === exceptClient || !client.actor || client.socket.readyState !== 1) {
        continue;
      }
      client.socket.send(message);
    }
  }

  function emit(type, actor, payload, exceptClient = null) {
    const event = {
      id: newId("evt"),
      ts: Date.now(),
      seq: ++state.seq,
      type,
      actor: publicActor(actor),
      payload,
    };
    state.events.push(event);
    broadcast(event, exceptClient);
    return event;
  }

  function ledgerRows() {
    return [...state.ledger.values()].map((row) => ({
      actorId: row.actorId,
      name: row.name,
      steers: row.steers,
      tokens: row.tokens,
      costUsd: row.costUsd,
      outcomes: [...row.outcomes],
    }));
  }

  function ensureLedgerRow(actor) {
    let row = state.ledger.get(actor.id);
    if (!row) {
      row = {
        actorId: actor.id,
        name: actor.name,
        steers: 0,
        tokens: 0,
        costUsd: 0,
        outcomes: [],
      };
      state.ledger.set(actor.id, row);
    }
    return row;
  }

  function emitLedger(exceptClient = null) {
    return emit("ledger.updated", SYSTEM_ACTOR, { rows: ledgerRows() }, exceptClient);
  }

  function dispatchTask(task) {
    task.status = "queued";
    state.taskQueue.push(task);
    emit("crew.task_dispatched", task.author, {
      taskId: task.taskId,
      text: task.text,
      byActorId: task.author.id,
    });
  }

  function handleSteer(client, rawText) {
    const text = asNonemptyString(rawText);
    if (!text) {
      sendProtocolError(client, "A steer needs text");
      return;
    }

    const author = client.actor;
    emit("crew.actor_post", author, { text });

    const task = {
      taskId: newId("task"),
      text,
      author,
      authorName: author.name,
      status: "proposed",
    };
    state.tasks.set(task.taskId, task);

    if (author.id === state.driverActorId) {
      dispatchTask(task);
    } else {
      const gateId = newId("gate");
      task.gateId = gateId;
      state.gates.set(gateId, {
        gateId,
        task,
        status: "pending",
        dispatchOnApprove: true,
      });
      emit("crew.gate_requested", author, {
        gateId,
        question: `${author.name} wants: ${text}…dispatch?`,
        taskId: task.taskId,
      });
    }

    ensureLedgerRow(author).steers += 1;
    emitLedger();
  }

  function handleComment(client, rawAnchor, rawText) {
    const text = asNonemptyString(rawText);
    if (!text || !isObject(rawAnchor)) {
      sendProtocolError(client, "A comment needs an anchor and text");
      return;
    }

    const anchor = {};
    if (typeof rawAnchor.file === "string" && rawAnchor.file.length > 0) {
      anchor.file = rawAnchor.file;
    }
    if (typeof rawAnchor.eventId === "string" && rawAnchor.eventId.length > 0) {
      anchor.eventId = rawAnchor.eventId;
    }
    if (!anchor.file && !anchor.eventId) {
      sendProtocolError(client, "A comment anchor needs file or eventId");
      return;
    }

    const commentId = newId("comment");
    state.comments.set(commentId, {
      commentId,
      anchor,
      text,
      author: client.actor,
      resolved: false,
    });
    emit("comment.created", client.actor, { commentId, anchor, text });
  }

  function handleGateResolution(client, gateId, approved) {
    if (client.actor.id !== state.driverActorId) {
      sendProtocolError(client, "Only the driver can resolve a gate");
      return;
    }
    if (typeof gateId !== "string" || typeof approved !== "boolean") {
      sendProtocolError(client, "A gate resolution needs gateId and approved");
      return;
    }

    const gate = state.gates.get(gateId);
    if (!gate || gate.status !== "pending") {
      sendProtocolError(client, "That gate is not pending");
      return;
    }

    gate.status = approved ? "approved" : "dismissed";
    if (gate.task) gate.task.status = approved ? "approved" : "dismissed";
    emit("crew.gate_resolved", client.actor, {
      gateId,
      approved,
      byActorId: client.actor.id,
    });
    if (approved && gate.dispatchOnApprove && gate.task) dispatchTask(gate.task);
  }

  function handleHandoff(client, toActorId) {
    if (client.actor.id !== state.driverActorId) {
      sendProtocolError(client, "Only the driver can hand off");
      return;
    }
    if (typeof toActorId !== "string" || !state.actors.has(toActorId)) {
      sendProtocolError(client, "The handoff target is not present");
      return;
    }

    state.driverActorId = toActorId;
    emit("driver.changed", client.actor, { toActorId });
  }

  async function handleInterrupt(client) {
    if (client.actor.id !== state.driverActorId) {
      sendProtocolError(client, "Only the driver can interrupt");
      return;
    }

    try {
      const response = await fetch(new URL("/runner/interrupt", runnerUrl), {
        method: "POST",
        headers: { "x-ensemble-key": ensembleKey },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        app.log.warn({ statusCode: response.status }, "runner rejected interrupt");
      }
    } catch (error) {
      app.log.warn({ err: error }, "could not reach runner interrupt endpoint");
    }
  }

  function removeClient(client) {
    if (client.removed) return;
    client.removed = true;
    state.clients.delete(client);
    if (!client.actor) return;

    const departed = client.actor;
    state.actors.delete(departed.id);
    emit("actor.left", departed, {});

    if (state.driverActorId === departed.id) {
      const nextDriver = state.actors.keys().next().value ?? null;
      state.driverActorId = nextDriver;
      emit("driver.changed", SYSTEM_ACTOR, { toActorId: nextDriver });
    }
  }

  function joinClient(client, rawName) {
    if (client.actor) {
      sendProtocolError(client, "This connection has already joined");
      return;
    }

    const name = asNonemptyString(rawName);
    if (!name) {
      sendProtocolError(client, "Join needs a name");
      return;
    }

    const actor = { id: newId("act"), name, kind: "human" };
    client.actor = actor;
    state.actors.set(actor.id, client);
    ensureLedgerRow(actor);

    emit("actor.joined", actor, { name: actor.name, kind: actor.kind }, client);
    if (state.driverActorId === null) {
      state.driverActorId = actor.id;
      emit("driver.changed", SYSTEM_ACTOR, { toActorId: actor.id }, client);
    }
    emitLedger(client);

    sendJson(client.socket, {
      type: "welcome",
      actorId: actor.id,
      driverActorId: state.driverActorId,
      events: state.events,
    });
  }

  app.get("/ws", { websocket: true }, (socket) => {
    const client = { socket, actor: null, alive: true, removed: false };
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
        joinClient(client, message.name);
        return;
      }

      switch (message.type) {
        case "steer":
          handleSteer(client, message.text);
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

  function processRunnerSideEffects(event) {
    const taskId = event.payload.taskId;
    const task = typeof taskId === "string" ? state.tasks.get(taskId) : null;

    if (event.type === "crew.gate_requested") {
      state.gates.set(event.payload.gateId, {
        gateId: event.payload.gateId,
        task: null,
        relatedTaskId: event.payload.taskId,
        status: "pending",
        dispatchOnApprove: false,
      });
    }

    if (event.type === "crew.gate_resolved") {
      const gate = state.gates.get(event.payload.gateId);
      if (gate && gate.status === "pending") {
        gate.status = event.payload.approved ? "approved" : "dismissed";
      }
    }

    if (event.type === "agent.turn_completed" && task) {
      const tokens = Number(event.payload.tokens);
      const costUsd = Number(event.payload.costUsd);
      const row = ensureLedgerRow(task.author);
      if (Number.isFinite(tokens)) row.tokens += tokens;
      if (Number.isFinite(costUsd)) row.costUsd += costUsd;
      emitLedger();
    }

    if (event.type === "crew.result_published" && task) {
      const row = ensureLedgerRow(task.author);
      if (typeof event.payload.summary === "string") {
        row.outcomes.push(event.payload.summary);
      }
      emitLedger();
    }

    if (
      (event.type === "crew.task_completed" || event.type === "crew.task_failed") &&
      task
    ) {
      task.status = event.type === "crew.task_completed" ? "completed" : "failed";
      if (state.currentTask?.taskId === task.taskId) state.currentTask = null;
    }
  }

  app.get(
    "/runner/next-task",
    { onRequest: requireRunnerKey },
    async (_request, reply) => {
      if (state.currentTask) return reply.code(204).send();

      let task = state.taskQueue.shift();
      while (task && task.status !== "queued") task = state.taskQueue.shift();
      if (!task) return reply.code(204).send();

      task.status = "started";
      state.currentTask = task;
      emit("agent.turn_started", AGENT_ACTOR, { taskId: task.taskId });
      return {
        taskId: task.taskId,
        text: task.text,
        authorName: task.authorName,
      };
    },
  );

  app.post(
    "/runner/events",
    { onRequest: requireRunnerKey },
    async (request, reply) => {
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
        normalizedEvents.push({ type: candidate.type, payload });
      }

      for (const candidate of normalizedEvents) {
        const event = emit(candidate.type, AGENT_ACTOR, candidate.payload);
        processRunnerSideEffects(event);
      }

      return { ok: true };
    },
  );

  app.post(
    "/runner/interrupted",
    { onRequest: requireRunnerKey },
    async (_request, reply) => {
      if (state.currentTask) {
        state.currentTask.status = "queued";
        state.taskQueue.unshift(state.currentTask);
        state.currentTask = null;
      }
      return reply.code(204).send();
    },
  );

  app.get("/healthz", async () => ({ ok: true }));

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
    });
  } else {
    app.get("/", async (_request, reply) =>
      reply.code(503).send({ error: "Web client has not been built yet" }),
    );
  }

  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const client of state.clients) {
      client.removed = true;
      client.socket.terminate();
    }
    state.clients.clear();
    state.actors.clear();
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
