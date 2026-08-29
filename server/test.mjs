import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { BUILTIN_AGENTS, buildServer } from "./index.js";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ENSEMBLE_KEY = "ensemble-v2-test-key";
const PUBLIC_URL = "https://ensemble.test";
const REQUEST_TIMEOUT_MS = 4_000;
const SPA_MARKER = "ensemble-v2-spa-fixture";

class WsPeer {
  constructor(socket) {
    this.socket = socket;
    this.history = [];
    this.queue = [];
    this.waiters = [];

    socket.addEventListener("message", (message) => {
      const parsed = JSON.parse(message.data);
      this.history.push(parsed);
      this.queue.push(parsed);
      this.#flush();
    });
  }

  #flush() {
    for (let waiterIndex = 0; waiterIndex < this.waiters.length; waiterIndex += 1) {
      const waiter = this.waiters[waiterIndex];
      const messageIndex = this.queue.findIndex(waiter.predicate);
      if (messageIndex === -1) continue;
      const [message] = this.queue.splice(messageIndex, 1);
      this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      waiterIndex -= 1;
    }
  }

  waitFor(predicate, description, timeoutMs = REQUEST_TIMEOUT_MS) {
    const messageIndex = this.queue.findIndex(predicate);
    if (messageIndex !== -1) {
      const [message] = this.queue.splice(messageIndex, 1);
      return Promise.resolve(message);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${description}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  waitForEvent(type, payloadPredicate = () => true) {
    return this.waitFor(
      (message) =>
        message.type === "event" &&
        message.event.type === type &&
        payloadPredicate(message.event.payload, message.event),
      type,
    ).then((message) => message.event);
  }

  waitForError(pattern) {
    return this.waitFor(
      (message) =>
        message.type === "error" &&
        (pattern instanceof RegExp
          ? pattern.test(message.message ?? "")
          : (message.message ?? "").includes(pattern)),
      `protocol error ${String(pattern)}`,
    );
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) =>
      this.socket.addEventListener("close", resolve, { once: true }),
    );
    this.socket.close();
    await Promise.race([closed, delay(500)]);
  }
}

async function openPeer(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening ${wsUrl}`));
    }, REQUEST_TIMEOUT_MS);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket connection failed for ${wsUrl}`));
      },
      { once: true },
    );
  });
  return new WsPeer(socket);
}

async function connect(wsUrl, { roomId, name, key }) {
  const peer = await openPeer(wsUrl);
  peer.send({ type: "join", roomId, name, key });
  const welcome = await peer.waitFor(
    (message) => message.type === "welcome",
    `${name} welcome for ${roomId}`,
  );
  assert.equal(peer.history[0], welcome, "welcome must be the first joined frame");
  return { peer, welcome };
}

function assertEnvelope(event) {
  assert.match(event.id, /^evt_[a-f0-9]+$/);
  assert.ok(Number.isInteger(event.ts) && event.ts > 0);
  assert.ok(Number.isInteger(event.seq) && event.seq > 0);
  assert.equal(typeof event.type, "string");
  assert.equal(typeof event.actor.id, "string");
  assert.equal(typeof event.actor.name, "string");
  assert.ok(["human", "agent", "system"].includes(event.actor.kind));
  assert.ok(event.payload && typeof event.payload === "object");
}

function assertOrderedReplay(events) {
  assert.ok(events.length > 0, "room replay should not be empty");
  const ids = new Set();
  let previousSeq = 0;
  for (const event of events) {
    assertEnvelope(event);
    assert.ok(event.seq > previousSeq, "room seq values must increase");
    assert.ok(!ids.has(event.id), "event ids must be unique within a room");
    ids.add(event.id);
    previousSeq = event.seq;
  }
}

function eventInHistory(peer, type, payloadPredicate = () => true) {
  return peer.history.some(
    (message) =>
      message.type === "event" &&
      message.event.type === type &&
      payloadPredicate(message.event.payload, message.event),
  );
}

