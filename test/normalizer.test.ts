import { describe, expect, it } from "vitest";
import { normalizeRuntimeChunk } from "../src/runtime/normalizer.js";

describe("normalizeRuntimeChunk", () => {
  it("normalizes codex jsonl output", () => {
    const events = normalizeRuntimeChunk("codex", "task1", '{"msg":"hello"}\n{"message":"world"}\n');
    expect(events.map((event) => event.type)).toEqual(["partial_text", "partial_text"]);
    expect(events.map((event) => event.type === "partial_text" ? event.text : "")).toEqual(["hello", "world"]);
  });

  it("normalizes claude stream json output", () => {
    const events = normalizeRuntimeChunk("claude", "task1", '{"delta":"hello"}\n{"text":"world"}\n');
    expect(events).toHaveLength(2);
  });
});
