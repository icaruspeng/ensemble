import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 8089;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const ENSEMBLE_KEY = "ensemble-test-key";
const REQUEST_TIMEOUT_MS = 5_000;

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

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) =>
      this.socket.addEventListener("close", resolve, { once: true }),
    );
    this.socket.close();
    await Promise.race([closed, delay(1_000)]);
  }
}

async function connect(name) {
  const socket = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening WebSocket for ${name}`));
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
        reject(new Error(`WebSocket connection failed for ${name}`));
      },
      { once: true },
    );
  });
  const peer = new WsPeer(socket);
  peer.send({ type: "join", name });
  const welcome = await peer.waitFor(
    (message) => message.type === "welcome",
    `${name} welcome`,
  );
  assert.equal(peer.history[0], welcome, `${name}'s first message must be welcome`);
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
  assert.ok(events.length > 0, "replay should not be empty");
  const ids = new Set();
  let previousSeq = 0;
  for (const event of events) {
    assertEnvelope(event);
    assert.ok(event.seq > previousSeq, "replay seq values must increase");
    assert.ok(!ids.has(event.id), "replay event ids must be unique");
    ids.add(event.id);
    previousSeq = event.seq;
  }
}

function timedFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function runnerFetch(path, init = {}) {
  return timedFetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "x-ensemble-key": ENSEMBLE_KEY,
      ...(init.headers ?? {}),
    },
  });
}

async function waitForHealth(child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited during startup\n${output()}`);
    }
    try {
      const response = await timedFetch(`${BASE_URL}/healthz`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        assert.deepEqual(await response.json(), { ok: true });
        return;
      }
    } catch {
      // The listener is not ready yet.
    }
    await delay(50);
  }
  throw new Error(`Server did not become healthy\n${output()}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once("exit", resolve));
}

async function postTaskResult(peer, task, { tokens, costUsd, summary }) {
  const spoofActor = { id: "spoof", name: "Spoof", kind: "human" };
  const events = [
    {
      id: "evt_spoofed",
      ts: 1,
      seq: -1,
      actor: spoofActor,
      type: "agent.message",
      payload: { text: `Finished ${task.text}` },
    },
    {
      id: "evt_spoofed_2",
      ts: 2,
      seq: -2,
      actor: spoofActor,
      type: "agent.turn_completed",
      payload: { taskId: task.taskId, tokens, costUsd },
    },
    {
      id: "evt_spoofed_3",
      ts: 3,
      seq: -3,
      actor: spoofActor,
      type: "crew.result_published",
      payload: { taskId: task.taskId, summary, diffStat: "1 file changed" },
    },
    {
      id: "evt_spoofed_4",
      ts: 4,
      seq: -4,
      actor: spoofActor,
      type: "crew.task_completed",
      payload: { taskId: task.taskId, tokens, costUsd },
    },
  ];

  const response = await runnerFetch("/runner/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(events),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const messageEvent = await peer.waitForEvent(
    "agent.message",
    (payload) => payload.text === `Finished ${task.text}`,
  );
  const completed = await peer.waitForEvent(
    "agent.turn_completed",
    (payload) => payload.taskId === task.taskId,
  );
  const result = await peer.waitForEvent(
    "crew.result_published",
    (payload) => payload.taskId === task.taskId,
  );
  const taskCompleted = await peer.waitForEvent(
    "crew.task_completed",
    (payload) => payload.taskId === task.taskId,
  );
  const ingested = [messageEvent, completed, result, taskCompleted];
  for (let index = 0; index < ingested.length; index += 1) {
    const event = ingested[index];
    assertEnvelope(event);
    assert.notEqual(event.id, events[index].id);
    assert.notEqual(event.ts, events[index].ts);
    assert.ok(event.seq > 0);
    assert.deepEqual(event.actor, {
      id: "act_codex",
      name: "Codex",
      kind: "agent",
    });
  }
  assert.ok(messageEvent.seq < completed.seq);
  assert.ok(completed.seq < result.seq);
  assert.ok(result.seq < taskCompleted.seq);
}

