import { readFile, unlink, writeFile } from "node:fs/promises";
import process from "node:process";
import type { AppPaths } from "./config.js";

export type DaemonLock = {
  pid: number;
  release: () => Promise<void>;
};

function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(paths: AppPaths): Promise<number | null> {
  try {
    const raw = (await readFile(paths.daemonPidFile, "utf8")).trim();
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

async function removePidFile(paths: AppPaths, expectedPid?: number): Promise<void> {
  if (typeof expectedPid === "number") {
    const current = await readPid(paths);
    if (current !== expectedPid) {
      return;
    }
  }
  try {
    await unlink(paths.daemonPidFile);
  } catch {
    // Ignore missing file and transient release errors.
  }
}

export async function acquireDaemonLock(paths: AppPaths): Promise<DaemonLock> {
  const existing = await readPid(paths);
  if (existing && existing !== process.pid && isPidRunning(existing)) {
    throw new Error(`Bridge daemon already running with pid ${existing}.`);
  }
  if (existing && !isPidRunning(existing)) {
    await removePidFile(paths);
  }

  try {
    await writeFile(paths.daemonPidFile, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const current = await readPid(paths);
    if (current && current !== process.pid && isPidRunning(current)) {
      throw new Error(`Bridge daemon already running with pid ${current}.`);
    }
    await removePidFile(paths);
    await writeFile(paths.daemonPidFile, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  }

  let released = false;
  return {
    pid: process.pid,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      await removePidFile(paths, process.pid);
    }
  };
}
