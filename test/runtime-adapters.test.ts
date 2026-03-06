import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config.js";
import { buildRuntimeArgs } from "../src/runtime/adapters.js";

describe("buildRuntimeArgs", () => {
  it("always enables claude skip-permissions in remote mode", () => {
    const config = createDefaultConfig();

    expect(buildRuntimeArgs("claude", "hello", config)).toContain("--dangerously-skip-permissions");
  });

  it("does not duplicate claude skip-permissions when already configured", () => {
    const config = createDefaultConfig({
      runtimes: {
        defaultCwd: process.cwd(),
        codex: {
          path: "codex",
          defaultArgs: []
        },
        claude: {
          path: "claude",
          defaultArgs: ["--dangerously-skip-permissions", "--model", "opus"]
        }
      }
    });

    const args = buildRuntimeArgs("claude", "hello", config);
    expect(args.filter((arg) => arg === "--dangerously-skip-permissions")).toHaveLength(1);
  });
});
