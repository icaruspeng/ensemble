const DEFAULT_API_BASE_URL = "https://reflex.runloop.ai/api";
const DEFAULT_WS_URL = "wss://reflex.runloop.ai/api/ws";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_SEEN_EVENT_IDS = 5_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parseObject(value) {
  if (isObject(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function textFrom(value, depth = 0) {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => textFrom(item, depth + 1))
      .filter(Boolean)
      .join("");
  }
  if (!isObject(value)) return "";

  for (const key of ["text", "thinking", "message", "content", "summary", "delta"]) {
    if (Object.hasOwn(value, key)) {
      const text = textFrom(value[key], depth + 1);
      if (text) return text;
    }
  }
  return "";
}

function integerFrom(...values) {
  for (const value of values) {
    if (Number.isInteger(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      return Number.parseInt(value, 10);
    }
  }
  return null;
}

function numberFrom(...values) {
  for (const value of values) {
    const number = finiteNonnegative(value);
    if (number !== null) return number;
  }
  return null;
}

function turnReference(payload) {
  const value =
    payload.turnId ?? payload.turn_id ?? payload.turn?.id ?? payload.turn?.turnId;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function explicitTaskId(payload) {
  return firstString(payload.taskId, payload.task_id);
}

function usageTokens(usage) {
  if (!isObject(usage)) return null;
  const explicit = numberFrom(
    usage.tokens,
    usage.total_tokens,
    usage.totalTokens,
    usage.total_token_count,
  );
  if (explicit !== null) return explicit;

  const fields = [
    "input_tokens",
    "inputTokens",
    "output_tokens",
    "outputTokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  ];
  let found = false;
  let total = 0;
  for (const field of fields) {
    const value = finiteNonnegative(usage[field]);
    if (value === null) continue;
    found = true;
    total += value;
  }
  return found ? total : null;
}

function tokensFromPayload(payload) {
  const direct = numberFrom(payload.tokens, payload.total_tokens, payload.totalTokens);
  if (direct !== null) return direct;
  return usageTokens(parseObject(payload.usage));
}

function costFromPayload(payload) {
  const usage = parseObject(payload.usage);
  return numberFrom(
    payload.costUsd,
    payload.cost_usd,
    payload.total_cost_usd,
    usage.costUsd,
    usage.cost_usd,
    usage.total_cost_usd,
    isObject(usage.cost) ? usage.cost.amount : null,
  );
}

function lines(text) {
  if (text === "") return [];
  return String(text).replace(/\r\n/g, "\n").split("\n");
}

function unifiedPatch(file, oldText, newText) {
  const oldLines = lines(oldText ?? "");
  const newLines = lines(newText ?? "");
  const oldName = oldText == null ? "/dev/null" : `a/${file}`;
  const oldStart = oldLines.length > 0 ? 1 : 0;
  const newStart = newLines.length > 0 ? 1 : 0;
  return [
    `--- ${oldName}`,
    `+++ b/${file}`,
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function fileFromPatch(patch) {
  if (typeof patch !== "string") return null;
  const match = patch.match(/^\+\+\+\s+(?:b\/)?([^\n\r]+)$/m);
  return match?.[1] && match[1] !== "/dev/null" ? match[1] : null;
}

function commandFromItem(item, toolName = "") {
  const input = isObject(item.input)
    ? item.input
    : isObject(item.rawInput)
      ? item.rawInput
      : {};
  const direct = firstString(item.command, input.command, input.cmd, input.script);
  if (direct) return direct;

  const normalizedName = String(toolName).toLowerCase();
  if (!/(?:^|[_.-])(bash|shell|terminal|command|exec)(?:$|[_.-])/.test(normalizedName)) {
    return null;
  }
  if (Array.isArray(input.args)) return input.args.map(String).join(" ");
  return typeof item.input === "string" ? item.input : null;
}

function diffsFromItem(item, toolName = "") {
  const results = [];
  const input = isObject(item.input)
    ? item.input
    : isObject(item.rawInput)
      ? item.rawInput
      : {};
  const directPatch = firstString(item.patch, item.diff, input.patch, input.diff);
  const directFile = firstString(
    item.file,
    item.path,
    item.file_path,
    input.file,
    input.path,
    input.file_path,
    fileFromPatch(directPatch),
  );
  if (directPatch && directFile) {
    results.push({ file: directFile, patch: directPatch });
    return results;
  }

  const name = String(toolName).toLowerCase().replaceAll(/[^a-z]/g, "");
  if (name === "write") {
    const file = firstString(input.file_path, input.path);
    const content = firstString(input.content, input.contents);
    if (file && content !== null) {
      results.push({ file, patch: unifiedPatch(file, null, content) });
    }
    return results;
  }

  if (name === "edit" || name === "strreplace") {
    const file = firstString(input.file_path, input.path);
    const oldText = typeof input.old_string === "string" ? input.old_string : null;
    const newText = typeof input.new_string === "string" ? input.new_string : null;
    if (file && oldText !== null && newText !== null) {
      results.push({ file, patch: unifiedPatch(file, oldText, newText) });
    }
    return results;
  }

  if (Array.isArray(item.changes)) {
    for (const change of item.changes) {
      if (!isObject(change)) continue;
      const file = firstString(change.file, change.path, change.file_path);
      const patch = firstString(change.patch, change.diff);
      if (file && patch) results.push({ file, patch });
    }
  }
  return results;
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

function socketOn(socket, type, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(type, handler);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(type, handler);
    return;
  }
  socket[`on${type}`] = handler;
}

async function decodeSocketMessage(message) {
  const data = isObject(message) && Object.hasOwn(message, "data") ? message.data : message;
  if (typeof data === "string") return JSON.parse(data);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return JSON.parse(data.toString("utf8"));
  }
  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(data));
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(new TextDecoder().decode(data));
  }
  if (data && typeof data.text === "function") return JSON.parse(await data.text());
  return data;
}

async function readResponse(response) {
  if (typeof response.text === "function") {
    const text = await response.text();
    if (!text) return { data: {}, text: "" };
    try {
      return { data: JSON.parse(text), text };
    } catch {
      return { data: {}, text };
    }
  }
  if (typeof response.json === "function") {
    const data = await response.json();
    return { data, text: JSON.stringify(data) };
  }
  return { data: {}, text: "" };
}

/**
 * Hub-side adapter for Reflex-hosted agents.
 *
 * Inject `fetch`, `WebSocket`, and short URLs in tests; no network is touched
 * until `createAgent()` is called. The room-bound `emit(type, payload)`
 * callback receives only V1/V2 payloads. The session server remains the sole
 * owner of event ids, timestamps, sequence numbers, and actors.
 */
export function createReflexAdapter(options = {}) {
  const apiKey = nonemptyString(options.apiKey ?? process.env.REFLEX_API_KEY) ?? "";
  const organizationId =
    nonemptyString(options.organizationId ?? process.env.REFLEX_ORG) ?? "";
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  const WebSocketImpl =
    options.WebSocket ?? options.WebSocketImpl ?? globalThis.WebSocket;
  const webSocketFactory =
    typeof options.webSocketFactory === "function"
      ? options.webSocketFactory
      : typeof WebSocketImpl === "function"
        ? (url) => new WebSocketImpl(url)
        : null;
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const wsUrl = options.wsUrl ?? DEFAULT_WS_URL;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconnect = options.reconnect ?? true;
  const logger = options.logger ?? {};
  const configured = Boolean(apiKey && organizationId);
  const sessions = new Map();
  const closeController = new AbortController();
  let adapterClosed = false;

  function log(level, message, detail) {
    const method = logger[level];
    if (typeof method !== "function") return;
    try {
      method.call(logger, detail ?? {}, message);
    } catch {
      // Logging must never affect a room.
    }
  }

  async function request(path, body) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-organization-id": organizationId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        closeController.signal,
        AbortSignal.timeout(requestTimeoutMs),
      ]),
    });
    const parsed = await readResponse(response);
    return {
      ok:
        typeof response.ok === "boolean"
          ? response.ok
          : response.status >= 200 && response.status < 300,
      status: response.status,
      data: parsed.data,
      text: parsed.text,
    };
  }

  async function emitSafely(session, type, payload) {
    const stampedPayload = type.startsWith("agent.")
      ? { ...payload, agentId: session.agentId }
      : payload;
    try {
      await session.emit(type, stampedPayload);
    } catch (error) {
      log("warn", "Reflex event callback failed", {
        roomId: session.roomId,
        agentId: session.agentId,
        type,
        error: errorMessage(error),
      });
    }
  }

  async function emitUnavailable(emit, roomId, agentId, reason) {
    const detail = `Claude Code unavailable: ${reason}`;
    try {
      await emit("workspace.status", { status: "error", detail });
    } catch (error) {
      log("warn", "Reflex availability callback failed", {
        roomId,
        agentId,
        error: errorMessage(error),
      });
    }
    if (typeof options.onUnavailable === "function") {
      try {
        await options.onUnavailable({ roomId, agentId, reason });
      } catch (error) {
        log("warn", "Reflex unavailable callback failed", {
          roomId,
          agentId,
          error: errorMessage(error),
        });
      }
    }
  }

  function rememberEvent(session, eventId, sequence) {
    if (Number.isInteger(sequence)) {
      if (sequence <= session.lastSequence) return false;
      session.lastSequence = sequence;
    }
    if (!eventId) return true;
    if (session.seenEventIds.has(eventId)) return false;
    session.seenEventIds.add(eventId);
    if (session.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
      session.seenEventIds.delete(session.seenEventIds.values().next().value);
    }
    return true;
  }

  function takePendingTask(session, taskId = null) {
    if (taskId) {
      const index = session.pendingTasks.findIndex((task) => task.taskId === taskId);
      if (index !== -1) return session.pendingTasks.splice(index, 1)[0];
      return { taskId };
    }
    return session.pendingTasks.shift() ?? null;
  }

  async function ensureTurn(session, payload, overrideTaskId = null) {
    if (session.activeTask) return session.activeTask;
    const directTaskId = overrideTaskId ?? explicitTaskId(payload);
    const pending = takePendingTask(session, directTaskId);
    const reference = turnReference(payload);
    const taskId =
      pending?.taskId ??
      directTaskId ??
      (reference ? session.turnTasks.get(reference) : null) ??
      `reflex:${session.reflexAgentId}:${reference ?? ++session.syntheticTurn}`;

    session.activeTask = { taskId, reference };
    session.turnTokens = 0;
    if (reference) session.turnTasks.set(reference, taskId);
    await emitSafely(session, "agent.turn_started", { taskId });
    return session.activeTask;
  }

  function noteUsage(session, payload) {
    const message = parseObject(payload.message);
    const usage = isObject(message.usage) ? message.usage : payload.usage;
    const tokens = usageTokens(parseObject(usage));
    if (tokens !== null) session.turnTokens += tokens;
  }

  async function completeTurn(session, payload, overrideTaskId = null) {
    const reference = turnReference(payload);
    let taskId =
      overrideTaskId ??
      explicitTaskId(payload) ??
      session.activeTask?.taskId ??
      (reference ? session.turnTasks.get(reference) : null);

    if (!taskId) {
      if (
        session.lastCompletedTaskId &&
        Date.now() - session.lastCompletedAt < 2_000 &&
        session.pendingTasks.length === 0
      ) {
        return;
      }
      taskId = `reflex:${session.reflexAgentId}:${reference ?? ++session.syntheticTurn}`;
    }
    if (
      taskId === session.lastCompletedTaskId &&
      Date.now() - session.lastCompletedAt < 2_000
    ) {
      return;
    }

    const explicitTokens = tokensFromPayload(payload);
    const tokens = explicitTokens ?? session.turnTokens;
    let costUsd = costFromPayload(payload) ?? 0;
    const cumulativeCost = finiteNonnegative(payload.total_cost_usd);
    if (cumulativeCost !== null) {
      costUsd = Math.max(0, cumulativeCost - session.lastCumulativeCostUsd);
      session.lastCumulativeCostUsd = cumulativeCost;
    }

    await emitSafely(session, "agent.turn_completed", {
      taskId,
      tokens,
      costUsd,
    });
    session.lastCompletedTaskId = taskId;
    session.lastCompletedAt = Date.now();
    session.activeTask = null;
    session.turnTokens = 0;
  }

  async function emitText(session, type, value, payload, overrideTaskId) {
    const text = textFrom(value);
    if (!text) return;
    await ensureTurn(session, payload, overrideTaskId);
    await emitSafely(session, type, { text });
  }

  async function handleTool(session, item, payload, overrideTaskId) {
    const toolName = firstString(item.name, item.title, item.toolName, item.kind) ?? "";
    const toolId = firstString(
      item.toolCallId,
      item.tool_call_id,
      item.tool_use_id,
      item.id,
    );
    const command = commandFromItem(item, toolName);
    const diffs = diffsFromItem(item, toolName);
    if (!command && diffs.length === 0) return;

    await ensureTurn(session, payload, overrideTaskId);
    if (toolId) session.toolCalls.set(toolId, { toolName, command, item });
    if (command) {
      const exitCode = integerFrom(item.exitCode, item.exit_code);
      await emitSafely(session, "agent.command", {
        command,
        ...(exitCode !== null ? { exitCode } : {}),
      });
    }
    for (const diff of diffs) await emitSafely(session, "agent.diff", diff);
  }

  async function handleToolUpdate(session, item, payload, overrideTaskId) {
    const toolId = firstString(item.toolCallId, item.tool_call_id, item.tool_use_id, item.id);
    const tracked = toolId ? session.toolCalls.get(toolId) : null;
    const merged = tracked ? { ...tracked.item, ...item } : item;
    const diffs = diffsFromItem(merged, tracked?.toolName ?? "");
    if (diffs.length > 0) {
      await ensureTurn(session, payload, overrideTaskId);
      for (const diff of diffs) await emitSafely(session, "agent.diff", diff);
    }

    const exitCode = integerFrom(
      item.exitCode,
      item.exit_code,
      isObject(item.output) ? item.output.exitCode : null,
      isObject(item.output) ? item.output.exit_code : null,
    );
    if (tracked?.command && exitCode !== null) {
      await ensureTurn(session, payload, overrideTaskId);
      await emitSafely(session, "agent.command", {
        command: tracked.command,
        exitCode,
      });
    }
  }

  async function handleAssistant(session, payload, overrideTaskId) {
    noteUsage(session, payload);
    const message = parseObject(payload.message);
    const content = Array.isArray(message.content)
      ? message.content
      : Array.isArray(payload.content)
        ? payload.content
        : [];
    if (content.length === 0) {
      await emitText(session, "agent.message", message.content ?? payload.content, payload, overrideTaskId);
      return;
    }

    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "thinking" || block.type === "reasoning") {
        await emitText(
          session,
          "agent.thought",
          block.thinking ?? block.text,
          payload,
          overrideTaskId,
        );
      } else if (block.type === "text") {
        await emitText(session, "agent.message", block.text, payload, overrideTaskId);
      } else if (block.type === "tool_use") {
        await handleTool(session, block, payload, overrideTaskId);
      }
    }
  }

  async function handleGenericItem(session, item, payload, overrideTaskId) {
    const kind = String(item.type ?? item.kind ?? "")
      .toLowerCase()
      .replaceAll(/[.\s-]/g, "_");
    if (/reason|thought/.test(kind)) {
      await emitText(
        session,
        "agent.thought",
        item.text ?? item.summary ?? item.content,
        payload,
        overrideTaskId,
      );
      return true;
    }
    if (/agent_message|assistant_message|message_chunk|^message$/.test(kind)) {
      await emitText(
        session,
        "agent.message",
        item.text ?? item.message ?? item.content,
        payload,
        overrideTaskId,
      );
      return true;
    }
    if (/command|tool_call|tool_use|file_change|diff|patch/.test(kind)) {
      await handleTool(session, item, payload, overrideTaskId);
      return true;
    }
    return false;
  }

  async function mapEvent(session, candidate, overrideTaskId = null) {
    let event = candidate;
    if (event.type === "event" && isObject(event.event)) event = event.event;
    if (!isObject(event)) return;

    const eventId = firstString(event.id, event.eventId);
    if (!rememberEvent(session, eventId, event.sequence)) return;
    const rawType = nonemptyString(event.type) ?? "";
    let type = rawType.startsWith("turn.claude.")
      ? rawType.slice("turn.claude.".length)
      : rawType;
    const payload = parseObject(event.payload ?? event.data ?? event);
    if (!type && typeof payload.type === "string") type = payload.type;

    if (type === "turn.started") {
      await ensureTurn(session, payload, overrideTaskId);
      return;
    }
    if (type === "turn.completed") {
      await completeTurn(session, payload, overrideTaskId);
      return;
    }
    if (type === "turn.message_chunk") {
      await emitText(
        session,
        "agent.message",
        payload.content ?? payload.message ?? payload.text,
        payload,
        overrideTaskId,
      );
      return;
    }
    if (type === "turn.tool_call") {
      await handleTool(session, payload, payload, overrideTaskId);
      return;
    }
    if (type === "turn.tool_call_update") {
      await handleToolUpdate(session, payload, payload, overrideTaskId);
      return;
    }
    if (type === "assistant") {
      await handleAssistant(session, payload, overrideTaskId);
      return;
    }
    if (type === "result") {
      if (payload.is_error === true) {
        const detail = textFrom(payload.errors) || nonemptyString(payload.result);
        if (detail) await emitText(session, "agent.message", detail, payload, overrideTaskId);
      }
      await completeTurn(session, payload, overrideTaskId);
      return;
    }
    if (type === "message") {
      if (payload.role === "agent" || payload.role === "assistant" || !payload.role) {
        await emitText(
          session,
          "agent.message",
          payload.message ?? payload.text ?? payload.content,
          payload,
          overrideTaskId,
        );
      }
      return;
    }
    if (type === "agent_message_chunk") {
      await emitText(
        session,
        "agent.message",
        payload.content ?? payload.text ?? payload.update,
        payload,
        overrideTaskId,
      );
      return;
    }
    if (type === "agent_thought_chunk") {
      await emitText(
        session,
        "agent.thought",
        payload.content ?? payload.text ?? payload.update,
        payload,
        overrideTaskId,
      );
      return;
    }
    if (type === "tool_call") {
      await handleTool(session, payload, payload, overrideTaskId);
      return;
    }
    if (type === "tool_call_update") {
      await handleToolUpdate(session, payload, payload, overrideTaskId);
      return;
    }
    if (type === "stream_event" && isObject(payload.event)) {
      const streamEvent = payload.event;
      const delta = parseObject(streamEvent.delta);
      if (streamEvent.type === "content_block_delta" && delta.type === "thinking_delta") {
        await emitText(session, "agent.thought", delta.thinking, payload, overrideTaskId);
      } else if (streamEvent.type === "content_block_delta" && delta.type === "text_delta") {
        await emitText(session, "agent.message", delta.text, payload, overrideTaskId);
      } else if (streamEvent.type === "content_block_start") {
        const block = parseObject(streamEvent.content_block);
        if (block.type === "tool_use") {
          await handleTool(session, block, payload, overrideTaskId);
        }
      }
      return;
    }

    const item = isObject(payload.item) ? payload.item : payload;
    await handleGenericItem(session, item, payload, overrideTaskId);
  }

  async function handleSocketFrame(session, message) {
    let decoded;
    try {
      decoded = await decodeSocketMessage(message);
    } catch (error) {
      log("debug", "Ignored malformed Reflex WebSocket frame", {
        roomId: session.roomId,
        agentId: session.agentId,
        error: errorMessage(error),
      });
      return;
    }
    if (!isObject(decoded)) return;
    if (decoded.type === "error") {
      log("warn", "Reflex WebSocket reported an error", {
        roomId: session.roomId,
        agentId: session.agentId,
        error: textFrom(decoded.message) || "unknown error",
      });
      return;
    }
    await mapEvent(session, decoded);
  }

  function scheduleReconnect(session) {
    if (!reconnect || adapterClosed || session.closed || session.reconnectTimer) return;
    const delay = session.reconnectDelay;
    session.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      connectSession(session);
    }, delay);
    session.reconnectTimer.unref?.();
  }

  function connectSession(session) {
    if (adapterClosed || session.closed) return;
    if (typeof webSocketFactory !== "function") {
      log("warn", "WebSocket is unavailable for Reflex agent", {
        roomId: session.roomId,
        agentId: session.agentId,
      });
      return;
    }

    let socket;
    try {
      const endpoint = new URL(wsUrl);
      endpoint.searchParams.set("token", apiKey);
      endpoint.searchParams.set("organizationId", organizationId);
      socket = webSocketFactory(endpoint.toString());
    } catch (error) {
      log("warn", "Could not open Reflex WebSocket", {
        roomId: session.roomId,
        agentId: session.agentId,
        error: errorMessage(error),
      });
      scheduleReconnect(session);
      return;
    }
    session.socket = socket;

    socketOn(socket, "open", () => {
      if (session.socket !== socket || session.closed || adapterClosed) return;
      session.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      try {
        socket.send(JSON.stringify({ type: "subscribe", streamId: session.streamId }));
      } catch (error) {
        log("warn", "Could not subscribe to Reflex stream", {
          roomId: session.roomId,
          agentId: session.agentId,
          error: errorMessage(error),
        });
      }
    });
    socketOn(socket, "message", (message) => {
      if (session.socket !== socket || session.closed || adapterClosed) return;
      session.frameChain = session.frameChain
        .then(() => handleSocketFrame(session, message))
        .catch((error) => {
          log("warn", "Reflex frame mapping failed", {
            roomId: session.roomId,
            agentId: session.agentId,
            error: errorMessage(error),
          });
        });
    });
    socketOn(socket, "close", () => {
      if (session.socket !== socket) return;
      session.socket = null;
      scheduleReconnect(session);
    });
    socketOn(socket, "error", (error) => {
      if (session.socket !== socket) return;
      log("debug", "Reflex WebSocket error", {
        roomId: session.roomId,
        agentId: session.agentId,
        error: errorMessage(error),
      });
    });
  }

  async function createAgent(room, agentSpec, callbacks = {}) {
    const emit = typeof callbacks.emit === "function" ? callbacks.emit : async () => {};
    const roomId = nonemptyString(room?.roomId);
    const agentId = nonemptyString(agentSpec?.agentId);
    const goal = nonemptyString(room?.goal);
    if (!roomId || !agentId || !goal) {
      await emitUnavailable(emit, roomId, agentId, "roomId, agentId, and goal are required");
      return null;
    }
    if (!configured) {
      await emitUnavailable(emit, roomId, agentId, "Reflex credentials are not configured");
      return null;
    }
    if (adapterClosed) {
      await emitUnavailable(emit, roomId, agentId, "the Reflex adapter is closed");
      return null;
    }

    let created;
    try {
      const response = await request("/agents", {
        name: `${nonemptyString(room.name) ?? roomId}-claude`,
        agentType: "claude-code",
        prompt: goal,
        authMethod: "claude-max",
      });
      if (!response.ok) {
        throw new Error(
          `Reflex create returned HTTP ${response.status}${response.text ? `: ${response.text.slice(0, 240)}` : ""}`,
        );
      }
      created = response.data;
    } catch (error) {
      if (adapterClosed) return null;
      const reason = errorMessage(error);
      await emitUnavailable(emit, roomId, agentId, reason);
      return null;
    }

    if (adapterClosed) return null;

    const reflexAgentId = nonemptyString(created?.id);
    const streamId = nonemptyString(created?.streamId);
    if (!reflexAgentId || !streamId) {
      await emitUnavailable(
        emit,
        roomId,
        agentId,
        "Reflex returned an agent without id and streamId",
      );
      return null;
    }

    const session = {
      roomId,
      agentId,
      reflexAgentId,
      streamId,
      emit,
      socket: null,
      closed: false,
      reconnectTimer: null,
      reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
      frameChain: Promise.resolve(),
      seenEventIds: new Set(),
      lastSequence: -1,
      pendingTasks: [
        {
          taskId: `reflex:${reflexAgentId}:initial`,
          text: goal,
        },
      ],
      activeTask: null,
      turnTasks: new Map(),
      toolCalls: new Map(),
      turnTokens: 0,
      lastCumulativeCostUsd: 0,
      lastCompletedTaskId: null,
      lastCompletedAt: 0,
      syntheticTurn: 0,
    };
    sessions.set(reflexAgentId, session);
    connectSession(session);
    return { reflexAgentId, streamId };
  }

  async function steer(reflexAgentId, text, context = {}) {
    const id = nonemptyString(reflexAgentId);
    const message = nonemptyString(text);
    const session = id ? sessions.get(id) : null;
    if (!session) return { ok: false, error: "Reflex agent is not registered" };
    if (!message) return { ok: false, error: "A Reflex steer needs text" };
    if (adapterClosed || session.closed) {
      return { ok: false, error: "Reflex adapter is closed" };
    }

    const contextAgentId = nonemptyString(context.agentId);
    if (contextAgentId) session.agentId = contextAgentId;
    const task = {
      taskId:
        nonemptyString(context.taskId) ??
        `reflex:${session.reflexAgentId}:steer:${Date.now()}`,
      text: message,
      roomId: nonemptyString(context.roomId) ?? session.roomId,
    };
    session.pendingTasks.push(task);

    let response;
    try {
      response = await request(`/agents/${encodeURIComponent(session.reflexAgentId)}/message`, {
        message,
      });
      if (!response.ok && response.status >= 400 && response.status < 500) {
        const queued = await request(
          `/agents/${encodeURIComponent(session.reflexAgentId)}/queue`,
          { text: message },
        );
        if (queued.ok) return { ok: true, queued: true, status: queued.status };
        response = queued;
      }
      if (response.ok) return { ok: true, queued: false, status: response.status };
    } catch (error) {
      response = { status: 0, text: errorMessage(error) };
    }

    const index = session.pendingTasks.indexOf(task);
    if (index !== -1) session.pendingTasks.splice(index, 1);
    const detail = `Reflex steer failed${response.status ? ` (HTTP ${response.status})` : ""}${response.text ? `: ${String(response.text).slice(0, 240)}` : ""}`;
    log("warn", detail, {
      roomId: task.roomId,
      agentId: session.agentId,
      reflexAgentId: session.reflexAgentId,
    });
    return { ok: false, status: response.status, error: detail };
  }

  async function close() {
    if (adapterClosed) return;
    adapterClosed = true;
    closeController.abort(new Error("Reflex adapter closed"));
    const pending = [];
    for (const session of sessions.values()) {
      session.closed = true;
      if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
      }
      const socket = session.socket;
      session.socket = null;
      if (socket) {
        try {
          socket.close(1000, "Ensemble server shutting down");
        } catch {
          try {
            socket.close();
          } catch {
            // Already closed.
          }
        }
      }
      pending.push(session.frameChain);
    }
    sessions.clear();
    await Promise.allSettled(pending);
  }

  return Object.freeze({ configured, createAgent, steer, close });
}
