import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeApp } from "./app.js";
import type { AppPaths } from "./config.js";
import { loadConfig } from "./config.js";
import type { AppConfig, RuntimeKind, TaskStatus } from "./domain/types.js";
import { InstanceSupervisor } from "./runtime/supervisor.js";
import { StateStore } from "./store.js";

type SmokeMessage = {
  id: number;
  text: string;
};

export type SmokeRunResult = {
  runtime: RuntimeKind;
  ok: boolean;
  status: TaskStatus | "timeout" | "setup_failed";
  message: string;
  leakedRawEvents: boolean;
  messages: SmokeMessage[];
};

function buildTempPaths(rootDir: string): AppPaths {
  return {
    rootDir,
    configFile: path.join(rootDir, "config.json"),
    stateFile: path.join(rootDir, "state.json"),
    logFile: path.join(rootDir, "events.log"),
    daemonPidFile: path.join(rootDir, "daemon.pid")
  };
}

function makeTelegramUpdate(updateId: number, userId: string, chatId: string, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: {
        id: Number(chatId),
        type: "private"
      },
      from: {
        id: Number(userId),
        is_bot: false,
        first_name: "Smoke",
        username: "smoke_tester"
      }
    }
  };
}

function hasRawEventLeak(text: string): boolean {
  return /command_execution|item\.started|item\.completed|thread\.started|turn\.started|stream_event|content_block_delta|\/bin\/zsh -lc/.test(text);
}

async function waitForTaskCompletion(
  app: any,
  timeoutMs: number
): Promise<{ status: TaskStatus | "timeout"; message: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await app.store.read();
    const task = state.tasks[0];
    if (!task) {
      await delay(200);
      continue;
    }
    if (task.status !== "running") {
      const text = task.outputPreview.trim() || task.error || "";
      return { status: task.status, message: text };
    }
    await delay(300);
  }
  return { status: "timeout", message: "Task did not finish before timeout." };
}

export async function runSmoke(runtime: RuntimeKind, timeoutMs: number): Promise<SmokeRunResult> {
  const baseConfig = await loadConfig();
  const userId = baseConfig.telegram.allowedUserIds[0] ?? "999001";
  const chatId = userId;
  const config: AppConfig = {
    ...baseConfig,
    telegram: {
      ...baseConfig.telegram,
      allowedUserIds: [userId]
    }
  };

  const app = new BridgeApp(config) as any;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cli2chatbot-smoke-"));
  const paths = buildTempPaths(tempDir);
  const messages: SmokeMessage[] = [];
  let nextMessageId = 1;
  let updateId = 1000;

  app.store = new StateStore(paths);
  app.supervisor = new InstanceSupervisor(app.store, config);
  app.telegram = {
    sendMessage: async (_chatId: string, text: string) => {
      const id = nextMessageId++;
      messages.push({ id, text });
      return { message_id: id };
    },
    editMessageText: async (_chatId: string, messageId: number, text: string) => {
      const found = messages.find((message) => message.id === messageId);
      if (found) {
        found.text = text;
      } else {
        messages.push({ id: messageId, text });
      }
      return { message_id: messageId };
    },
    sendTyping: async () => true
  };

  try {
    await app.handleUpdate(makeTelegramUpdate(updateId++, userId, chatId, runtime === "codex" ? "/start_codex" : "/start_claude"));
    await app.handleUpdate(makeTelegramUpdate(updateId++, userId, chatId, "/ask Reply with one short line saying smoke ok."));

    const completion = await waitForTaskCompletion(app, timeoutMs);
    const message = messages.map((item) => item.text).join("\n");
    const leakedRawEvents = hasRawEventLeak(message);

    return {
      runtime,
      ok: completion.status === "success" && !leakedRawEvents,
      status: completion.status,
      message: completion.message,
      leakedRawEvents,
      messages
    };
  } catch (error) {
    return {
      runtime,
      ok: false,
      status: "setup_failed",
      message: String(error),
      leakedRawEvents: false,
      messages
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
