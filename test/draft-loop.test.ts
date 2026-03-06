import { describe, expect, it, vi } from "vitest";
import { createDraftStreamLoop } from "../src/telegram/draft-loop.js";

describe("draft stream loop", () => {
  it("flushes the latest text", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const loop = createDraftStreamLoop({
      throttleMs: 100,
      isStopped: () => false,
      sendOrEditStreamMessage: async (text) => {
        sent.push(text);
      }
    });

    loop.update("a");
    loop.update("b");
    await vi.advanceTimersByTimeAsync(120);
    expect(sent.at(-1)).toBe("b");
    vi.useRealTimers();
  });
});
