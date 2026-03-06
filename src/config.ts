import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AppConfig, PersistedState } from "./domain/types.js";

const runtimeConfigSchema = z.object({
  path: z.string().min(1),
  defaultArgs: z.array(z.string()).default([])
});

const configSchema = z.object({
  telegram: z.object({
    botToken: z.string().min(1),
    allowedUserIds: z.array(z.string().min(1)).min(1),
    pollingMode: z.literal("long-polling").default("long-polling")
  }),
  runtimes: z.object({
    defaultCwd: z.string().min(1),
    codex: runtimeConfigSchema,
    claude: runtimeConfigSchema
  }),
  instances: z.object({
    maxRunningPerRuntime: z.number().int().positive().default(3),
    idleTimeoutMinutes: z.number().int().positive().default(180),
    autoCleanupOrphans: z.boolean().default(true)
  }),
  web: z.object({
    enabled: z.boolean().default(true),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().positive().default(4567)
  })
});

const stateSchema = z.object({
  currentInstanceId: z.string().nullable().default(null),
  currentInstanceByRuntime: z.object({
    codex: z.string().optional(),
    claude: z.string().optional()
  }).default({}),
  instances: z.array(z.any()).default([]),
  tasks: z.array(z.any()).default([]),
  daemon: z.object({
    pid: z.number().int().nullable().default(null),
    startedAt: z.string().nullable().default(null),
    lastHeartbeatAt: z.string().nullable().default(null)
  }).default({
    pid: null,
    startedAt: null,
    lastHeartbeatAt: null
  })
});

export type AppPaths = {
  rootDir: string;
  configFile: string;
  stateFile: string;
  logFile: string;
  daemonPidFile: string;
};

export function getAppPaths(): AppPaths {
  const rootDir = path.join(os.homedir(), ".cli2chatbot");
  return {
    rootDir,
    configFile: path.join(rootDir, "config.json"),
    stateFile: path.join(rootDir, "state.json"),
    logFile: path.join(rootDir, "events.log"),
    daemonPidFile: path.join(rootDir, "daemon.pid")
  };
}

export function createDefaultConfig(partial?: Partial<AppConfig>): AppConfig {
  return {
    telegram: {
      botToken: partial?.telegram?.botToken ?? "",
      allowedUserIds: partial?.telegram?.allowedUserIds ?? [],
      pollingMode: "long-polling"
    },
    runtimes: {
      defaultCwd: partial?.runtimes?.defaultCwd ?? process.cwd(),
      codex: {
        path: partial?.runtimes?.codex?.path ?? "codex",
        defaultArgs: partial?.runtimes?.codex?.defaultArgs ?? []
      },
      claude: {
        path: partial?.runtimes?.claude?.path ?? "claude",
        defaultArgs: partial?.runtimes?.claude?.defaultArgs ?? []
      }
    },
    instances: {
      maxRunningPerRuntime: partial?.instances?.maxRunningPerRuntime ?? 3,
      idleTimeoutMinutes: partial?.instances?.idleTimeoutMinutes ?? 180,
      autoCleanupOrphans: partial?.instances?.autoCleanupOrphans ?? true
    },
    web: {
      enabled: partial?.web?.enabled ?? true,
      host: partial?.web?.host ?? "127.0.0.1",
      port: partial?.web?.port ?? 4567
    }
  };
}

export function createDefaultState(): PersistedState {
  return {
    currentInstanceId: null,
    currentInstanceByRuntime: {},
    instances: [],
    tasks: [],
    daemon: {
      pid: null,
      startedAt: null,
      lastHeartbeatAt: null
    }
  };
}

export async function ensureAppDir(paths = getAppPaths()): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
}

export async function configExists(paths = getAppPaths()): Promise<boolean> {
  try {
    await access(paths.configFile);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(paths = getAppPaths()): Promise<AppConfig> {
  const raw = await readFile(paths.configFile, "utf8");
  return configSchema.parse(JSON.parse(raw));
}

export async function saveConfig(config: AppConfig, paths = getAppPaths()): Promise<void> {
  await ensureAppDir(paths);
  const parsed = configSchema.parse(config);
  await writeFile(paths.configFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export async function loadState(paths = getAppPaths()): Promise<PersistedState> {
  try {
    const raw = await readFile(paths.stateFile, "utf8");
    const parsed = stateSchema.parse(JSON.parse(raw));
    return {
      currentInstanceId: parsed.currentInstanceId,
      currentInstanceByRuntime: parsed.currentInstanceByRuntime,
      instances: parsed.instances as PersistedState["instances"],
      tasks: parsed.tasks as PersistedState["tasks"],
      daemon: parsed.daemon as PersistedState["daemon"]
    };
  } catch {
    return createDefaultState();
  }
}

export async function saveState(state: PersistedState, paths = getAppPaths()): Promise<void> {
  await ensureAppDir(paths);
  await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
