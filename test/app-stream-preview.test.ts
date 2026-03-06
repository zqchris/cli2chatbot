import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../src/domain/types.js";
import { formatTelegramDisplayChunk, mergeDraftText } from "../src/app.js";

function eventOf(event: Omit<StreamEvent, "taskId" | "timestamp">): StreamEvent {
  return {
    ...event,
    taskId: "task-1",
    timestamp: new Date().toISOString()
  } as StreamEvent;
}

describe("telegram stream preview", () => {
  it("preserves partial text whitespace while streaming", () => {
    let draft = "";
    for (const chunk of ["hello", " ", "world"]) {
      const preview = formatTelegramDisplayChunk(eventOf({ type: "partial_text", text: chunk }));
      draft = mergeDraftText(draft, preview ?? "", "partial_text");
    }

    expect(draft).toBe("hello world");
  });

  it("formats tool events as compact preview blocks", () => {
    const preview = formatTelegramDisplayChunk(
      eventOf({
        type: "tool_event",
        text: "/tmp\nline-2\nline-3\nline-4\nline-5\nline-6\nline-7\nline-8\nline-9"
      })
    );

    expect(preview).toContain("🔧 工具输出");
    expect(preview).toContain("/tmp");
    expect(preview).toContain("省略 1 行");
  });

  it("uses sanitized final text as preview content", () => {
    const preview = formatTelegramDisplayChunk(
      eventOf({
        type: "final_text",
        text: "真正结果\n\nTool loaded.\n"
      })
    );

    expect(preview).toBe("真正结果");
  });
});
