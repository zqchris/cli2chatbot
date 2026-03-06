import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, createDefaultState, saveConfig, loadConfig, loadState, saveState } from "../src/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config", () => {
  it("roundtrips config and state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli2chatbot-"));
    tempDirs.push(dir);
    const paths = {
      rootDir: dir,
      configFile: path.join(dir, "config.json"),
      stateFile: path.join(dir, "state.json"),
      logFile: path.join(dir, "events.log")
    };
    const config = createDefaultConfig({
      telegram: { botToken: "token", allowedUserIds: ["1"], pollingMode: "long-polling" }
    });
    await saveConfig(config, paths);
    expect((await loadConfig(paths)).telegram.botToken).toBe("token");

    const state = createDefaultState();
    state.daemon.pid = 123;
    await saveState(state, paths);
    expect((await loadState(paths)).daemon.pid).toBe(123);
  });
});