async function main() {
  let serverOutput = "";
  let child;
  let runnerMock;
  let alice;
  let bob;
  const interrupts = [];
  const interruptWaiters = [];

  try {
    runnerMock = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/runner/interrupt") {
        const call = {
          method: request.method,
          key: request.headers["x-ensemble-key"],
        };
        interrupts.push(call);
        interruptWaiters.splice(0).forEach((resolve) => resolve(call));
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
      runnerMock.once("error", reject);
      runnerMock.listen(0, "127.0.0.1", resolve);
    });
    const runnerPort = runnerMock.address().port;

    child = spawn(process.execPath, ["index.js"], {
      cwd: new URL(".", import.meta.url),
      env: {
        ...process.env,
        PORT: String(PORT),
        ENSEMBLE_KEY,
        RUNNER_URL: `http://127.0.0.1:${runnerPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      serverOutput += chunk;
    });
    child.stderr.on("data", (chunk) => {
      serverOutput += chunk;
    });

    await waitForHealth(child, () => serverOutput);

    const root = await timedFetch(`${BASE_URL}/`);
    assert.ok(
      root.status === 200 || root.status === 503,
      "root should serve web/dist or report that it has not been built",
    );

    assert.equal((await timedFetch(`${BASE_URL}/runner/next-task`)).status, 401);
    assert.equal(
      (
        await timedFetch(`${BASE_URL}/runner/next-task`, {
          headers: { "x-ensemble-key": "wrong" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await timedFetch(`${BASE_URL}/runner/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not valid json",
        })
      ).status,
      401,
      "runner event auth must run before body parsing",
    );
    assert.equal(
      (
        await timedFetch(`${BASE_URL}/runner/interrupted`, {
          method: "POST",
        })
      ).status,
      401,
    );

    alice = await connect("Alice");
    assert.ok(alice.welcome.actorId.startsWith("act_"));
    assert.equal(alice.welcome.driverActorId, alice.welcome.actorId);
    assertOrderedReplay(alice.welcome.events);
    assert.ok(
      alice.welcome.events.some(
        (event) =>
          event.type === "actor.joined" && event.actor.id === alice.welcome.actorId,
      ),
    );

    alice.peer.send({ type: "steer", text: "Add yellow notes" });
    const alicePostOne = await alice.peer.waitForEvent(
      "crew.actor_post",
      (payload) => payload.text === "Add yellow notes",
    );
    const aliceDispatchOne = await alice.peer.waitForEvent(
      "crew.task_dispatched",
      (payload) => payload.text === "Add yellow notes",
    );
    assert.ok(alicePostOne.seq < aliceDispatchOne.seq);
    assert.equal(alicePostOne.actor.id, alice.welcome.actorId);
    assert.equal(aliceDispatchOne.payload.byActorId, alice.welcome.actorId);

    alice.peer.send({ type: "steer", text: "Add vote buttons" });
    const alicePostTwo = await alice.peer.waitForEvent(
      "crew.actor_post",
      (payload) => payload.text === "Add vote buttons",
    );
    const aliceDispatchTwo = await alice.peer.waitForEvent(
      "crew.task_dispatched",
      (payload) => payload.text === "Add vote buttons",
    );
    assert.ok(alicePostTwo.seq < aliceDispatchTwo.seq);
    assert.notEqual(
      aliceDispatchOne.payload.taskId,
      aliceDispatchTwo.payload.taskId,
    );

    bob = await connect("Bob");
    assert.ok(bob.welcome.actorId.startsWith("act_"));
    assert.notEqual(bob.welcome.actorId, alice.welcome.actorId);
    assert.equal(bob.welcome.driverActorId, alice.welcome.actorId);
    assertOrderedReplay(bob.welcome.events);
    assert.ok(
      bob.welcome.events.some(
        (event) => event.id === aliceDispatchOne.id,
      ),
      "Bob's replay should include events from before he joined",
    );
    assert.ok(
      bob.welcome.events.some(
        (event) =>
          event.type === "actor.joined" && event.actor.id === bob.welcome.actorId,
      ),
      "Bob's own presence event should be in his replay",
    );

    let response = await runnerFetch("/runner/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ type: "agent.command", payload: {} }]),
    });
    assert.equal(response.status, 400, "malformed event payloads must be rejected");
    assert.ok(
      !bob.peer.history.some(
        (message) =>
          message.type === "event" && message.event.type === "agent.command",
      ),
      "runner event batches must be validated before any event is appended",
    );

    bob.peer.send({
      type: "comment",
      anchor: { eventId: aliceDispatchOne.id },
      text: "Make this sunny",
    });
    const comment = await bob.peer.waitForEvent(
      "comment.created",
      (payload) => payload.text === "Make this sunny",
    );
    assert.equal(comment.actor.id, bob.welcome.actorId);
    assert.match(comment.payload.commentId, /^comment_[a-f0-9]+$/);
    assert.deepEqual(comment.payload.anchor, { eventId: aliceDispatchOne.id });

    bob.peer.send({ type: "steer", text: "Add blue notes" });
    const bobPost = await bob.peer.waitForEvent(
      "crew.actor_post",
      (payload) => payload.text === "Add blue notes",
    );
    const gate = await bob.peer.waitForEvent(
      "crew.gate_requested",
      (payload) => payload.taskId && payload.question.includes("Add blue notes"),
    );
    assert.ok(bobPost.seq < gate.seq);
    assert.equal(gate.actor.id, bob.welcome.actorId);
    assert.match(gate.payload.gateId, /^gate_[a-f0-9]+$/);
    assert.match(gate.payload.taskId, /^task_[a-f0-9]+$/);
    assert.ok(gate.payload.question.startsWith("Bob wants:"));
    assert.ok(gate.payload.question.endsWith("dispatch?"));

    await bob.peer.waitForEvent("ledger.updated", (payload) => {
      const row = payload.rows.find(({ actorId }) => actorId === bob.welcome.actorId);
      return row?.steers === 1;
    });
    assert.ok(
      !bob.peer.history.some(
        (message) =>
          message.type === "event" &&
          message.event.type === "crew.task_dispatched" &&
          message.event.payload.taskId === gate.payload.taskId,
      ),
      "non-driver task must remain gated until approval",
    );

    bob.peer.send({
      type: "resolveGate",
      gateId: gate.payload.gateId,
      approved: true,
    });
    const unauthorizedResolution = await bob.peer.waitFor(
      (message) =>
        message.type === "error" && message.message.includes("resolve a gate"),
      "non-driver gate rejection",
    );
    assert.equal(unauthorizedResolution.type, "error");
    assert.ok(
      !bob.peer.history.some(
        (message) =>
          message.type === "event" &&
          message.event.type === "crew.gate_resolved" &&
          message.event.payload.gateId === gate.payload.gateId,
      ),
      "a non-driver cannot resolve a gate",
    );

    alice.peer.send({
      type: "resolveGate",
      gateId: gate.payload.gateId,
      approved: true,
    });
    const resolved = await bob.peer.waitForEvent(
      "crew.gate_resolved",
      (payload) => payload.gateId === gate.payload.gateId,
    );
    assert.deepEqual(resolved.payload, {
      gateId: gate.payload.gateId,
      approved: true,
      byActorId: alice.welcome.actorId,
    });
    const bobDispatch = await bob.peer.waitForEvent(
      "crew.task_dispatched",
      (payload) => payload.taskId === gate.payload.taskId,
    );
    assert.equal(bobDispatch.payload.text, "Add blue notes");
    assert.equal(
      bobDispatch.payload.byActorId,
      bob.welcome.actorId,
      "approved task must retain the original author's attribution",
    );
    assert.equal(bobDispatch.actor.id, bob.welcome.actorId);
    assert.ok(resolved.seq < bobDispatch.seq);
    assert.equal(
      bob.peer.history.filter(
        (message) =>
          message.type === "event" &&
          message.event.type === "crew.task_dispatched" &&
          message.event.payload.taskId === gate.payload.taskId,
      ).length,
      1,
      "approval should dispatch the proposed task exactly once",
    );

    bob.peer.send({ type: "handoff", toActorId: bob.welcome.actorId });
    await bob.peer.waitFor(
      (message) =>
        message.type === "error" && message.message.includes("hand off"),
      "non-driver handoff rejection",
    );
    bob.peer.send({ type: "interrupt" });
    await bob.peer.waitFor(
      (message) =>
        message.type === "error" && message.message.includes("interrupt"),
      "non-driver interrupt rejection",
    );
    assert.equal(interrupts.length, 0);

    alice.peer.send({ type: "handoff", toActorId: bob.welcome.actorId });
    const handoff = await bob.peer.waitForEvent(
      "driver.changed",
      (payload) => payload.toActorId === bob.welcome.actorId,
    );
    assert.equal(handoff.actor.id, alice.welcome.actorId);

    const interruptReceived =
      interrupts.length > 0
        ? Promise.resolve(interrupts[0])
        : new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Timed out waiting for runner interrupt")),
              REQUEST_TIMEOUT_MS,
            );
            interruptWaiters.push((call) => {
              clearTimeout(timer);
              resolve(call);
            });
          });
    bob.peer.send({ type: "interrupt" });
    assert.deepEqual(await interruptReceived, {
      method: "POST",
      key: ENSEMBLE_KEY,
    });

    response = await runnerFetch("/runner/next-task");
    assert.equal(response.status, 200);
    const firstTask = await response.json();
    assert.deepEqual(firstTask, {
      taskId: aliceDispatchOne.payload.taskId,
      text: "Add yellow notes",
      authorName: "Alice",
    });
    const firstTurnStarted = await bob.peer.waitForEvent(
      "agent.turn_started",
      (payload) => payload.taskId === firstTask.taskId,
    );
    assert.equal(firstTurnStarted.actor.kind, "agent");

    response = await runnerFetch("/runner/next-task");
    assert.equal(response.status, 204, "only one task may be current");

    response = await runnerFetch("/runner/interrupted", { method: "POST" });
    assert.equal(response.status, 204);
    response = await runnerFetch("/runner/next-task");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), firstTask);
    const restartedTurn = await bob.peer.waitForEvent(
      "agent.turn_started",
      (payload) => payload.taskId === firstTask.taskId,
    );
    assert.equal(restartedTurn.actor.kind, "agent");

    await postTaskResult(bob.peer, firstTask, {
      tokens: 100,
      costUsd: 0.0003,
      summary: "Yellow notes shipped",
    });

    response = await runnerFetch("/runner/next-task");
    assert.equal(response.status, 200);
    const secondTask = await response.json();
    assert.deepEqual(secondTask, {
      taskId: aliceDispatchTwo.payload.taskId,
      text: "Add vote buttons",
      authorName: "Alice",
    });
    await postTaskResult(bob.peer, secondTask, {
      tokens: 60,
      costUsd: 0.00018,
      summary: "Voting shipped",
    });

    response = await runnerFetch("/runner/next-task");
    assert.equal(response.status, 200);
    const thirdTask = await response.json();
    assert.deepEqual(thirdTask, {
      taskId: bobDispatch.payload.taskId,
      text: "Add blue notes",
      authorName: "Bob",
    });
    await postTaskResult(bob.peer, thirdTask, {
      tokens: 40,
      costUsd: 0.00012,
      summary: "Blue notes shipped",
    });

    response = await runnerFetch("/runner/next-task");
    assert.equal(response.status, 204, "FIFO queue should now be empty");

    const finalLedger = await bob.peer.waitForEvent("ledger.updated", (payload) => {
      const aliceRow = payload.rows.find(
        ({ actorId }) => actorId === alice.welcome.actorId,
      );
      const bobRow = payload.rows.find(
        ({ actorId }) => actorId === bob.welcome.actorId,
      );
      return (
        aliceRow?.tokens === 160 &&
        bobRow?.tokens === 40 &&
        bobRow.outcomes.includes("Blue notes shipped")
      );
    });
    const aliceRow = finalLedger.payload.rows.find(
      ({ actorId }) => actorId === alice.welcome.actorId,
    );
    const bobRow = finalLedger.payload.rows.find(
      ({ actorId }) => actorId === bob.welcome.actorId,
    );
    assert.equal(aliceRow.name, "Alice");
    assert.equal(aliceRow.steers, 2);
    assert.equal(aliceRow.tokens, 160);
    assert.ok(Math.abs(aliceRow.costUsd - 0.00048) < 1e-12);
    assert.deepEqual(aliceRow.outcomes, [
      "Yellow notes shipped",
      "Voting shipped",
    ]);
    assert.equal(bobRow.name, "Bob");
    assert.equal(bobRow.steers, 1);
    assert.equal(bobRow.tokens, 40);
    assert.ok(Math.abs(bobRow.costUsd - 0.00012) < 1e-12);
    assert.deepEqual(bobRow.outcomes, ["Blue notes shipped"]);

    let liveSeq = bob.welcome.events.at(-1)?.seq ?? 0;
    for (const message of bob.peer.history) {
      if (message.type !== "event") continue;
      assert.ok(message.event.seq > liveSeq, "live seq values must keep increasing");
      liveSeq = message.event.seq;
    }

    const bobActorId = bob.welcome.actorId;
    const bobLeft = alice.peer.waitForEvent(
      "actor.left",
      (_payload, event) => event.actor.id === bobActorId,
    );
    await bob.peer.close();
    bob = null;
    const leftEvent = await bobLeft;
    assert.deepEqual(leftEvent.payload, {});

    console.log("server integration test passed");
  } finally {
    await bob?.peer.close().catch(() => {});
    await alice?.peer.close().catch(() => {});
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (child) await Promise.race([waitForExit(child), delay(2_000)]);
    if (runnerMock) {
      await new Promise((resolve) => runnerMock.close(resolve));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
