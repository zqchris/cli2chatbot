import type { RuntimeKind, StreamEvent } from "../domain/types.js";

function getNestedText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const merged = value
      .map((item) => getNestedText(item))
      .filter((item): item is string => Boolean(item))
      .join(" ")
      .trim();
    return merged || null;
  }
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    return (
      getNestedText(candidate.aggregated_output) ??
      getNestedText(candidate.item) ??
      getNestedText(candidate.text) ??
      getNestedText(candidate.delta) ??
      getNestedText(candidate.message) ??
      getNestedText(candidate.msg) ??
      getNestedText(candidate.content) ??
      null
    );
  }
  return null;
}

function normalizeCommandExecution(taskId: string, item: Record<string, unknown>, timestamp: string): StreamEvent | null {
  const output = getNestedText(item.aggregated_output)?.trim() ?? "";
  if (!output) {
    return null;
  }
  return { type: "tool_event", taskId, text: output, timestamp };
}

function shouldIgnoreCodexMessage(text: string): boolean {
  return (
    text.includes("Under-development features enabled: fast_mode") ||
    text.includes("codex_core::shell_snapshot: Failed to delete shell snapshot") ||
    text.includes("WARN sqlx::query: slow statement:")
  );
}

function normalizeCodexPayload(taskId: string, payload: Record<string, unknown>, timestamp: string): StreamEvent | null {
  const type = String(payload.type ?? "").toLowerCase();

  if (type === "thread.started" || type === "turn.started" || type === "turn.completed" || type === "item.started") {
    return null;
  }

  if (type === "error") {
    const text = (getNestedText(payload.error) ?? getNestedText(payload.message) ?? getNestedText(payload.item) ?? "").trim();
    if (!text) {
      return null;
    }
    if (shouldIgnoreCodexMessage(text)) {
      return null;
    }
    return { type: "error", taskId, text, timestamp };
  }

  if (type !== "item.completed") {
    return null;
  }

  const item = payload.item;
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const itemType = String(record.type ?? "").toLowerCase();
  if (itemType === "command_execution") {
    return normalizeCommandExecution(taskId, record, timestamp);
  }
  if (itemType === "agent_message") {
    const text = (getNestedText(record.text) ?? getNestedText(record.message) ?? getNestedText(record.content) ?? "").trim();
    if (!text) {
      return null;
    }
    return { type: "final_text", taskId, text, timestamp };
  }
  if (itemType === "message") {
    const role = String(record.role ?? "").toLowerCase();
    if (role && role !== "assistant") {
      return null;
    }
    const text = (getNestedText(record.text) ?? getNestedText(record.message) ?? getNestedText(record.content) ?? "").trim();
    if (!text) {
      return null;
    }
    return { type: "final_text", taskId, text, timestamp };
  }
  if (itemType === "error" || itemType.includes("error") || itemType.includes("fail")) {
    const text = (getNestedText(record.message) ?? getNestedText(record.text) ?? "Runtime error").trim();
    if (shouldIgnoreCodexMessage(text)) {
      return null;
    }
    return { type: "error", taskId, text, timestamp };
  }
  return null;
}

function normalizeClaudePayload(taskId: string, payload: Record<string, unknown>, timestamp: string): StreamEvent | null {
  const type = String(payload.type ?? "").toLowerCase();
  if (type === "system") {
    return null;
  }

  if (type === "stream_event") {
    const event = payload.event as Record<string, unknown> | undefined;
    const eventType = String(event?.type ?? "").toLowerCase();
    if (eventType === "content_block_delta") {
      const delta = event?.delta as Record<string, unknown> | undefined;
      const text = getNestedText(delta?.text) ?? getNestedText(delta) ?? "";
      if (text.length === 0) {
        return null;
      }
      return { type: "partial_text", taskId, text, timestamp };
    }
    return null;
  }

  if (type === "result") {
    if (payload.is_error === true) {
      const errorText = (getNestedText(payload.result) ?? getNestedText(payload.error) ?? "Runtime error").trim();
      return { type: "error", taskId, text: errorText, timestamp };
    }
    const resultText = (getNestedText(payload.result) ?? "").trim();
    if (resultText) {
      return { type: "final_text", taskId, text: resultText, timestamp };
    }
    return null;
  }

  const fallbackText = (getNestedText(payload.text) ?? getNestedText(payload.message) ?? "").trim();
  if (!fallbackText) {
    return null;
  }
  return { type: "partial_text", taskId, text: fallbackText, timestamp };
}

function shouldIgnorePlainLine(runtime: RuntimeKind, line: string): boolean {
  if (runtime === "codex") {
    return (
      line.includes("Under-development features enabled: fast_mode") ||
      line.includes("PTY unavailable, fallback to stdio spawn") ||
      line.includes("posix_spawnp failed") ||
      line.includes("Tool loaded.") ||
      line.includes("Body cannot be empty when content-type is set to 'application/json'") ||
      line.includes("codex_core::shell_snapshot: Failed to delete shell snapshot") ||
      line.includes("WARN sqlx::query: slow statement:")
    );
  }
  if (runtime === "claude") {
    return (
      line.includes("Tool loaded.") ||
      line.includes("Under-development features enabled: fast_mode")
    );
  }
  return false;
}

function normalizeLine(runtime: RuntimeKind, taskId: string, line: string, timestamp: string): StreamEvent | null {
  try {
    const payload = JSON.parse(line) as Record<string, unknown>;
    if (runtime === "claude") {
      return normalizeClaudePayload(taskId, payload, timestamp);
    }
    if (runtime === "codex") {
      return normalizeCodexPayload(taskId, payload, timestamp);
    }
    return null;
  } catch {
    if (shouldIgnorePlainLine(runtime, line)) {
      return null;
    }
    if (runtime === "codex") {
      // codex is expected to emit line-oriented JSON; plain text is usually transport noise.
      return null;
    }
    if (!line.trim()) {
      return null;
    }
    return { type: "partial_text", taskId, text: line, timestamp };
  }
}

export function normalizeRuntimeChunk(runtime: RuntimeKind, taskId: string, chunk: string): StreamEvent[] {
  const timestamp = new Date().toISOString();
  const lines = chunk
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }

  if (runtime === "codex" || runtime === "claude") {
    return lines
      .map((line) => normalizeLine(runtime, taskId, line, timestamp))
      .filter((event): event is StreamEvent => Boolean(event));
  }

  return lines.map((line) => ({ type: "partial_text", taskId, text: line, timestamp }));
}
