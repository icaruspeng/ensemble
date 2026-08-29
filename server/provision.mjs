import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_API_BASE_URL = "https://api.runloop.ai/v1";
const DEFAULT_MAX_LIVE_WORKSPACES = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 40_000;
const DEFAULT_HEALTH_ATTEMPTS = 30;
const DEFAULT_SUSPEND_WAIT_ATTEMPTS = 1;
const DEFAULT_CLOSE_SUSPEND_TIMEOUT_MS = 5_000;
const DEVBOX_WAIT_SECONDS = 30;
const EXECUTION_WAIT_SECONDS = 25;
const POLL_RETRY_DELAY_MS = 250;

const APP_DIR = "/home/user/app";
const AUTH_DIR = "/home/user/.codex";
const AUTH_FILE = ".codex/auth.json";
const BUNDLE_FILE = `${APP_DIR}/workspace-bundle.tgz`;
const TEMPLATE_TARGET_DIR = `${APP_DIR}/target-app`;
const REPOSITORY_TARGET_DIR = `${APP_DIR}/target`;
const RUNNER_DIR = `${APP_DIR}/runner`;
const PREVIEW_PORT = 5173;
const RUNNER_PORT = 8091;

const TERMINAL_DEVBOX_STATUSES = new Set(["failure", "shutdown"]);
const TERMINAL_EXECUTION_STATUSES = new Set([
  "cancelled",
  "canceled",
  "error",
  "failed",
  "failure",
  "timed_out",
  "timeout",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function errorDetail(error) {
  if (error instanceof Error && nonemptyString(error.message)) {
    return error.message;
  }
  return "Workspace provisioning failed";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function normalizeApiBaseUrl(value) {
  const base = nonemptyString(value) ?? DEFAULT_API_BASE_URL;
  const withoutTrailingSlash = base.replace(/\/+$/, "");
  return /\/v1$/i.test(withoutTrailingSlash)
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/v1`;
}

function endpoint(baseUrl, path) {
  return `${baseUrl}/${String(path).replace(/^\/+/, "")}`;
}

function decodeCodexAuth(encoded) {
  const source = nonemptyString(encoded);
  if (!source) {
    throw new Error("CODEX_AUTH_JSON is required for workspace provisioning");
  }

  const compact = source.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error("CODEX_AUTH_JSON must be valid base64");
  }

  const decoded = Buffer.from(compact, "base64").toString("utf8");
  const normalizedInput = compact.replace(/=+$/, "");
  const normalizedOutput = Buffer.from(decoded, "utf8")
    .toString("base64")
    .replace(/=+$/, "");
  if (!decoded || normalizedInput !== normalizedOutput) {
    throw new Error("CODEX_AUTH_JSON must be valid base64");
  }

  try {
    JSON.parse(decoded);
  } catch {
    throw new Error("CODEX_AUTH_JSON must decode to valid JSON");
  }
  return decoded;
}

function siblingTunnelUrl(previewUrl, port) {
  const source = nonemptyString(previewUrl);
  if (!source) return null;
  try {
    const url = new URL(source);
    if (!/^\d+-/.test(url.hostname)) return null;
    url.hostname = url.hostname.replace(/^\d+-/, `${port}-`);
    url.port = "";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function workspaceFromTunnel(devboxId, tunnelKey) {
  const previewUrl = `https://${PREVIEW_PORT}-${tunnelKey}.tunnel.runloop.ai`;
  return {
    devboxId,
    previewUrl,
    runnerUrl: `https://${RUNNER_PORT}-${tunnelKey}.tunnel.runloop.ai`,
  };
}

function normalizePinnedWorkspace(workspace) {
  if (!isObject(workspace)) {
    throw new TypeError("Pinned workspace must be an object");
  }
  const devboxId = nonemptyString(workspace.devboxId);
  const previewUrl = nonemptyString(workspace.previewUrl);
  if (!devboxId || !previewUrl) {
    throw new TypeError("Pinned workspace needs devboxId and previewUrl");
  }
  return {
    devboxId,
    previewUrl,
    runnerUrl:
      nonemptyString(workspace.runnerUrl) ??
      siblingTunnelUrl(previewUrl, RUNNER_PORT),
  };
}

function runnerAgentsFor(room) {
  const runnerAgents = Array.isArray(room.agents)
    ? room.agents.filter((agent) => isObject(agent) && agent.engine === "runner")
    : [];
  const importThreadId = nonemptyString(room.importThreadId);

  return runnerAgents.map((agent, index) => {
    const normalized = {
      agentId: agent.agentId,
      label: agent.label,
      engine: "runner",
      model: agent.model,
    };
    if (nonemptyString(agent.color)) normalized.color = agent.color;
    if (index === 0 && importThreadId) normalized.importThreadId = importThreadId;
    return normalized;
  });
}

async function parseResponse(response) {
  if (!response || response.status === 204) return null;

  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  if (typeof response.json === "function") {
    return response.json();
  }
  return null;
}

export class RunloopRequestError extends Error {
  constructor(method, url, status, responseBody) {
    const suffix =
      typeof responseBody === "string"
        ? responseBody.slice(0, 300)
        : isObject(responseBody) && typeof responseBody.message === "string"
          ? responseBody.message.slice(0, 300)
          : "";
    super(
      `Runloop ${method} ${new URL(url).pathname} returned HTTP ${status}${
        suffix ? `: ${suffix}` : ""
      }`,
    );
    this.name = "RunloopRequestError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.responseBody = responseBody;
  }
}

export class RemoteCommandError extends Error {
  constructor(commandName, execution) {
    const exitStatus = execution?.exit_status;
    const output =
      nonemptyString(execution?.stderr) ?? nonemptyString(execution?.stdout);
    super(
      `${commandName} failed${
        Number.isInteger(exitStatus) ? ` with exit ${exitStatus}` : ""
      }${output ? `: ${output.slice(0, 500)}` : ""}`,
    );
    this.name = "RemoteCommandError";
    this.execution = execution;
  }
}

class TerminalDevboxStateError extends Error {
  constructor(devboxId, status, view) {
    super(`Runloop devbox ${devboxId} entered terminal state ${status}`);
    this.name = "TerminalDevboxStateError";
    this.devboxStatus = status;
    this.view = view;
  }
}

/**
 * Create an injectable Runloop workspace provisioner.
 *
 * onProgress receives one object:
 *   {roomId, type:"workspace.status"|"preview.updated", payload, ...payload}
 * onSuspend receives one object:
 *   {roomId, devboxId, previewUrl, reason}
 */
export function createProvisioner(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const apiBaseUrl = normalizeApiBaseUrl(
    options.apiBaseUrl ?? env.RUNLOOP_BASE_URL,
  );
  const apiKey =
    nonemptyString(options.apiKey) ?? nonemptyString(env.RUNLOOP_API_KEY);
  const encodedCodexAuth =
    nonemptyString(options.codexAuthJsonBase64) ??
    nonemptyString(env.CODEX_AUTH_JSON);
  const maxLive =
    options.maxLiveWorkspaces ??
    options.maxLive ??
    DEFAULT_MAX_LIVE_WORKSPACES;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const healthAttempts = options.healthAttempts ?? DEFAULT_HEALTH_ATTEMPTS;
  const healthIntervalMs = options.healthIntervalMs ?? 2_000;
  const statusWaitAttempts = options.statusWaitAttempts ?? 24;
  const suspendWaitAttempts =
    options.suspendWaitAttempts ?? DEFAULT_SUSPEND_WAIT_ATTEMPTS;
  const executionWaitAttempts = options.executionWaitAttempts ?? 32;
  const closeSuspendTimeoutMs =
    options.closeSuspendTimeoutMs ?? DEFAULT_CLOSE_SUSPEND_TIMEOUT_MS;
  const defaultOnProgress = options.onProgress;
  const defaultOnSuspend = options.onSuspend;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("createProvisioner needs a fetch implementation");
  }
  if (!Number.isInteger(maxLive) || maxLive < 1) {
    throw new TypeError("maxLiveWorkspaces must be a positive integer");
  }
  if (!Number.isInteger(suspendWaitAttempts) || suspendWaitAttempts < 1) {
    throw new TypeError("suspendWaitAttempts must be a positive integer");
  }

  let authContents = null;
  let configurationError = null;
  if (!apiKey) {
    configurationError = new Error(
      "RUNLOOP_API_KEY is required for workspace provisioning",
    );
  } else {
    try {
      authContents = decodeCodexAuth(encodedCodexAuth);
    } catch (error) {
      configurationError = error;
    }
  }

  const records = new Map();
  const inflight = new Map();
  const closeController = new AbortController();
  let closed = false;
  let accessSequence = 0;
  let capacityQueue = Promise.resolve();

  function logWarning(error, message) {
    if (typeof logger?.warn !== "function") return;
    try {
      logger.warn({ err: error }, message);
    } catch {
      // Logging is advisory and must never break provisioning.
    }
  }

  async function callCallbacks(callbacks, event, label) {
    for (const callback of new Set(callbacks.filter((item) => typeof item === "function"))) {
      try {
        await callback(event);
      } catch (error) {
        logWarning(error, `${label} callback failed`);
      }
    }
  }

  async function report(record, type, payload, extraCallback) {
    const event = { roomId: record.roomId, type, payload, ...payload };
    await callCallbacks(
      [defaultOnProgress, record.onProgress, extraCallback],
      event,
      "workspace progress",
    );
  }

  function markUsed(record) {
    record.lastUsedAt = Number(now());
    record.accessSequence = ++accessSequence;
  }

  function activeRecords() {
    return [...records.values()].filter((record) => record.active);
  }

  function requestSignal(timeoutMs = requestTimeoutMs) {
    const signals = [closeController.signal];
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      signals.push(AbortSignal.timeout(timeoutMs));
    }
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  }

  async function apiRequest(path, { method = "GET", body, timeoutMs } = {}) {
    if (closed) throw new Error("Workspace provisioner is closed");

    const url = endpoint(apiBaseUrl, path);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    const init = {
      method,
      headers,
      signal: requestSignal(timeoutMs),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetchImpl(url, init);
    const responseBody = await parseResponse(response);
    const status = Number(response?.status ?? 200);
    const ok = response?.ok ?? (status >= 200 && status < 300);
    if (!ok) {
      throw new RunloopRequestError(method, url, status, responseBody);
    }
    return responseBody;
  }

  async function cleanupRequest(path, { method = "POST", body } = {}) {
    const url = endpoint(apiBaseUrl, path);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(closeSuspendTimeoutMs),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetchImpl(url, init);
    const responseBody = await parseResponse(response);
    const status = Number(response?.status ?? 200);
    const ok = response?.ok ?? (status >= 200 && status < 300);
    if (!ok) {
      throw new RunloopRequestError(method, url, status, responseBody);
    }
    return responseBody;
  }

  function post(path, body, timeoutMs) {
    return apiRequest(path, { method: "POST", body, timeoutMs });
  }

  async function waitForDevbox(
    devboxId,
    statuses,
    expectedStatus,
    attempts = statusWaitAttempts,
  ) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let view;
      try {
        view = await post(`devboxes/${encodeURIComponent(devboxId)}/wait_for_status`, {
          statuses,
          timeout_seconds: DEVBOX_WAIT_SECONDS,
        });
      } catch (error) {
        if (error instanceof RunloopRequestError && error.status === 408) continue;
        throw error;
      }

      if (view?.status === expectedStatus) return view;
      if (TERMINAL_DEVBOX_STATUSES.has(view?.status)) {
        throw new TerminalDevboxStateError(devboxId, view.status, view);
      }
      await sleep(POLL_RETRY_DELAY_MS, undefined, {
        signal: closeController.signal,
      });
    }
    throw new Error(
      `Timed out waiting for Runloop devbox ${devboxId} to become ${expectedStatus}`,
    );
  }

  async function waitForExecution(devboxId, executionId, label) {
    for (let attempt = 0; attempt < executionWaitAttempts; attempt += 1) {
      let execution;
      try {
        execution = await post(
          `devboxes/${encodeURIComponent(devboxId)}/executions/${encodeURIComponent(
            executionId,
          )}/wait_for_status`,
          {
            statuses: ["completed", ...TERMINAL_EXECUTION_STATUSES],
            timeout_seconds: EXECUTION_WAIT_SECONDS,
          },
        );
        if (execution?.status === "completed") return execution;
      } catch (error) {
        if (!(error instanceof RunloopRequestError && error.status === 408)) {
          throw error;
        }
      }
      if (TERMINAL_EXECUTION_STATUSES.has(execution?.status)) {
        throw new RemoteCommandError(label, execution);
      }
      if (attempt + 1 < executionWaitAttempts) {
        await sleep(POLL_RETRY_DELAY_MS, undefined, {
          signal: closeController.signal,
        });
      }
    }
    throw new Error(`Timed out waiting for remote command ${executionId}`);
  }

  function assertExecutionSucceeded(label, execution) {
    if (
      execution?.status !== undefined &&
      execution.status !== "completed"
    ) {
      throw new RemoteCommandError(label, execution);
    }
    if (Number.isInteger(execution?.exit_status) && execution.exit_status !== 0) {
      throw new RemoteCommandError(label, execution);
    }
    return execution;
  }

  async function runRemote(devboxId, command, label) {
    let execution = await post(
      `devboxes/${encodeURIComponent(devboxId)}/execute_async`,
      { command },
    );
    if (execution?.status !== "completed") {
      const executionId = nonemptyString(execution?.execution_id);
      if (!executionId) {
        throw new Error(`${label} did not return a Runloop execution_id`);
      }
      execution = await waitForExecution(devboxId, executionId, label);
    }
    return assertExecutionSucceeded(label, execution);
  }

  async function writeAuthFile(devboxId) {
    const result = await post(
      `devboxes/${encodeURIComponent(devboxId)}/write_file_contents`,
      { contents: authContents, file_path: AUTH_FILE },
      600_000,
    );
    if (Number.isInteger(result?.exit_status) && result.exit_status !== 0) {
      throw new RemoteCommandError("writing Codex authentication", result);
    }
  }

  async function waitForPreview(devboxId) {
    for (let attempt = 0; attempt < healthAttempts; attempt += 1) {
      const result = await runRemote(
        devboxId,
        `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${PREVIEW_PORT}/ || true`,
        "checking the preview server",
      );
      const statusCode = String(result?.stdout ?? "").trim();
      if (statusCode === "200" || statusCode === "304") return;
      if (attempt + 1 < healthAttempts) {
        await sleep(healthIntervalMs, undefined, {
          signal: closeController.signal,
        });
      }
    }
    throw new Error("Vite did not become ready on port 5173");
  }

  async function notifySuspended(record, reason, requesterOnSuspend) {
    const event = {
      roomId: record.roomId,
      devboxId: record.devboxId,
      previewUrl: record.workspace?.previewUrl ?? null,
      reason,
    };
    const callback =
      record.onSuspend ?? requesterOnSuspend ?? defaultOnSuspend;
    await callCallbacks([callback], event, "workspace suspension");
  }

  function inactiveStatusFromError(error) {
    if (error instanceof TerminalDevboxStateError) {
      return error.devboxStatus;
    }
    if (
      error instanceof RunloopRequestError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      return "inactive";
    }
    return null;
  }

  async function deactivateRecord(
    record,
    status,
    detail,
    reason,
    requesterOnSuspend,
  ) {
    record.active = false;
    record.status = status;
    if (record.room) {
      record.room.workspace = {
        status: "error",
        devboxId: record.devboxId,
        ...(record.workspace?.previewUrl
          ? { previewUrl: record.workspace.previewUrl }
          : {}),
      };
    }
    await report(record, "workspace.status", { status: "error", detail });
    await notifySuspended(record, reason, requesterOnSuspend);
  }

  async function suspendRecord(record, reason, requesterOnSuspend) {
    if (!record?.active) return;
    if (record.pinned) {
      throw new Error(`Pinned workspace ${record.roomId} cannot be suspended`);
    }
    if (!record.devboxId) {
      throw new Error(`Workspace ${record.roomId} is not ready to suspend`);
    }

    let result;
    try {
      result = await post(
        `devboxes/${encodeURIComponent(record.devboxId)}/suspend`,
        undefined,
        Math.min(requestTimeoutMs, 10_000),
      );
      if (TERMINAL_DEVBOX_STATUSES.has(result?.status)) {
        throw new TerminalDevboxStateError(
          record.devboxId,
          result.status,
          result,
        );
      }
      if (result?.status !== "suspended") {
        await waitForDevbox(
          record.devboxId,
          ["suspended", "failure", "shutdown"],
          "suspended",
          suspendWaitAttempts,
        );
      }
    } catch (error) {
      const inactiveStatus = inactiveStatusFromError(error);
      if (!inactiveStatus) throw error;
      await deactivateRecord(
        record,
        inactiveStatus,
        "Workspace was already inactive while freeing capacity",
        reason,
        requesterOnSuspend,
      );
      return;
    }

    await deactivateRecord(
      record,
      "suspended",
      "Workspace suspended to stay within the two-workspace limit",
      reason,
      requesterOnSuspend,
    );
  }

  async function shutdownRecord(record) {
    if (!record?.devboxId) return;
    try {
      await post(
        `devboxes/${encodeURIComponent(record.devboxId)}/shutdown`,
        {},
        Math.min(requestTimeoutMs, 10_000),
      );
    } catch (error) {
      if (
        !(error instanceof RunloopRequestError) ||
        error.status < 400 ||
        error.status >= 500
      ) {
        throw error;
      }
    }
    record.active = false;
    record.status = "shutdown";
  }

  function serializeCapacity(operation) {
    const result = capacityQueue.then(operation, operation);
    capacityQueue = result.catch(() => {});
    return result;
  }

  async function reserveCapacity(room, callbacks) {
    while (true) {
      const decision = await serializeCapacity(async () => {
        if (closed) throw new Error("Workspace provisioner is closed");

        const oldRecord = records.get(room.roomId);
        const resumable = Boolean(
          oldRecord &&
            !oldRecord.active &&
            oldRecord.status === "suspended" &&
            oldRecord.devboxId &&
            oldRecord.workspace,
        );

        if (oldRecord?.active && !oldRecord.pinned) {
          try {
            await suspendRecord(oldRecord, "retry", callbacks.onSuspend);
          } catch (error) {
            logWarning(
              error,
              `Could not suspend retry workspace ${oldRecord.roomId}; shutting it down`,
            );
          }
          await shutdownRecord(oldRecord);
        } else if (
          oldRecord?.devboxId &&
          !resumable &&
          !TERMINAL_DEVBOX_STATUSES.has(oldRecord.status)
        ) {
          // Never overwrite the only reference to a live or suspended devbox.
          await shutdownRecord(oldRecord);
        }

        while (activeRecords().length >= maxLive) {
          const candidate = activeRecords()
            .filter(
              (record) =>
                !record.pinned &&
                record.roomId !== room.roomId &&
                record.devboxId &&
                record.status !== "provisioning" &&
                record.status !== "resuming",
            )
            .sort(
              (left, right) =>
                left.lastUsedAt - right.lastUsedAt ||
                left.accessSequence - right.accessSequence,
            )[0];

          if (!candidate) {
            const waitFor = [...inflight.entries()]
              .filter(([roomId]) => {
                if (roomId === room.roomId) return false;
                const inflightRecord = records.get(roomId);
                return (
                  inflightRecord?.active &&
                  (inflightRecord.status === "provisioning" ||
                    inflightRecord.status === "resuming")
                );
              })
              .map(([, promise]) => promise);
            if (waitFor.length > 0) return { waitFor };
            throw new Error(
              "Workspace capacity is full and no non-pinned workspace can be suspended",
            );
          }
          try {
            await suspendRecord(candidate, "lru", callbacks.onSuspend);
          } catch (error) {
            logWarning(
              error,
              `Could not suspend LRU workspace ${candidate.roomId}; marking it inactive`,
            );
            await deactivateRecord(
              candidate,
              "inactive",
              "Workspace became inactive while freeing capacity",
              "lru",
              callbacks.onSuspend,
            );
          }
        }

        if (resumable && records.get(room.roomId) === oldRecord) {
          oldRecord.room = room;
          oldRecord.onProgress = callbacks.onProgress ?? oldRecord.onProgress;
          oldRecord.onSuspend = callbacks.onSuspend ?? oldRecord.onSuspend;
          oldRecord.active = true;
          oldRecord.status = "resuming";
          markUsed(oldRecord);
          return { record: oldRecord, resume: true };
        }

        const record = {
          roomId: room.roomId,
          room,
          workspace: null,
          devboxId: null,
          status: "provisioning",
          active: true,
          pinned: false,
          onProgress: callbacks.onProgress,
          onSuspend: callbacks.onSuspend,
          lastUsedAt: 0,
          accessSequence: 0,
        };
        markUsed(record);
        records.set(room.roomId, record);
        return { record, resume: false };
      });

      if (decision.record) return decision;
      await Promise.allSettled(decision.waitFor);
      if (closed) throw new Error("Workspace provisioner is closed");
    }
  }

  async function resumeWorkspace(record, room) {
    room.workspace = {
      status: "provisioning",
      devboxId: record.devboxId,
      ...(record.workspace?.previewUrl
        ? { previewUrl: record.workspace.previewUrl }
        : {}),
    };
    await report(record, "workspace.status", {
      status: "provisioning",
      detail: "Resuming the existing Runloop workspace",
    });

    const resumed = await post(
      `devboxes/${encodeURIComponent(record.devboxId)}/resume`,
      {},
    );
    if (TERMINAL_DEVBOX_STATUSES.has(resumed?.status)) {
      throw new TerminalDevboxStateError(
        record.devboxId,
        resumed.status,
        resumed,
      );
    }
    if (resumed?.status !== "running") {
      await waitForDevbox(
        record.devboxId,
        ["running", "failure", "shutdown"],
        "running",
      );
    }
    if (!record.workspace?.previewUrl) {
      throw new Error(`Workspace ${record.roomId} has no preview to resume`);
    }

    record.active = true;
    record.status = "ready";
    markUsed(record);
    room.workspace = {
      status: "ready",
      devboxId: record.workspace.devboxId,
      previewUrl: record.workspace.previewUrl,
    };
    await report(record, "preview.updated", {
      url: record.workspace.previewUrl,
    });
    await report(record, "workspace.status", {
      status: "ready",
      detail: "Workspace resumed",
    });
    return { ...record.workspace };
  }

  async function provisionInternal(room, callbacks) {
    if (closed) throw new Error("Workspace provisioner is closed");

    const existing = records.get(room.roomId);
    if (existing?.active && existing.pinned) {
      existing.room = room;
      existing.onProgress = callbacks.onProgress ?? existing.onProgress;
      existing.onSuspend = callbacks.onSuspend ?? existing.onSuspend;
      markUsed(existing);
      room.workspace = {
        status: "ready",
        devboxId: existing.workspace.devboxId,
        previewUrl: existing.workspace.previewUrl,
      };
      await report(existing, "preview.updated", {
        url: existing.workspace.previewUrl,
      });
      await report(existing, "workspace.status", {
        status: "ready",
        detail: "Using the pinned demo workspace",
      });
      return { ...existing.workspace };
    }
    if (existing?.active && existing.status === "ready" && existing.workspace) {
      existing.room = room;
      existing.onProgress = callbacks.onProgress ?? existing.onProgress;
      existing.onSuspend = callbacks.onSuspend ?? existing.onSuspend;
      markUsed(existing);
      return { ...existing.workspace };
    }

    let record = null;
    try {
      if (callbacks.preflightError) throw callbacks.preflightError;
      if (configurationError) throw configurationError;

      let reservation = await reserveCapacity(room, callbacks);
      record = reservation.record;
      if (reservation.resume) {
        try {
          return await resumeWorkspace(record, room);
        } catch (error) {
          const inactiveStatus = inactiveStatusFromError(error);
          if (!inactiveStatus) throw error;
          record.active = false;
          record.status = inactiveStatus;
          logWarning(
            error,
            `Existing workspace ${record.roomId} could not be resumed; replacing it`,
          );
          reservation = await reserveCapacity(room, callbacks);
          record = reservation.record;
        }
      }
      room.workspace = { status: "provisioning" };
      await report(record, "workspace.status", {
        status: "provisioning",
        detail: "Creating a Runloop workspace",
      });

      const created = await post("devboxes", {
        name: `ens-${room.roomId}`,
        mounts: [{ type: "agent_mount", agent_name: "codex" }],
        launch_parameters: { keep_alive_time_seconds: 14400 },
      });
      const devboxId = nonemptyString(created?.id);
      if (!devboxId) throw new Error("Runloop create response did not include id");
      record.devboxId = devboxId;

      await report(record, "workspace.status", {
        status: "provisioning",
        detail: "Waiting for the workspace to start",
      });
      if (created?.status !== "running") {
        await waitForDevbox(
          devboxId,
          ["running", "failure", "shutdown"],
          "running",
        );
      }

      await report(record, "workspace.status", {
        status: "provisioning",
        detail: "Installing Codex authentication",
      });
      await runRemote(
        devboxId,
        `mkdir -p ${shellQuote(APP_DIR)} ${shellQuote(AUTH_DIR)}`,
        "creating workspace directories",
      );
      await writeAuthFile(devboxId);

      const hubUrl = callbacks.hubUrl.replace(/\/+$/, "");
      const bundleUrl = `${hubUrl}/bundle`;
      await report(record, "workspace.status", {
        status: "provisioning",
        detail: "Fetching the workspace bundle",
      });
      await runRemote(
        devboxId,
        [
          `curl --fail --silent --show-error --location ${shellQuote(bundleUrl)} --output ${shellQuote(BUNDLE_FILE)}`,
          `tar -xzf ${shellQuote(BUNDLE_FILE)} -C ${shellQuote(APP_DIR)}`,
          // Session rollout seeds make `codex exec resume <importThreadId>` work
          // on a fresh devbox (rollouts are local files on the machine codex runs on).
          "mkdir -p ~/.codex/sessions/2026/08/29",
          `cp ${shellQuote(APP_DIR)}/sessions-seed/*.jsonl ~/.codex/sessions/2026/08/29/ 2>/dev/null || true`,
        ].join(" && "),
        "fetching the workspace bundle",
      );

      const repoUrl = nonemptyString(room.repoUrl);
      const targetDir = repoUrl ? REPOSITORY_TARGET_DIR : TEMPLATE_TARGET_DIR;
      if (repoUrl) {
        await report(record, "workspace.status", {
          status: "provisioning",
          detail: "Cloning the project repository",
        });
        await runRemote(
          devboxId,
          `git clone --depth 1 -- ${shellQuote(repoUrl)} ${shellQuote(targetDir)}`,
          "cloning the project repository",
        );
      }

      await report(record, "workspace.status", {
        status: "provisioning",
        detail: "Installing project dependencies",
      });
      await runRemote(
        devboxId,
        `cd ${shellQuote(targetDir)} && npm install`,
        "installing project dependencies",
      );

      await report(record, "workspace.status", {
        status: "provisioning",
        detail: "Starting the live preview",
      });
      const viteCommand = [
        `cd ${shellQuote(targetDir)}`,
        "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.tunnel.runloop.ai npm run dev -- --host 0.0.0.0 --port 5173",
      ].join(" && ");
      await runRemote(
        devboxId,
        `nohup bash -lc ${shellQuote(viteCommand)} > /tmp/ensemble-vite.log 2>&1 < /dev/null & echo started`,
        "starting Vite",
      );
      await waitForPreview(devboxId);

      await report(record, "workspace.status", {
        status: "provisioning",
        detail: "Opening the preview tunnel",
      });
      const tunnel = await post(
        `devboxes/${encodeURIComponent(devboxId)}/enable_tunnel`,
        { auth_mode: "open" },
      );
      const tunnelKey = nonemptyString(tunnel?.tunnel_key);
      if (!tunnelKey) {
        throw new Error("Runloop tunnel response did not include tunnel_key");
      }
      const workspace = workspaceFromTunnel(devboxId, tunnelKey);
      record.workspace = workspace;
      await report(record, "preview.updated", { url: workspace.previewUrl });

      const agents = runnerAgentsFor(room);
      await report(record, "workspace.status", {
        status: "provisioning",
        detail: "Starting the agent runner",
      });
      const runnerCommand = [
        `cd ${shellQuote(RUNNER_DIR)}`,
        [
          `SERVER_URL=${shellQuote(hubUrl)}`,
          `ROOM_ID=${shellQuote(room.roomId)}`,
          `ENSEMBLE_KEY=${shellQuote(callbacks.ensembleKey)}`,
          `AGENTS=${shellQuote(JSON.stringify(agents))}`,
          ...(nonemptyString(room.importThreadId)
            ? [`IMPORT_THREAD_ID=${shellQuote(room.importThreadId)}`]
            : []),
          `TARGET_DIR=${shellQuote(targetDir)}`,
          "node index.mjs",
        ].join(" "),
      ].join(" && ");
      await runRemote(
        devboxId,
        `nohup bash -lc ${shellQuote(runnerCommand)} > /tmp/ensemble-runner.log 2>&1 < /dev/null & echo started`,
        "starting the agent runner",
      );

      record.status = "ready";
      markUsed(record);
      room.workspace = {
        status: "ready",
        devboxId: workspace.devboxId,
        previewUrl: workspace.previewUrl,
      };
      await report(record, "workspace.status", {
        status: "ready",
        detail: "Workspace ready",
      });
      return { ...workspace };
    } catch (error) {
      const eventRecord =
        record ?? {
          roomId: room.roomId,
          onProgress: callbacks.onProgress,
        };
      if (record) {
        record.status = "error";
        if (!record.devboxId) {
          record.active = false;
          if (records.get(room.roomId) === record) records.delete(room.roomId);
        }
      }
      const detail = errorDetail(error);
      room.workspace = {
        status: "error",
        ...(record?.devboxId ? { devboxId: record.devboxId } : {}),
      };
      await report(eventRecord, "workspace.status", { status: "error", detail });
      throw error;
    }
  }

  function provision(room, provisionOptions = {}) {
    if (!isObject(room) || !nonemptyString(room.roomId)) {
      return Promise.reject(new TypeError("provision needs a room with roomId"));
    }
    const roomId = room.roomId.trim();
    room.roomId = roomId;

    const existingInflight = inflight.get(roomId);
    if (existingInflight) return existingInflight;

    const pinned = records.get(roomId)?.pinned === true;
    const hubUrl =
      nonemptyString(provisionOptions.hubUrl) ??
      nonemptyString(options.hubUrl) ??
      nonemptyString(env.HUB_URL) ??
      nonemptyString(env.PUBLIC_URL) ??
      nonemptyString(env.SERVER_URL);
    const ensembleKey =
      nonemptyString(provisionOptions.ensembleKey) ??
      nonemptyString(options.ensembleKey) ??
      nonemptyString(env.ENSEMBLE_KEY);

    const callbacks = {
      hubUrl,
      ensembleKey,
      onProgress: provisionOptions.onProgress,
      onSuspend: provisionOptions.onSuspend,
      preflightError:
        !pinned && (!hubUrl || !ensembleKey)
          ? new Error(
              "provision needs hubUrl and ensembleKey for a new workspace",
            )
          : null,
    };
    const promise = provisionInternal(room, callbacks).finally(() => {
      if (inflight.get(roomId) === promise) inflight.delete(roomId);
    });
    inflight.set(roomId, promise);
    return promise;
  }

  function registerPinned(roomIdValue, workspaceValue, registerOptions = {}) {
    if (closed) throw new Error("Workspace provisioner is closed");
    const roomId = nonemptyString(roomIdValue);
    if (!roomId) throw new TypeError("registerPinned needs a roomId");
    const workspace = normalizePinnedWorkspace(workspaceValue);
    const existing = records.get(roomId);
    if (
      existing?.active &&
      !existing.pinned &&
      existing.devboxId !== workspace.devboxId
    ) {
      throw new Error(`Room ${roomId} already has an active workspace`);
    }

    const record = {
      roomId,
      room: existing?.room ?? null,
      workspace,
      devboxId: workspace.devboxId,
      status: "ready",
      active: true,
      pinned: true,
      onProgress: existing?.onProgress,
      onSuspend: registerOptions.onSuspend ?? existing?.onSuspend,
      lastUsedAt: 0,
      accessSequence: 0,
    };
    markUsed(record);
    records.set(roomId, record);
    return { ...workspace };
  }

  function touch(roomIdValue) {
    const roomId = nonemptyString(roomIdValue);
    const record = roomId ? records.get(roomId) : null;
    if (!record?.active) return false;
    markUsed(record);
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    closeController.abort(new Error("Workspace provisioner closed"));
    await Promise.allSettled([...inflight.values()]);

    const active = activeRecords().filter(
      (record) => !record.pinned && record.devboxId,
    );
    await Promise.allSettled(
      active.map(async (record) => {
        try {
          await cleanupRequest(
            `devboxes/${encodeURIComponent(record.devboxId)}/suspend`,
          );
          record.active = false;
          record.status = "suspended";
        } catch (error) {
          if (
            error instanceof RunloopRequestError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            record.active = false;
            record.status = "inactive";
            return;
          }
          logWarning(
            error,
            `Could not suspend workspace ${record.roomId} during shutdown`,
          );
        }
      }),
    );
  }

  if (env.DEMO_ROOM === "1" && nonemptyString(env.DEMO_WORKSPACE_JSON)) {
    try {
      registerPinned("demo", JSON.parse(env.DEMO_WORKSPACE_JSON));
    } catch (error) {
      logWarning(error, "Ignoring invalid DEMO_WORKSPACE_JSON");
    }
  }

  async function release(roomId) {
    const record = records.get(roomId);
    records.delete(roomId);
    const devboxId = record?.devboxId ?? record?.workspace?.devboxId;
    if (!devboxId || record?.pinned) return false;
    record.active = false;
    try {
      await post(`devboxes/${encodeURIComponent(devboxId)}/shutdown`, {});
      return true;
    } catch {
      return false;
    }
  }

  return {
    get configured() {
      return !closed && configurationError === null;
    },
    provision,
    registerPinned,
    touch,
    release,
    close,
  };
}

export default createProvisioner;
