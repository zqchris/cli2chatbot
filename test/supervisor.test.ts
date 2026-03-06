import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config.js";
import { StateStore } from "../src/store.js";
import { InstanceSupervisor } from "../src/runtime/supervisor.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("instance supervisor", () => {
  it("creates instances and switches current runtime", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli2chatbot-"));
    tempDirs.push(dir);
    const store = new StateStore({
      rootDir: dir,
      configFile: path.join(dir, "config.json"),
      stateFile: path.join(dir, "state.json"),
      logFile: path.join(dir, "events.log")
    });
    const supervisor = new InstanceSupervisor(
      store,
      createDefaultConfig({
        telegram: { botToken: "token", allowedUserIds: ["1"], pollingMode: "long-polling" }
      })
    );
    const instance = await supervisor.createInstance("codex");
    expect(instance.runtime).toBe("codex");
    const current = await supervisor.currentInstance("codex");
    expect(current?.instanceId).toBe(instance.instanceId);
  });
});
