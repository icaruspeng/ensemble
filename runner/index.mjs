import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_URL = (process.env.SERVER_URL ?? "http://127.0.0.1:8080").replace(
  /\/+$/,
  "",
);
const ENSEMBLE_KEY = process.env.ENSEMBLE_KEY ?? "";
const TARGET_DIR = process.env.TARGET_DIR ?? resolve(RUNNER_DIR, "../target-app");
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const INTERRUPT_PORT = 8091;
const POLL_INTERVAL_MS = 1_000;
const EVENT_BUFFER_MS = 500;
const MODEL = "gpt-5.3-codex-spark";
const COMPLETED_ITEM_TYPES = new Set([
  "agent_message",
  "reasoning",
  "file_change",
  "file_changes",
  "apply_patch",
  "patch_application",
  "patch_apply",
]);

let threadId;
let activeRun;
let stopping = false;

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function apiHeaders(hasJsonBody = false) {
  return {
    "x-ensemble-key": ENSEMBLE_KEY,
    ...(hasJsonBody ? { "content-type": "application/json" } : {}),
  };
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      ...apiHeaders(options.body !== undefined),
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });

  return response;
}

async function postJson(path, body) {
  const response = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
}

async function postWithoutBody(path) {
  const response = await apiFetch(path, { method: "POST" });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
}

class EventBuffer {
  #events = [];
  #flushPromise;
  #timer;

  constructor() {
    this.#timer = setInterval(() => {
      void this.flush().catch((error) => {
        console.error(`[runner] event flush failed: ${error.message}`);
      });
    }, EVENT_BUFFER_MS);
  }

  add(type, payload) {
    this.#events.push({ type, payload });
  }

  async flush() {
    if (this.#flushPromise) {
      await this.#flushPromise;
      if (this.#events.length > 0) {
        return this.flush();
      }
      return;
    }

    if (this.#events.length === 0) {
      return;
    }

    const batch = this.#events.splice(0, this.#events.length);
    this.#flushPromise = postJson("/runner/events", batch);

    try {
      await this.#flushPromise;
    } catch (error) {
      this.#events.unshift(...batch);
      throw error;
    } finally {
      this.#flushPromise = undefined;
    }
  }

  async drain() {
    while (this.#events.length > 0 || this.#flushPromise) {
      try {
        await this.flush();
      } catch {
        await sleep(EVENT_BUFFER_MS);
      }
    }
  }

  stop() {
    clearInterval(this.#timer);
  }
}

const eventBuffer = new EventBuffer();

function promptFor(task) {
  return `[Directed by ${task.authorName} in a live multiplayer session] ${task.text}. Keep changes small and immediately visible in the running app. Do not restart the dev server; it hot-reloads.`;
}

function codexArguments(prompt) {
  if (!threadId) {
    return [
      "exec",
      "--json",
      "-m",
      MODEL,
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      "-C",
      TARGET_DIR,
      prompt,
    ];
  }

  return [
    "exec",
    "resume",
    "--json",
    "-m",
    MODEL,
    "--skip-git-repo-check",
    threadId,
    prompt,
  ];
}

function bounded(value, maximum = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maximum) {
    return text;
  }
  return `${text.slice(0, maximum - 1)}…`;
}

