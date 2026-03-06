import type { RuntimeKind, StreamEvent } from "../domain/types.js";

type NormalizedTextEventType = "partial_text" | "tool_event" | "status" | "final_text" | "error";

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
      const text = (getNestedText(delta?.text) ?? getNestedText(delta) ?? "").trim();
      if (!text) {
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

function classifyPayloadType(payload: Record<string, unknown>): NormalizedTextEventType {
  const item = payload.item;
  if (item && typeof item === "object") {
    const nestedType = String((item as Record<string, unknown>).type ?? "").toLowerCase();
    if (nestedType === "agent_message") {
      return "final_text";
    }
    if (nestedType === "command_execution") {
      return "tool_event";
    }
    if (nestedType.includes("tool")) {
      return "tool_event";
    }
    if (nestedType.includes("error") || nestedType.includes("fail")) {
      return "error";
    }
  }
  const maybeType = String(payload.type ?? payload.event ?? "").toLowerCase();
  if (payload.error || maybeType.includes("error") || maybeType.includes("fail")) {
    return "error";
  }
  if (payload.final === true || maybeType.includes("final") || maybeType.includes("done")) {
    return "final_text";
  }
  if (maybeType.includes("tool")) {
    return "tool_event";
  }
  if (maybeType.includes("status") || maybeType.includes("progress") || maybeType.includes("state")) {
    return "status";
  }
  return "partial_text";
}

function shouldIgnoreCodexPayload(payload: Record<string, unknown>): boolean {
  const type = String(payload.type ?? payload.event ?? "").toLowerCase();
  if (type === "thread.started" || type === "turn.started" || type === "turn.completed") {
    return true;
  }
  const item = payload.item;
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const message = getNestedText(record.message) ?? getNestedText(record.text) ?? "";
    if (
      record.type === "error" &&
      message.includes("Under-development features enabled: fast_mode")
    ) {
      return true;
    }
  }
  return false;
}

function shouldIgnorePlainLine(runtime: RuntimeKind, line: string): boolean {
  if (runtime !== "codex") {
    return false;
  }
  return (
    line.includes("codex_core::shell_snapshot: Failed to delete shell snapshot") ||
    line.includes("WARN sqlx::query: slow statement:")
  );
}

function normalizeLine(runtime: RuntimeKind, taskId: string, line: string, timestamp: string): StreamEvent | null {
  try {
    const payload = JSON.parse(line) as Record<string, unknown>;
    if (runtime === "claude") {
      return normalizeClaudePayload(taskId, payload, timestamp);
    }
    if (runtime === "codex" && shouldIgnoreCodexPayload(payload)) {
      return null;
    }
    const item = payload.item;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (String(record.type ?? "").toLowerCase() === "command_execution") {
        return normalizeCommandExecution(taskId, record, timestamp);
      }
    }
    const type = classifyPayloadType(payload);
    const fallbackText = payload.error ? String(payload.error) : JSON.stringify(payload);
    const text = (getNestedText(payload) ?? fallbackText).trim();
    return { type, taskId, text, timestamp };
  } catch {
    if (shouldIgnorePlainLine(runtime, line)) {
      return null;
    }
    return { type: "partial_text", taskId, text: line.trim(), timestamp };
  }
}

export function normalizeRuntimeChunk(runtime: RuntimeKind, taskId: string, chunk: string): StreamEvent[] {
  const timestamp = new Date().toISOString();
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  // Runtime-aware parser selection can be expanded later.
  // For now, both runtimes are line-oriented JSON streams with text fallback.
  if (runtime === "codex" || runtime === "claude") {
    return lines
      .map((line) => normalizeLine(runtime, taskId, line, timestamp))
      .filter((event): event is StreamEvent => Boolean(event));
  }

  return lines.map((line) => ({ type: "partial_text", taskId, text: line, timestamp }));
}