async function waitUntil(predicate, description, timeoutMs = REQUEST_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeHttpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function createProvisionerMock(runnerUrl) {
  const calls = [];
  const touches = [];
  const pinned = [];
  let closeCalls = 0;

  return {
    calls,
    touches,
    pinned,
    get closeCalls() {
      return closeCalls;
    },
    async provision(room, controls) {
      calls.push({
        room: structuredClone(room),
        hubUrl: controls.hubUrl,
        ensembleKey: controls.ensembleKey,
        controls,
      });
      controls.onProgress?.({
        type: "workspace.status",
        status: "provisioning",
        detail: `Mock boot for ${room.roomId}`,
      });
      return {
        devboxId: `devbox_${room.roomId}`,
        previewUrl: `https://5173-${room.roomId}.tunnel.runloop.ai`,
        runnerUrl,
      };
    },
    touch(roomId) {
      touches.push(roomId);
    },
    registerPinned(roomId, workspace, controls) {
      pinned.push({ roomId, workspace: structuredClone(workspace), controls });
    },
    async close() {
      closeCalls += 1;
    },
  };
}

function createReflexMock() {
  const createCalls = [];
  const steerCalls = [];
  const registrations = new Map();
  let closeCalls = 0;

  return {
    configured: true,
    createCalls,
    steerCalls,
    registrations,
    get closeCalls() {
      return closeCalls;
    },
    async createAgent(room, agent, controls) {
      const reflexAgentId = `reflex_${room.roomId}_${agent.agentId}`;
      createCalls.push({
        room: structuredClone(room),
        agent: structuredClone(agent),
        reflexAgentId,
      });
      registrations.set(reflexAgentId, controls);
      return { reflexAgentId };
    },
    async steer(reflexAgentId, text, context) {
      steerCalls.push({ reflexAgentId, text, context: structuredClone(context) });
      const controls = registrations.get(reflexAgentId);
      assert.ok(controls, `Reflex mock must know ${reflexAgentId}`);
      controls.emit("agent.turn_started", { taskId: context.taskId });
      controls.emit("agent.message", { text: `Reflex handled: ${text}` });
      controls.emit("agent.turn_completed", {
        taskId: context.taskId,
        tokens: 7,
        costUsd: 0.000021,
      });
      controls.emit("crew.result_published", {
        taskId: context.taskId,
        summary: "Reflex result",
        diffStat: "1 file changed",
      });
      controls.emit("crew.task_completed", {
        taskId: context.taskId,
        tokens: 7,
        costUsd: 0.000021,
      });
      return { ok: true };
    },
    async close() {
      closeCalls += 1;
    },
  };
}

async function jsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const peers = [];
  const interrupts = [];
  let fixtureDir;
  let interruptServer;
  let app;
  let guardApp;
  let provisioner;
  let reflex;

  try {
    fixtureDir = await mkdtemp(join(SERVER_DIR, ".test-web-"));
    await writeFile(
      join(fixtureDir, "index.html"),
      `<!doctype html><title>Ensemble test</title><main>${SPA_MARKER}</main>`,
    );

    interruptServer = createServer((request, response) => {
      request.resume();
      if (request.method === "POST" && request.url === "/runner/interrupt") {
        interrupts.push({
          method: request.method,
          url: request.url,
          key: request.headers["x-ensemble-key"],
        });
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    const interruptUrl = await listen(interruptServer);
    provisioner = createProvisionerMock(interruptUrl);
    reflex = createReflexMock();

    app = await buildServer({
      ensembleKey: ENSEMBLE_KEY,
      publicUrl: PUBLIC_URL,
      runnerUrl: interruptUrl,
      heartbeatMs: 60_000,
      webDist: fixtureDir,
      logger: false,
      provisioner,
      reflexAdapter: reflex,
      reflexEnabled: true,
      reflexApiKey: "mock-reflex-key",
      demoRoom: true,
      demoWorkspace: {
        devboxId: "devbox_demo",
        previewUrl: "https://5173-demo-key.tunnel.runloop.ai",
        runnerUrl: interruptUrl,
      },
      demoSteerToken: "demo-steer-token",
      demoViewToken: "demo-view-token",
    });

    assert.equal(provisioner.calls.length, 0, "demo must bypass provisioning");
    assert.equal(provisioner.pinned.length, 1, "demo workspace must be registered pinned");
    assert.equal(provisioner.pinned[0].roomId, "demo");
    assert.deepEqual(provisioner.pinned[0].workspace, {
      devboxId: "devbox_demo",
      previewUrl: "https://5173-demo-key.tunnel.runloop.ai",
      runnerUrl: interruptUrl,
    });
    assert.equal(app.ensembleState.rooms.get("demo")?.pinned, true);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = app.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const fetchPath = (path, init = {}) =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    const runnerFetch = (path, init = {}) =>
      fetchPath(path, {
        ...init,
        headers: {
          "x-ensemble-key": ENSEMBLE_KEY,
          ...(init.headers ?? {}),
        },
      });

    let response = await fetchPath("/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const guardProvisioner = createProvisionerMock(interruptUrl);
    const guardReflex = createReflexMock();
    guardReflex.configured = false;
    guardApp = await buildServer({
      ensembleKey: ENSEMBLE_KEY,
      publicUrl: "",
      heartbeatMs: 60_000,
      webDist: fixtureDir,
      logger: false,
      provisioner: guardProvisioner,
      reflexAdapter: guardReflex,
      reflexEnabled: true,
      demoRoom: false,
    });
    let guardResponse = await guardApp.inject({
      method: "POST",
      url: "/rooms",
      payload: {
        name: "Unavailable Reflex",
        goal: "Must not be accepted without complete credentials",
        agents: ["claude"],
      },
    });
    assert.equal(guardResponse.statusCode, 400);
    assert.match(guardResponse.json().error, /claude.*unavailable/i);
    assert.equal(guardReflex.createCalls.length, 0);

    guardResponse = await guardApp.inject({
      method: "POST",
      url: "/rooms",
      headers: {
        host: "attacker.invalid",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "https",
      },
      payload: {
        name: "No trusted hub origin",
        goal: "Never fetch a bundle through request-controlled host headers",
        agents: ["turbo"],
      },
    });
    assert.equal(guardResponse.statusCode, 201);
    const guardedRoom = guardResponse.json();
    await waitUntil(
      () => guardApp.ensembleState.rooms.get(guardedRoom.roomId)?.workspace.status === "error",
      "missing PUBLIC_URL provisioning failure",
    );
    assert.equal(guardProvisioner.calls.length, 0);
    assert.ok(
      guardApp.ensembleState.rooms
        .get(guardedRoom.roomId)
        .events.some(
          ({ type, payload }) =>
            type === "workspace.status" &&
            payload.status === "error" &&
            /PUBLIC_URL/.test(payload.detail ?? ""),
        ),
    );
    await guardApp.close();
    guardApp = null;

    const rootHtml = await (await fetchPath("/")).text();
    assert.ok(rootHtml.includes(SPA_MARKER));
    const sessionHtml = await (await fetchPath("/s/demo?k=ignored-by-spa")).text();
    assert.ok(sessionHtml.includes(SPA_MARKER), "session history route must serve SPA");
    const nestedHtml = await (await fetchPath("/another/client/route")).text();
    assert.ok(nestedHtml.includes(SPA_MARKER), "non-API GETs must serve SPA");
    response = await fetchPath("/runner/not-a-route");
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes(SPA_MARKER));
    response = await fetchPath("/bundle");
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes(SPA_MARKER));

    const invalidCreate = await fetchPath("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Invalid", goal: "No agents", agents: [] }),
    });
    assert.equal(invalidCreate.status, 400);
    assert.equal(provisioner.calls.length, 0);

    response = await fetchPath("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Alpha room",
        goal: "Ship the alpha experience",
        agents: ["turbo", "deep", "claude"],
        repoUrl: "https://example.test/alpha.git",
        importThreadId: "thread-alpha",
      }),
    });
    assert.equal(response.status, 201);
    const alpha = await response.json();
    assert.match(alpha.roomId, /^room_[a-f0-9]+$/);
    assert.equal(alpha.name, "Alpha room");
    assert.equal(alpha.goal, "Ship the alpha experience");
    assert.equal(alpha.repoUrl, "https://example.test/alpha.git");
    assert.equal(alpha.importThreadId, "thread-alpha");
    assert.equal(alpha.workspace.status, "provisioning");
    assert.deepEqual(
      alpha.agents.map(({ agentId, label, engine, model }) => ({
        agentId,
        label,
        engine,
        model,
      })),
      ["turbo", "deep", "claude"].map((agentId) => {
        const { label, engine, model } = BUILTIN_AGENTS[agentId];
        return { agentId, label, engine, model };
      }),
    );
    assert.match(alpha.invites.steer, /^[A-Za-z0-9_-]{32}$/);
    assert.match(alpha.invites.view, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(alpha.invites.steer, alpha.invites.view);
    assert.equal(
      alpha.links.steer,
      `${PUBLIC_URL}/s/${alpha.roomId}?k=${alpha.invites.steer}`,
    );
    assert.equal(
      alpha.links.view,
      `${PUBLIC_URL}/s/${alpha.roomId}?k=${alpha.invites.view}`,
    );

    response = await fetchPath("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Beta room",
        goal: "Keep beta isolated",
        agents: ["turbo"],
      }),
    });
    assert.equal(response.status, 201);
    const beta = await response.json();
    assert.notEqual(beta.roomId, alpha.roomId);
    assert.notEqual(beta.invites.steer, alpha.invites.steer);
    assert.notEqual(beta.invites.view, alpha.invites.view);

    await waitUntil(
      () => provisioner.calls.length === 2 && reflex.createCalls.length === 1,
      "mock provisioning and Reflex registration",
    );
    assert.deepEqual(
      new Set(provisioner.calls.map(({ room }) => room.roomId)),
      new Set([alpha.roomId, beta.roomId]),
    );
    assert.ok(
      provisioner.calls.every(({ room }) => !room.invites && !room.links),
      "provisioner receives no invite secrets",
    );
    assert.ok(
      provisioner.calls.every(
        ({ hubUrl, ensembleKey }) =>
          hubUrl === PUBLIC_URL && ensembleKey === ENSEMBLE_KEY,
      ),
    );
    assert.equal(reflex.createCalls[0].room.roomId, alpha.roomId);
    assert.equal(reflex.createCalls[0].agent.agentId, "claude");

    const alphaReady = await waitUntil(async () => {
      const roomResponse = await fetchPath(
        `/rooms/${alpha.roomId}?k=${encodeURIComponent(alpha.invites.steer)}`,
      );
      const room = await roomResponse.json();
      return room.workspace.status === "ready" &&
        room.agents.find(({ agentId }) => agentId === "claude")?.reflexAgentId
        ? room
        : null;
    }, "alpha workspace and Reflex readiness");
    assert.equal(alphaReady.workspace.devboxId, `devbox_${alpha.roomId}`);
    assert.equal(
      alphaReady.workspace.previewUrl,
      `https://5173-${alpha.roomId}.tunnel.runloop.ai`,
    );

    response = await fetchPath("/rooms");
    assert.equal(response.status, 200);
    const rooms = await response.json();
    assert.deepEqual(
      new Set(rooms.map(({ id }) => id)),
      new Set(["demo", alpha.roomId, beta.roomId]),
    );
    for (const summary of rooms) {
      assert.deepEqual(Object.keys(summary).sort(), ["createdAt", "id", "name", "status"]);
    }
    const serializedList = JSON.stringify(rooms);
    for (const token of [
      alpha.invites.steer,
      alpha.invites.view,
      beta.invites.steer,
      beta.invites.view,
      "demo-steer-token",
      "demo-view-token",
    ]) {
      assert.ok(!serializedList.includes(token), "room list must redact invite tokens");
    }

    const publicAlpha = await jsonResponse(await fetchPath(`/rooms/${alpha.roomId}`));
    assert.ok(!Object.hasOwn(publicAlpha, "invites"));
    assert.ok(!Object.hasOwn(publicAlpha, "links"));
    const viewAlpha = await jsonResponse(
      await fetchPath(
        `/rooms/${alpha.roomId}?k=${encodeURIComponent(alpha.invites.view)}`,
      ),
    );
    assert.ok(!Object.hasOwn(viewAlpha, "invites"));
    assert.ok(!Object.hasOwn(viewAlpha, "links"));
    const steerAlpha = await jsonResponse(
      await fetchPath(`/rooms/${alpha.roomId}`, {
        headers: { "x-ensemble-invite": alpha.invites.steer },
      }),
    );
    assert.deepEqual(steerAlpha.invites, alpha.invites);
    assert.deepEqual(steerAlpha.links, alpha.links);
    response = await fetchPath("/rooms/not-a-room");
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes(SPA_MARKER));

    const demoPublic = await jsonResponse(await fetchPath("/rooms/demo"));
    assert.deepEqual(demoPublic.workspace, {
      status: "ready",
      devboxId: "devbox_demo",
      previewUrl: "https://5173-demo-key.tunnel.runloop.ai",
    });
    assert.ok(!demoPublic.invites);
    const demoSteer = await jsonResponse(
      await fetchPath("/rooms/demo?k=demo-steer-token"),
    );
    assert.deepEqual(demoSteer.invites, {
      steer: "demo-steer-token",
      view: "demo-view-token",
    });
    assert.ok(
      !provisioner.calls.some(({ room }) => room.roomId === "demo"),
      "pinned demo must never be dynamically provisioned",
    );

    let peer = await openPeer(wsUrl);
    peers.push(peer);
    peer.send({
      type: "join",
      roomId: alpha.roomId,
      name: "Mallory",
      key: "not-an-invite",
    });
    await peer.waitForError(/invite is invalid/i);
    assert.equal(app.ensembleState.rooms.get(alpha.roomId).actors.size, 0);
    await peer.close();
    peers.pop();

    peer = await openPeer(wsUrl);
    peers.push(peer);
    peer.send({
      type: "join",
      roomId: "missing-room",
      name: "Mallory",
      key: alpha.invites.steer,
    });
    await peer.waitForError(/valid roomId/i);
    await peer.close();
    peers.pop();

    const betaViewer = await connect(wsUrl, {
      roomId: beta.roomId,
      name: "Beta Viewer",
      key: beta.invites.view,
    });
    peers.push(betaViewer.peer);
    assert.equal(betaViewer.welcome.role, "viewer");
    assert.equal(betaViewer.welcome.driverActorId, null);
    assert.ok(!betaViewer.welcome.room.invites);
    assertOrderedReplay(betaViewer.welcome.events);

    const betaDriver = await connect(wsUrl, {
      roomId: beta.roomId,
      name: "Bea",
      key: beta.invites.steer,
    });
    peers.push(betaDriver.peer);
    assert.equal(betaDriver.welcome.role, "steerer");
    assert.equal(betaDriver.welcome.driverActorId, betaDriver.welcome.actorId);
    assert.deepEqual(betaDriver.welcome.room.invites, beta.invites);
    await betaViewer.peer.waitForEvent(
      "driver.changed",
      ({ toActorId }) => toActorId === betaDriver.welcome.actorId,
    );

    const alice = await connect(wsUrl, {
      roomId: alpha.roomId,
      name: "Alice",
      key: alpha.invites.steer,
    });
    peers.push(alice.peer);
    assert.equal(alice.welcome.role, "steerer");
    assert.equal(alice.welcome.driverActorId, alice.welcome.actorId);
    assert.equal(alice.welcome.room.roomId, alpha.roomId);
    assert.deepEqual(alice.welcome.room.invites, alpha.invites);
    assertOrderedReplay(alice.welcome.events);
    assert.equal(alice.welcome.events[0].type, "room.created");
    assert.deepEqual(
      new Set(
        alice.welcome.events
          .filter(({ type }) => type === "agent.registered")
          .map(({ payload }) => payload.agentId),
      ),
      new Set(["turbo", "deep", "claude"]),
    );
    assert.ok(
      alice.welcome.events.some(
        ({ type, payload }) => type === "workspace.status" && payload.status === "ready",
      ),
    );

    const alphaViewer = await connect(wsUrl, {
      roomId: alpha.roomId,
      name: "Vera",
      key: alpha.invites.view,
    });
    peers.push(alphaViewer.peer);
    assert.equal(alphaViewer.welcome.role, "viewer");
    assert.equal(alphaViewer.welcome.driverActorId, alice.welcome.actorId);
    assert.ok(!alphaViewer.welcome.room.invites);
    assert.ok(!alphaViewer.welcome.room.links);

    const bob = await connect(wsUrl, {
      roomId: alpha.roomId,
      name: "Bob",
      key: alpha.invites.steer,
    });
    peers.push(bob.peer);
    assert.equal(bob.welcome.role, "steerer");
    assert.equal(bob.welcome.driverActorId, alice.welcome.actorId);
    assert.notEqual(
      betaDriver.welcome.driverActorId,
      alice.welcome.driverActorId,
      "each room must have an independent driver",
    );

    betaDriver.peer.send({ type: "steer", text: "Beta-only steer" });
    const betaDispatch = await betaDriver.peer.waitForEvent(
      "crew.task_dispatched",
      ({ text }) => text === "Beta-only steer",
    );
    assert.equal(betaDispatch.payload.agentId, "turbo");
    await delay(30);
    for (const alphaPeer of [alice.peer, alphaViewer.peer, bob.peer]) {
      assert.ok(
        !eventInHistory(
          alphaPeer,
          "crew.actor_post",
          ({ text }) => text === "Beta-only steer",
        ),
        "events must never leak across rooms",
      );
    }

    const alphaState = app.ensembleState.rooms.get(alpha.roomId);
    const viewerEventCount = alphaState.events.length;
    const viewerQueueCount = alphaState.taskQueue.length;
    const viewerReflexCalls = reflex.steerCalls.length;
    const viewerInterruptCalls = interrupts.length;
    const blockedViewerMessages = [
      { type: "steer", text: "VIEWER_FORBIDDEN_STEER" },
      {
        type: "comment",
        anchor: { eventId: alice.welcome.events[0].id },
        text: "VIEWER_FORBIDDEN_COMMENT",
      },
      { type: "resolveGate", gateId: "gate_fake", approved: true },
      { type: "handoff", toActorId: alice.welcome.actorId },
      { type: "interrupt" },
    ];
    for (const message of blockedViewerMessages) {
      alphaViewer.peer.send(message);
      await alphaViewer.peer.waitForError(/view-only/i);
    }
    await delay(20);
    assert.equal(alphaState.events.length, viewerEventCount);
    assert.equal(alphaState.taskQueue.length, viewerQueueCount);
    assert.equal(reflex.steerCalls.length, viewerReflexCalls);
    assert.equal(interrupts.length, viewerInterruptCalls);

    alice.peer.send({ type: "handoff", toActorId: alphaViewer.welcome.actorId });
    await alice.peer.waitForError(/present steerer/i);
    assert.equal(alphaState.driverActorId, alice.welcome.actorId);

    alice.peer.send({ type: "interrupt" });
    await waitUntil(() => interrupts.length === 1, "driver interrupt request");
    assert.deepEqual(interrupts[0], {
      method: "POST",
      url: "/runner/interrupt",
      key: ENSEMBLE_KEY,
    });
    const savedRunnerUrl = alphaState.runnerUrl;
    alphaState.runnerUrl = null;
    alice.peer.send({ type: "interrupt" });
    await alice.peer.waitForError(/runner workspace is not available/i);
    await delay(20);
    assert.equal(interrupts.length, 1, "interrupt must not fall back to another room's runner");
    alphaState.runnerUrl = savedRunnerUrl;

    const beforeInvalidAgent = alphaState.events.length;
    alice.peer.send({
      type: "steer",
      text: "This must not post",
      agentId: "missing-agent",
    });
    await alice.peer.waitForError(/selected agent/i);
    assert.equal(alphaState.events.length, beforeInvalidAgent);

    alice.peer.send({ type: "steer", text: "Turbo default" });
    const turboPost = await alice.peer.waitForEvent(
      "crew.actor_post",
      ({ text }) => text === "Turbo default",
    );
    assert.deepEqual(turboPost.payload, { text: "Turbo default" });
    const turboDispatch = await alice.peer.waitForEvent(
      "crew.task_dispatched",
      ({ text }) => text === "Turbo default",
    );
    assert.equal(turboDispatch.payload.agentId, "turbo");
    assert.equal(turboDispatch.payload.byActorId, alice.welcome.actorId);

    bob.peer.send({ type: "steer", text: "Deep gated", agentId: "deep" });
    const deepPost = await bob.peer.waitForEvent(
      "crew.actor_post",
      ({ text }) => text === "Deep gated",
    );
    const deepGate = await bob.peer.waitForEvent(
      "crew.gate_requested",
      ({ taskId }) => taskId && taskId !== turboDispatch.payload.taskId,
    );
    assert.ok(deepPost.seq < deepGate.seq);
    assert.ok(!Object.hasOwn(deepGate.payload, "agentId"));
    bob.peer.send({
      type: "resolveGate",
      gateId: deepGate.payload.gateId,
      approved: true,
    });
    await bob.peer.waitForError(/only the driver/i);
    alice.peer.send({
      type: "resolveGate",
      gateId: deepGate.payload.gateId,
      approved: true,
    });
    const deepResolved = await alice.peer.waitForEvent(
      "crew.gate_resolved",
      ({ gateId }) => gateId === deepGate.payload.gateId,
    );
    const deepDispatch = await alice.peer.waitForEvent(
      "crew.task_dispatched",
      ({ taskId }) => taskId === deepGate.payload.taskId,
    );
    assert.ok(deepResolved.seq < deepDispatch.seq);
    assert.equal(deepDispatch.payload.agentId, "deep");
    assert.equal(deepDispatch.payload.byActorId, bob.welcome.actorId);
    assert.equal(deepDispatch.actor.id, bob.welcome.actorId);

    alice.peer.send({ type: "steer", text: "Ask Claude", agentId: "claude" });
    const claudeDispatch = await alice.peer.waitForEvent(
      "crew.task_dispatched",
      ({ text }) => text === "Ask Claude",
    );
    assert.equal(claudeDispatch.payload.agentId, "claude");
    await waitUntil(() => reflex.steerCalls.length === 1, "Reflex steer routing");
    assert.deepEqual(reflex.steerCalls[0], {
      reflexAgentId: `reflex_${alpha.roomId}_claude`,
      text: "Ask Claude",
      context: {
        roomId: alpha.roomId,
        agentId: "claude",
        taskId: claudeDispatch.payload.taskId,
      },
    });
    const reflexMessage = await alice.peer.waitForEvent(
      "agent.message",
      ({ text }) => text === "Reflex handled: Ask Claude",
    );
    assert.equal(reflexMessage.payload.agentId, "claude");
    assert.deepEqual(reflexMessage.actor, {
      id: "act_claude",
      name: "Claude Code",
      kind: "agent",
    });
    assert.deepEqual(
      alphaState.taskQueue.map(({ agentId }) => agentId),
      ["turbo", "deep"],
      "Reflex tasks must not enter the runner queue",
    );

    response = await fetchPath(
      `/runner/next-task?roomId=${encodeURIComponent(alpha.roomId)}`,
    );
    assert.equal(response.status, 401);
    response = await fetchPath(
      `/runner/next-task?roomId=${encodeURIComponent(alpha.roomId)}`,
      { headers: { "x-ensemble-key": "wrong" } },
    );
    assert.equal(response.status, 401);
    response = await fetchPath("/runner/events?roomId=missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not valid json",
    });
    assert.equal(response.status, 401, "runner auth must precede body parsing");
    response = await runnerFetch("/runner/next-task");
    assert.equal(response.status, 400);
    response = await runnerFetch("/runner/next-task?roomId=missing");
    assert.equal(response.status, 404);
    response = await runnerFetch("/runner/interrupted", { method: "POST" });
    assert.equal(response.status, 400);

    response = await runnerFetch(
      `/runner/next-task?roomId=${encodeURIComponent(alpha.roomId)}`,
    );
    assert.equal(response.status, 200);
    const turboTask = await response.json();
    assert.deepEqual(turboTask, {
      taskId: turboDispatch.payload.taskId,
      text: "Turbo default",
      authorName: "Alice",
      agentId: "turbo",
      model: BUILTIN_AGENTS.turbo.model,
    });
    const turboStarted = await alice.peer.waitForEvent(
      "agent.turn_started",
      ({ taskId }) => taskId === turboTask.taskId,
    );
    assert.equal(turboStarted.payload.agentId, "turbo");

    response = await runnerFetch(
      `/runner/next-task?roomId=${encodeURIComponent(beta.roomId)}`,
    );
    assert.equal(response.status, 200, "another room may lease its own task");
    const betaTask = await response.json();
    assert.equal(betaTask.taskId, betaDispatch.payload.taskId);
    assert.equal(betaTask.agentId, "turbo");

    response = await runnerFetch(
      `/runner/next-task?roomId=${encodeURIComponent(alpha.roomId)}`,
    );
    assert.equal(response.status, 204, "a room may only have one current runner task");

    const beforeAtomicBatch = alphaState.events.length;
    response = await runnerFetch(
      `/runner/events?roomId=${encodeURIComponent(alpha.roomId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { type: "agent.message", payload: { text: "ATOMIC_SENTINEL" } },
          { type: "agent.command", payload: {} },
        ]),
      },
    );
    assert.equal(response.status, 400);
    assert.equal(alphaState.events.length, beforeAtomicBatch);
    assert.ok(
      !eventInHistory(
        alice.peer,
        "agent.message",
        ({ text }) => text === "ATOMIC_SENTINEL",
      ),
    );

    response = await runnerFetch(
      `/runner/events?roomId=${encodeURIComponent(alpha.roomId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          {
            type: "agent.turn_completed",
            payload: {
              taskId: turboTask.taskId,
              tokens: 1,
              costUsd: 0,
              agentId: "deep",
            },
          },
        ]),
      },
    );
    assert.equal(response.status, 400, "task agentId mismatches must be rejected");

    const spoofActor = { id: "spoof", name: "Spoof", kind: "human" };
    response = await runnerFetch(
      `/runner/events?roomId=${encodeURIComponent(alpha.roomId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          {
            id: "evt_spoofed",
            ts: 1,
            seq: -1,
            actor: spoofActor,
            type: "agent.message",
            payload: { text: "Turbo shipped" },
          },
          {
            type: "agent.turn_completed",
            payload: { taskId: turboTask.taskId, tokens: 100, costUsd: 0.0003 },
          },
          {
            type: "crew.result_published",
            payload: {
              taskId: turboTask.taskId,
              summary: "Turbo result",
              diffStat: "2 files changed",
            },
          },
          {
            type: "crew.task_completed",
            payload: { taskId: turboTask.taskId, tokens: 100, costUsd: 0.0003 },
          },
        ]),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const turboMessage = await alice.peer.waitForEvent(
      "agent.message",
      ({ text }) => text === "Turbo shipped",
    );
    assertEnvelope(turboMessage);
    assert.notEqual(turboMessage.id, "evt_spoofed");
    assert.notEqual(turboMessage.ts, 1);
    assert.equal(turboMessage.payload.agentId, "turbo");
    assert.deepEqual(turboMessage.actor, {
      id: "act_turbo",
      name: "Codex Turbo",
      kind: "agent",
    });
    const turboCompleted = await alice.peer.waitForEvent(
      "agent.turn_completed",
      ({ taskId }) => taskId === turboTask.taskId,
    );
    assert.equal(turboCompleted.payload.agentId, "turbo");

    response = await runnerFetch(
      `/runner/next-task?roomId=${encodeURIComponent(alpha.roomId)}`,
    );
    assert.equal(response.status, 200);
    const deepTask = await response.json();
    assert.deepEqual(deepTask, {
      taskId: deepDispatch.payload.taskId,
      text: "Deep gated",
      authorName: "Bob",
      agentId: "deep",
      model: BUILTIN_AGENTS.deep.model,
    });

    response = await runnerFetch(
      `/runner/interrupted?roomId=${encodeURIComponent(alpha.roomId)}`,
      { method: "POST" },
    );
    assert.equal(response.status, 204);
    assert.equal(alphaState.currentTask, null);
    response = await runnerFetch(
      `/runner/next-task?roomId=${encodeURIComponent(alpha.roomId)}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), deepTask, "interrupted task must be requeued");

    response = await runnerFetch(
      `/runner/events?roomId=${encodeURIComponent(alpha.roomId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          {
            type: "agent.message",
            payload: { text: "Deep resumed", agentId: "deep" },
          },
          {
            type: "agent.turn_completed",
            payload: {
              taskId: deepTask.taskId,
              tokens: 40,
              costUsd: 0.00012,
              agentId: "deep",
            },
          },
          {
            type: "crew.result_published",
            payload: {
              taskId: deepTask.taskId,
              summary: "Deep result",
              diffStat: "1 file changed",
              agentId: "deep",
            },
          },
          {
            type: "crew.task_completed",
            payload: {
              taskId: deepTask.taskId,
              tokens: 40,
              costUsd: 0.00012,
              agentId: "deep",
            },
          },
        ]),
      },
    );
    assert.equal(response.status, 200);
    const deepMessage = await alice.peer.waitForEvent(
      "agent.message",
      ({ text }) => text === "Deep resumed",
    );
    assert.equal(deepMessage.payload.agentId, "deep");
    assert.deepEqual(deepMessage.actor, {
      id: "act_deep",
      name: "Codex Deep",
      kind: "agent",
    });

    response = await runnerFetch(
      `/runner/events?roomId=${encodeURIComponent(beta.roomId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { type: "agent.message", payload: { text: "Beta runner event" } },
          {
            type: "agent.turn_completed",
            payload: { taskId: betaTask.taskId, tokens: 5, costUsd: 0.000015 },
          },
          {
            type: "crew.task_completed",
            payload: { taskId: betaTask.taskId, tokens: 5, costUsd: 0.000015 },
          },
        ]),
      },
    );
    assert.equal(response.status, 200);
    const betaRunnerMessage = await betaViewer.peer.waitForEvent(
      "agent.message",
      ({ text }) => text === "Beta runner event",
    );
    assert.equal(betaRunnerMessage.payload.agentId, "turbo");
    await delay(20);
    assert.ok(
      !eventInHistory(
        alice.peer,
        "agent.message",
        ({ text }) => text === "Beta runner event",
      ),
      "runner events must remain room scoped",
    );

    const finalLedgerEvent = [...alphaState.events]
      .reverse()
      .find(({ type }) => type === "ledger.updated");
    assert.ok(finalLedgerEvent);
    const aliceRow = finalLedgerEvent.payload.rows.find(
      ({ actorId }) => actorId === alice.welcome.actorId,
    );
    const bobRow = finalLedgerEvent.payload.rows.find(
      ({ actorId }) => actorId === bob.welcome.actorId,
    );
    assert.deepEqual(aliceRow, {
      actorId: alice.welcome.actorId,
      name: "Alice",
      steers: 2,
      tokens: 107,
      costUsd: 0.000321,
      outcomes: ["Reflex result", "Turbo result"],
    });
    assert.deepEqual(bobRow, {
      actorId: bob.welcome.actorId,
      name: "Bob",
      steers: 1,
      tokens: 40,
      costUsd: 0.00012,
      outcomes: ["Deep result"],
    });
    const betaState = app.ensembleState.rooms.get(beta.roomId);
    assert.ok(!betaState.ledger.has(alice.welcome.actorId));
    assert.ok(!alphaState.ledger.has(betaDriver.welcome.actorId));

    response = await runnerFetch(
      `/runner/next-task?roomId=${encodeURIComponent(alpha.roomId)}`,
    );
    assert.equal(response.status, 204);

    console.log("server V2 integration test passed");
  } finally {
    await Promise.allSettled(peers.map((peer) => peer.close()));
    await guardApp?.close().catch(() => {});
    await app?.close().catch(() => {});
    await closeHttpServer(interruptServer).catch(() => {});
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  }

  assert.equal(provisioner.closeCalls, 1);
  assert.equal(reflex.closeCalls, 1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