function textFrom(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(textFrom).filter(Boolean).join("\n");
  }

  if (value && typeof value === "object") {
    for (const key of ["text", "message", "content", "summary"]) {
      const text = textFrom(value[key]);
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function itemText(item) {
  for (const key of ["text", "message", "summary", "content"]) {
    const text = textFrom(item?.[key]);
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeItemType(type) {
  return String(type ?? "unknown")
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");
}

function commandFrom(item) {
  const command = item?.command ?? item?.cmd ?? item?.input;
  if (Array.isArray(command)) {
    return command.map(String).join(" ");
  }
  if (typeof command === "string") {
    return command;
  }
  if (command && typeof command === "object") {
    return bounded(JSON.stringify(command), 500);
  }
  return "Unknown command";
}

function inferFileFromPatch(patch) {
  const match = String(patch ?? "").match(/^\+\+\+\s+(?:b\/)?(.+)$/m);
  return match?.[1] && match[1] !== "/dev/null" ? match[1].trim() : undefined;
}

function fallbackPatch(file, kind) {
  const description = bounded(kind || "changed", 80);
  return `--- ${file}\n+++ ${file}\n@@ file ${description} @@`;
}

function changesFrom(item) {
  const sharedPatch =
    item?.patch ?? item?.diff ?? item?.unified_diff ?? item?.unifiedDiff;
  const rawChanges = Array.isArray(item?.changes) ? item.changes : [item];

  return rawChanges.map((change) => {
    const patch =
      change?.patch ??
      change?.diff ??
      change?.unified_diff ??
      change?.unifiedDiff ??
      sharedPatch;
    const file =
      change?.file ??
      change?.path ??
      item?.file ??
      item?.path ??
      inferFileFromPatch(patch) ??
      "unknown";

    return {
      file: String(file),
      patch: String(patch ?? fallbackPatch(file, change?.kind ?? item?.kind)),
    };
  });
}

function numberFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function totalTokensFrom(usage = {}) {
  usage ??= {};
  const explicit = usage.total_tokens ?? usage.totalTokens;
  if (explicit !== undefined && Number.isFinite(Number(explicit))) {
    return numberFrom(explicit);
  }

  return (
    numberFrom(usage.input_tokens ?? usage.inputTokens) +
    numberFrom(usage.output_tokens ?? usage.outputTokens)
  );
}

function diffStatFor(run) {
  const count = run.changedFiles.size || run.diffCount;
  if (count === 0) {
    return "No files changed";
  }
  return `${count} file${count === 1 ? "" : "s"} changed`;
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/, 1)[0].trim() || "Task completed";
}

function unknownItemSummary(item, itemType) {
  const detail =
    itemText(item) || item?.status || item?.name || item?.title || item?.id;
  const label = itemType.replace(/_/g, " ");
  return bounded(detail ? `${label}: ${detail}` : `Codex reported ${label}`);
}

function itemLifecycleKey(item, itemType) {
  const identity =
    item?.id ??
    item?.item_id ??
    item?.name ??
    item?.path ??
    item?.file ??
    item?.command ??
    itemType;
  return `${itemType}:${bounded(identity, 500)}`;
}

function mapItem(run, item, stage = "completed") {
  const itemType = normalizeItemType(item?.type);
  const lifecycleKey = itemLifecycleKey(item, itemType);
  const completed = stage === "completed" || stage === "single";

  if (itemType === "command_execution" || itemType === "command") {
    const exitCode = item?.exit_code ?? item?.exitCode;
    const wasAnnounced = run.announcedCommands.has(lifecycleKey);

    if (!completed) {
      return;
    }

    if (!wasAnnounced || (exitCode !== undefined && exitCode !== null)) {
      const payload = { command: commandFrom(item) };
      if (exitCode !== undefined && exitCode !== null) {
        payload.exitCode = Number.isFinite(Number(exitCode))
          ? Number(exitCode)
          : exitCode;
      }
      eventBuffer.add("agent.command", payload);
    }
    run.announcedCommands.add(lifecycleKey);
    return;
  }

  if (!COMPLETED_ITEM_TYPES.has(itemType)) {
    if (!run.reportedUnknownItems.has(lifecycleKey)) {
      run.reportedUnknownItems.add(lifecycleKey);
      eventBuffer.add("agent.thought", {
        text: unknownItemSummary(item, itemType),
      });
    }
    return;
  }

  if (!completed) {
    return;
  }

  switch (itemType) {
    case "agent_message": {
      const text = itemText(item);
      if (text) {
        run.lastAgentMessage = text;
        eventBuffer.add("agent.message", { text });
      }
      break;
    }

    case "reasoning": {
      const text = itemText(item);
      if (text) {
        eventBuffer.add("agent.thought", { text });
      }
      break;
    }

    case "file_change":
    case "file_changes":
    case "apply_patch":
    case "patch_application":
    case "patch_apply": {
      for (const change of changesFrom(item)) {
        run.diffCount += 1;
        if (change.file !== "unknown") {
          run.changedFiles.add(change.file);
        }
        eventBuffer.add("agent.diff", change);
      }
      break;
    }

    default:
      break;
  }
}

function failureMessageFrom(event) {
  return bounded(
    textFrom(event?.error) ||
      textFrom(event?.message) ||
      textFrom(event?.details) ||
      event?.type,
    500,
  );
}

function handleCodexEvent(run, event) {
  if (!event || typeof event !== "object") {
    return;
  }

  if (event.type === "thread.started") {
    if (typeof event.thread_id === "string" && event.thread_id.length > 0) {
      threadId = event.thread_id;
    }
    return;
  }

  if (event.type === "turn.failed" || event.type === "error") {
    run.failureReason = failureMessageFrom(event);
    return;
  }

  if (event.type === "turn.completed") {
    if (run.interrupted || run.terminalSeen) {
      return;
    }

    run.terminalSeen = true;
    const tokens = totalTokensFrom(event.usage);
    const costUsd = tokens * 3e-6;
    const completion = { taskId: run.task.taskId, tokens, costUsd };

    eventBuffer.add("agent.turn_completed", completion);
    eventBuffer.add("crew.task_completed", completion);
    eventBuffer.add("crew.result_published", {
      taskId: run.task.taskId,
      summary: firstLine(run.lastAgentMessage),
      diffStat: diffStatFor(run),
    });
    return;
  }

  const itemStages = {
    "item.started": "started",
    "item.updated": "updated",
    "item.completed": "completed",
    item: "single",
  };
  const itemStage = event.type ? itemStages[event.type] : "single";

  if (itemStage && event.item) {
    mapItem(run, event.item, itemStage);
  }
}

function taskFailureReason(run, result) {
  if (run.failureReason) {
    return run.failureReason;
  }
  if (result.error) {
    return bounded(result.error.message, 500);
  }
  if (run.stderr.trim()) {
    return bounded(run.stderr, 500);
  }
  if (result.signal) {
    return `Codex stopped with signal ${result.signal}`;
  }
  return `Codex exited with code ${result.code ?? "unknown"}`;
}

async function runTask(task) {
  const run = {
    task,
    child: undefined,
    interrupted: false,
    interruptReported: false,
    terminalSeen: false,
    failureReason: "",
    stderr: "",
    lastAgentMessage: "",
    changedFiles: new Set(),
    diffCount: 0,
    announcedCommands: new Set(),
    reportedUnknownItems: new Set(),
  };
  activeRun = run;

  const prompt = promptFor(task);
  const child = spawn(CODEX_BIN, codexArguments(prompt), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  run.child = child;

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const linesClosed = new Promise((resolveLines) => lines.once("close", resolveLines));

  lines.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    try {
      handleCodexEvent(run, JSON.parse(line));
    } catch (error) {
      console.error(`[runner] ignored malformed Codex JSONL: ${error.message}`);
    }
  });

  child.stderr.on("data", (chunk) => {
    run.stderr = `${run.stderr}${chunk}`.slice(-4_000);
  });

  const result = await new Promise((resolveResult) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolveResult(value);
      }
    };

    child.once("error", (error) => settle({ error }));
    child.once("close", (code, signal) => settle({ code, signal }));
  });

  await linesClosed;

  if (!run.interrupted && !run.terminalSeen) {
    eventBuffer.add("crew.task_failed", {
      taskId: task.taskId,
      reason: taskFailureReason(run, result),
    });
  }

  await eventBuffer.drain();
  if (activeRun === run) {
    activeRun = undefined;
  }
}

