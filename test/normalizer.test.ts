import { describe, expect, it } from "vitest";
import { normalizeRuntimeChunk } from "../src/runtime/normalizer.js";

describe("normalizeRuntimeChunk", () => {
  it("classifies codex tool and status events", () => {
    const events = normalizeRuntimeChunk(
      "codex",
      "task1",
      '{"msg":"hello"}\n{"type":"tool_call","message":"running shell"}\n{"type":"status","message":"progress"}\n'
    );
    expect(events.map((event) => event.type)).toEqual(["partial_text", "tool_event", "status"]);
  });

  it("maps explicit errors and final events", () => {
    const events = normalizeRuntimeChunk(
      "codex",
      "task1",
      '{"type":"error","error":"boom"}\n{"type":"final","text":"done"}\n'
    );
    expect(events.map((event) => event.type)).toEqual(["error", "final_text"]);
    expect(events[0]?.type === "error" ? events[0].text : "").toContain("boom");
  });

  it("classifies claude stream events", () => {
    const events = normalizeRuntimeChunk(
      "claude",
      "task1",
      '{"delta":"hello"}\n{"type":"status","text":"thinking"}\n{"type":"error","message":"bad"}\n'
    );
    expect(events.map((event) => event.type)).toEqual(["partial_text", "status", "error"]);
  });

  it("falls back to partial_text for plain lines", () => {
    const events = normalizeRuntimeChunk("claude", "task1", "plain line\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("partial_text");
    expect(events[0]?.type === "partial_text" ? events[0].text : "").toBe("plain line");
  });
});
