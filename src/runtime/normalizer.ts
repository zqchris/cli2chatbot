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

function classifyPayloadType(payload: Record<string, unknown>): NormalizedTextEventType {
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

function normalizeLine(taskId: string, line: string, timestamp: string): StreamEvent {
  try {
    const payload = JSON.parse(line) as Record<string, unknown>;
    const type = classifyPayloadType(payload);
    const fallbackText = payload.error ? String(payload.error) : JSON.stringify(payload);
    const text = (getNestedText(payload) ?? fallbackText).trim();
    return { type, taskId, text, timestamp };
  } catch {
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
    return lines.map((line) => normalizeLine(taskId, line, timestamp));
  }

  return lines.map((line) => ({ type: "partial_text", taskId, text: line, timestamp }));
}