async function nextTask() {
  const response = await apiFetch("/runner/next-task");
  if (response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`/runner/next-task returned HTTP ${response.status}`);
  }

  const task = await response.json();
  if (
    !task ||
    typeof task.taskId !== "string" ||
    typeof task.text !== "string" ||
    typeof task.authorName !== "string"
  ) {
    throw new Error("/runner/next-task returned an invalid task");
  }
  return task;
}

async function poll() {
  while (!stopping) {
    try {
      const task = await nextTask();
      if (task) {
        await runTask(task);
      }
    } catch (error) {
      if (!stopping) {
        console.error(`[runner] poll failed: ${error.message}`);
      }
    }

    if (!stopping) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function reportInterrupted(run) {
  if (run.interruptReported) {
    return true;
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await postWithoutBody("/runner/interrupted");
      run.interruptReported = true;
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(200);
      }
    }
  }
  run.interruptReportError = lastError;
  return false;
}

async function keepReportingInterrupted(run) {
  while (!stopping && !run.interruptReported) {
    await sleep(1_000);
    await reportInterrupted(run);
  }
}

const interruptServer = createServer(async (request, response) => {
  request.resume();

  if (
    request.method !== "POST" ||
    !["/interrupt", "/runner/interrupt"].includes(request.url)
  ) {
    response.writeHead(404).end();
    return;
  }

  const run = activeRun;
  if (
    !run?.child ||
    run.child.exitCode !== null ||
    run.child.signalCode !== null ||
    run.terminalSeen ||
    run.interrupted
  ) {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ interrupted: false }));
    return;
  }

  run.interrupted = true;
  let signalAccepted = false;
  try {
    signalAccepted = run.child.kill("SIGKILL");
  } catch {
    signalAccepted = false;
  }

  if (!signalAccepted) {
    run.interrupted = false;
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ interrupted: false }));
    return;
  }

  const reported = await reportInterrupted(run);
  if (reported) {
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ interrupted: true }));
  } else {
    console.error(
      `[runner] interrupt report failed: ${run.interruptReportError?.message}`,
    );
    void keepReportingInterrupted(run);
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ interrupted: true, reported: false }));
  }
});

interruptServer.on("error", (error) => {
  console.error(`[runner] interrupt server failed: ${error.message}`);
  stopping = true;
  eventBuffer.stop();
  if (activeRun?.child && activeRun.child.exitCode === null) {
    activeRun.interrupted = true;
    activeRun.child.kill("SIGKILL");
  }
  process.exit(1);
});

interruptServer.listen(INTERRUPT_PORT, "0.0.0.0", () => {
  console.log(`[runner] interrupt endpoint listening on :${INTERRUPT_PORT}`);
  void poll();
});

async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  eventBuffer.stop();

  const child = activeRun?.child;
  if (child && child.exitCode === null) {
    activeRun.interrupted = true;
    child.kill("SIGKILL");
  }

  interruptServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
