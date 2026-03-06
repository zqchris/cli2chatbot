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
      '{"type":"system","subtype":"init"}\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}\n{"type":"result","subtype":"success","result":"done"}\n'
    );
    expect(events.map((event) => event.type)).toEqual(["partial_text", "final_text"]);
    expect(events[0]?.type === "partial_text" ? events[0].text : "").toBe("hello");
    expect(events[1]?.type === "final_text" ? events[1].text : "").toBe("done");
  });

  it("falls back to partial_text for plain lines", () => {
    const events = normalizeRuntimeChunk("claude", "task1", "plain line\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("partial_text");
    expect(events[0]?.type === "partial_text" ? events[0].text : "").toBe("plain line");
  });

  it("filters codex transport noise and internal warnings", () => {
    const events = normalizeRuntimeChunk(
      "codex",
      "task1",
      [
        '{"type":"thread.started","thread_id":"abc"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Under-development features enabled: fast_mode. Under-development features are incomplete and may behave unpredictably."}}',
        '2026-03-06T06:49:37Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot',
        '{"type":"turn.started"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"message","message":"真正结果"}}'
      ].join("\n")
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("partial_text");
    expect(events[0]?.type === "partial_text" ? events[0].text : "").toContain("真正结果");
  });

  it("extracts codex agent_message text and drops turn completion stats", () => {
    const events = normalizeRuntimeChunk(
      "codex",
      "task1",
      [
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"真正结果"}}',
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
      ].join("\n")
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("final_text");
    expect(events[0]?.type === "final_text" ? events[0].text : "").toBe("真正结果");
  });

  it("keeps only command output for codex command_execution events", () => {
    const events = normalizeRuntimeChunk(
      "codex",
      "task1",
      [
        '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"pwd","aggregated_output":"","status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"pwd","aggregated_output":"/Users/zkyo\\n","status":"completed"}}'
      ].join("\n")
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool_event");
    expect(events[0]?.type === "tool_event" ? events[0].text : "").toBe("/Users/zkyo");
  });
});
