import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const ENSEMBLE_KEY = "test-ensemble-key";
const THREAD_ID = "thread_recorded_123";

const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function waitFor(description, condition, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolveExit();
    });
  });
}

function parseCalls(log) {
  return log
    .split("CALL\n")
    .slice(1)
    .map((block) => {
      const lines = block.split("\n");
      return {
        args: lines
          .filter((line) => line.startsWith("ARG\t"))
          .map((line) => line.slice(4)),
        stdinClosed: lines.includes("STDIN\tclosed"),
      };
    });
}

function expectedPrompt(authorName, text) {
  return `[Directed by ${authorName} in a live multiplayer session] ${text}. Keep changes small and immediately visible in the running app. Do not restart the dev server; it hot-reloads.`;
}

test("picks up tasks, maps JSONL, resumes the captured thread, and interrupts", async () => {
  const testDirectory = await mkdtemp(join(RUNNER_DIR, ".test-"));
  const fakeCodex = join(testDirectory, "fake-codex.sh");
  const invocationLog = join(testDirectory, "invocations.log");
  const targetDirectory = join(testDirectory, "target app");
  await mkdir(targetDirectory);
  await writeFile(invocationLog, "");

  const fakeScript = String.raw`#!/bin/sh
set -eu

{
  printf '%s\n' 'CALL'
  for arg in "$@"; do
    printf 'ARG\t%s\n' "$arg"
  done
  if IFS= read -r ignored; then
    printf 'STDIN\topen\n'
  else
    printf 'STDIN\tclosed\n'
  fi
} >> "$FAKE_CODEX_LOG"

last=''
for arg in "$@"; do
  last=$arg
done

case "$last" in
  *"Paint the room"*)
    printf '%s\n' '{"type":"thread.started","thread_id":"thread_recorded_123"}'
    printf '%s\r\n' '{"type":"turn.started"}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"reason-1","type":"reasoning","summary":[{"text":"Planning carefully"}]}}'
    printf '%s\n' '{"type":"item.started","item":{"id":"command-1","type":"command_execution","command":"npm run build","exit_code":null,"status":"in_progress"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"command-1","type":"command_execution","command":"npm run build","exit_code":0,"status":"completed"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"command-1b","type":"command_execution","command":"false-step","exit_code":1,"status":"failed"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"diff-1","type":"file_change","changes":[{"path":"src/App.jsx","kind":"update","diff":"--- a/src/App.jsx\n+++ b/src/App.jsx"}],"status":"completed"}}'
    printf '%s' '{"type":"item.completed","item":{"id":"reason-2","type":"reasoning",'
    /bin/sleep 0.05
    printf '%s\n' '"text":"Split across writes"}}'
    printf '%s\n' '{this is deliberately malformed JSONL}'
    printf '%s\n' '{"type":"item.started","item":{"id":"unknown-1","type":"web_search","status":"in_progress"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"unknown-1","type":"web_search","text":"Looked up a compact palette"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"First result\nMore detail"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":90,"output_tokens":20,"reasoning_output_tokens":7}}'
    ;;
  *"Add votes"*)
    printf '%s\n' '{"type":"thread.started","thread_id":"thread_recorded_123"}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"patch-2","type":"patch_application","file":"src/styles.css","patch":"--- a/src/styles.css\n+++ b/src/styles.css"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"message-2","type":"agent_message","text":"Votes are ready\nAdded buttons"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"total_tokens":7,"input_tokens":100,"output_tokens":100}}'
    ;;
  *"Keep running until interrupted"*)
    printf '%s\n' '{"type":"thread.started","thread_id":"thread_recorded_123"}'
    printf '%s\n' '{"type":"item.started","item":{"id":"command-3","type":"command_execution","command":"long-running fake command","status":"in_progress"}}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"reasoning-3","type":"reasoning","text":"mid-run marker before hang"}}'
    trap '' HUP INT TERM
    exec /bin/sleep 30
    ;;
  *"Finish and linger"*)
    printf '%s\n' '{"type":"thread.started","thread_id":"thread_recorded_123"}'
    printf '%s\n' '{"type":"item.completed","item":{"id":"message-4","type":"agent_message","text":"Already finished"}}'
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}'
    trap '' HUP INT TERM
    exec /bin/sleep 2
    ;;
  *)
    printf '%s\n' 'unexpected prompt' >&2
    exit 2
    ;;
esac
`;

  await writeFile(fakeCodex, fakeScript, { mode: 0o755 });
  await chmod(fakeCodex, 0o755);

  const tasks = [
    { taskId: "task-1", text: "Paint the room", authorName: "Sam" },
    { taskId: "task-2", text: "Add votes", authorName: "Mina" },
    {
      taskId: "task-3",
      text: "Keep running until interrupted",
      authorName: "Lee",
    },
    {
      taskId: "task-4",
      text: "Finish and linger",
      authorName: "Ari",
    },
  ];
  const state = {
    nextTaskRequests: 0,
    eventBatches: [],
    interruptedReports: 0,
    invalidKeys: [],
  };

  const stubServer = createServer((request, response) => {
    void (async () => {
      if (request.headers["x-ensemble-key"] !== ENSEMBLE_KEY) {
        state.invalidKeys.push({ method: request.method, url: request.url });
      }

      if (request.method === "GET" && request.url === "/runner/next-task") {
        state.nextTaskRequests += 1;
        const task = tasks.shift();
        if (!task) {
          response.writeHead(204).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(task));
        return;
      }

      if (request.method === "POST" && request.url === "/runner/events") {
        const body = JSON.parse(await requestBody(request));
        state.eventBatches.push(body);
        response.writeHead(204).end();
        return;
      }

      if (request.method === "POST" && request.url === "/runner/interrupted") {
        await requestBody(request);
        state.interruptedReports += 1;
        response.writeHead(204).end();
        return;
      }

      response.writeHead(404).end();
    })().catch((error) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error.stack);
    });
  });

  await new Promise((resolveListen) =>
    stubServer.listen(0, "127.0.0.1", resolveListen),
  );
  const stubAddress = stubServer.address();
  assert(stubAddress && typeof stubAddress === "object");

  let runnerOutput = "";
  const runner = spawn(process.execPath, [join(RUNNER_DIR, "index.mjs")], {
    cwd: RUNNER_DIR,
    env: {
      ...process.env,
      SERVER_URL: `http://127.0.0.1:${stubAddress.port}`,
      ENSEMBLE_KEY,
      TARGET_DIR: targetDirectory,
      CODEX_BIN: fakeCodex,
      FAKE_CODEX_LOG: invocationLog,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  runner.stdout.on("data", (chunk) => {
    runnerOutput += chunk;
  });
  runner.stderr.on("data", (chunk) => {
    runnerOutput += chunk;
  });

  try {
    await waitFor("runner interrupt server", () =>
      runnerOutput.includes("interrupt endpoint listening on :8091"),
    );

    await waitFor("two completed tasks and the third Codex invocation", async () => {
      const events = state.eventBatches.flat();
      const completed = events.filter(
        (event) => event.type === "agent.turn_completed",
      );
      const calls = parseCalls(await readFile(invocationLog, "utf8"));
      return completed.length === 2 && calls.length === 3;
    });

    const calls = parseCalls(await readFile(invocationLog, "utf8"));
    assert.equal(calls.length, 3);
    assert(calls.every((call) => call.stdinClosed), "Codex stdin must be EOF");

    assert.deepEqual(calls[0].args, [
      "exec",
      "--json",
      "-m",
      "gpt-5.3-codex-spark",
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      "-C",
      targetDirectory,
      expectedPrompt("Sam", "Paint the room"),
    ]);
    assert.deepEqual(calls[1].args, [
      "exec",
      "resume",
      "--json",
      "-m",
      "gpt-5.3-codex-spark",
      "--skip-git-repo-check",
      THREAD_ID,
      expectedPrompt("Mina", "Add votes"),
    ]);
    assert.deepEqual(calls[2].args, [
      "exec",
      "resume",
      "--json",
      "-m",
      "gpt-5.3-codex-spark",
      "--skip-git-repo-check",
      THREAD_ID,
      expectedPrompt("Lee", "Keep running until interrupted"),
    ]);
    assert(!calls[1].args.includes("--last"));
    assert(!calls[1].args.includes("--sandbox"));
    assert(!calls[1].args.includes("-C"));

    await waitFor("buffered event from the still-running fake", () =>
      state.eventBatches
        .flat()
        .some(
          (event) =>
            event.type === "agent.thought" &&
            event.payload.text === "mid-run marker before hang",
        ),
    );

    const interruptResponse = await fetch("http://127.0.0.1:8091/interrupt", {
      method: "POST",
    });
    assert.equal(interruptResponse.status, 202);
    assert.deepEqual(await interruptResponse.json(), { interrupted: true });

    await waitFor(
      "interrupted report and polling after SIGKILL",
      () => state.interruptedReports === 1 && state.nextTaskRequests >= 4,
      5_000,
    );
    await waitFor("completed turn held open before process close", () =>
      state.eventBatches
        .flat()
        .some(
          (event) =>
            event.type === "agent.turn_completed" &&
            event.payload.taskId === "task-4",
        ),
    );

    const completedInterruptResponse = await fetch(
      "http://127.0.0.1:8091/runner/interrupt",
      { method: "POST" },
    );
    assert.equal(completedInterruptResponse.status, 409);
    assert.deepEqual(await completedInterruptResponse.json(), {
      interrupted: false,
    });
    await wait(100);
    assert.equal(
      state.interruptedReports,
      1,
      "A completed turn must not be reported as interrupted",
    );

    const callsAfterInterrupt = parseCalls(
      await readFile(invocationLog, "utf8"),
    );
    assert.equal(callsAfterInterrupt.length, 4);
    assert(callsAfterInterrupt[3].stdinClosed);
    assert.deepEqual(callsAfterInterrupt[3].args, [
      "exec",
      "resume",
      "--json",
      "-m",
      "gpt-5.3-codex-spark",
      "--skip-git-repo-check",
      THREAD_ID,
      expectedPrompt("Ari", "Finish and linger"),
    ]);

    const events = state.eventBatches.flat();
    assert(state.eventBatches.every(Array.isArray));
    assert(
      events.every(
        (event) =>
          Object.keys(event).sort().join(",") === "payload,type" &&
          typeof event.payload === "object",
      ),
      "Runner event posts must contain only type and payload",
    );

    assert.equal(
      events.filter((event) => event.type === "agent.turn_started").length,
      0,
      "Codex turn.started must not duplicate the server event",
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent.thought" &&
          event.payload.text === "Planning carefully",
      ),
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent.thought" &&
          event.payload.text === "Split across writes",
      ),
    );
    const unknownThought = events.find(
      (event) =>
        event.type === "agent.thought" &&
        event.payload.text.includes("web search"),
    );
    assert(unknownThought);
    assert(unknownThought.payload.text.length <= 240);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "agent.thought" &&
          event.payload.text.includes("web search"),
      ).length,
      1,
      "Unknown item lifecycle events should produce one short summary",
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent.command" &&
          event.payload.command === "npm run build" &&
          !("exitCode" in event.payload),
      ),
      "item.started must announce a command before it exits",
    );
    assert(
      !events.some(
        (event) =>
          event.type === "agent.command" &&
          event.payload.command === "npm run build" &&
          event.payload.exitCode === 0,
      ),
      "successful completion of an announced command must not re-emit",
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent.command" &&
          event.payload.command === "false-step" &&
          event.payload.exitCode === 1,
      ),
      "failed commands must surface with their exit code",
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent.diff" &&
          event.payload.file === "src/App.jsx" &&
          event.payload.patch.includes("+++ b/src/App.jsx"),
      ),
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent.diff" &&
          event.payload.file === "src/styles.css" &&
          event.payload.patch.includes("+++ b/src/styles.css"),
      ),
    );
    assert(
      events.some(
        (event) =>
          event.type === "agent.message" &&
          event.payload.text === "First result\nMore detail",
      ),
    );

    const firstCompletion = events.find(
      (event) =>
        event.type === "agent.turn_completed" &&
        event.payload.taskId === "task-1",
    );
    assert.deepEqual(firstCompletion?.payload, {
      taskId: "task-1",
      tokens: 120,
      costUsd: 120 * 3e-6,
    });
    const secondCompletion = events.find(
      (event) =>
        event.type === "agent.turn_completed" &&
        event.payload.taskId === "task-2",
    );
    assert.deepEqual(secondCompletion?.payload, {
      taskId: "task-2",
      tokens: 7,
      costUsd: 7 * 3e-6,
    });

    const firstTaskCompleted = events.find(
      (event) =>
        event.type === "crew.task_completed" &&
        event.payload.taskId === "task-1",
    );
    assert.deepEqual(firstTaskCompleted?.payload, firstCompletion.payload);
    assert(
      events.some(
        (event) =>
          event.type === "crew.result_published" &&
          event.payload.taskId === "task-1" &&
          event.payload.summary === "First result" &&
          event.payload.diffStat === "1 file changed",
      ),
    );
    assert(
      events.some(
        (event) =>
          event.type === "crew.result_published" &&
          event.payload.taskId === "task-2" &&
          event.payload.summary === "Votes are ready" &&
          event.payload.diffStat === "1 file changed",
      ),
    );

    assert.equal(
      events.some(
        (event) =>
          [
            "agent.turn_completed",
            "crew.task_completed",
            "crew.task_failed",
            "crew.result_published",
          ].includes(event.type) && event.payload.taskId === "task-3",
      ),
      false,
      "Interrupted tasks must not emit terminal task events",
    );
    assert.equal(state.interruptedReports, 1);
    assert.deepEqual(state.invalidKeys, []);
    assert.match(runnerOutput, /ignored malformed Codex JSONL/);
  } finally {
    await stopProcess(runner);
    await closeServer(stubServer);
    await rm(testDirectory, { recursive: true, force: true });
  }
});
