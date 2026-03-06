import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppPaths } from "../src/config.js";
import { acquireDaemonLock } from "../src/daemon-lock.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createPaths(rootDir: string): AppPaths {
  return {
    rootDir,
    configFile: path.join(rootDir, "config.json"),
    stateFile: path.join(rootDir, "state.json"),
    logFile: path.join(rootDir, "events.log"),
    daemonPidFile: path.join(rootDir, "daemon.pid")
  };
}

describe("daemon lock", () => {
  it("writes pid file and cleans up on release", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli2chatbot-daemon-"));
    tempDirs.push(dir);
    const lock = await acquireDaemonLock(createPaths(dir));
    const pidText = (await readFile(path.join(dir, "daemon.pid"), "utf8")).trim();
    expect(Number.parseInt(pidText, 10)).toBe(lock.pid);
    await lock.release();
    await expect(readFile(path.join(dir, "daemon.pid"), "utf8")).rejects.toBeTruthy();
  });

  it("replaces stale pid file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli2chatbot-daemon-"));
    tempDirs.push(dir);
    const paths = createPaths(dir);
    await writeFile(paths.daemonPidFile, "999999\n", "utf8");
    const lock = await acquireDaemonLock(paths);
    expect(lock.pid).toBe(process.pid);
    await lock.release();
  });

  it("rejects when another live daemon pid exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cli2chatbot-daemon-"));
    tempDirs.push(dir);
    const paths = createPaths(dir);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      detached: false
    });
    try {
      await writeFile(paths.daemonPidFile, `${child.pid}\n`, "utf8");
      await expect(acquireDaemonLock(paths)).rejects.toThrow(/already running/i);
    } finally {
      child.kill("SIGTERM");
    }
  });
});
