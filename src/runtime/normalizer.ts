import type { RuntimeKind, StreamEvent } from "../domain/types.js";

export function normalizeRuntimeChunk(runtime: RuntimeKind, taskId: string, chunk: string): StreamEvent[] {
  const timestamp = new Date().toISOString();
  const trimmed = chunk.trim();
  if (!trimmed) {
    return [];
  }

  if (runtime === "codex") {
    const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const events: StreamEvent[] = [];
    for (const line of lines) {
      try {
        const payload = JSON.parse(line) as Record<string, unknown>;
        const text =
          typeof payload.msg === "string"
            ? payload.msg
            : typeof payload.message === "string"
              ? payload.message
              : typeof payload.content === "string"
                ? payload.content
                : JSON.stringify(payload);
        events.push({ type: "partial_text", taskId, text, timestamp });
      } catch {
        events.push({ type: "partial_text", taskId, text: line, timestamp });
      }
    }
    return events;
  }

  const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      const text =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.delta === "string"
            ? payload.delta
            : typeof payload.message === "string"
              ? payload.message
              : JSON.stringify(payload);
      return { type: "partial_text", taskId, text, timestamp } satisfies StreamEvent;
    } catch {
      return { type: "partial_text", taskId, text: line, timestamp } satisfies StreamEvent;
    }
  });
}
