import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeApp } from "../src/app.js";
import { createDefaultConfig } from "../src/config.js";
import type { AppConfig, RuntimeKind } from "../src/domain/types.js";
import { InstanceSupervisor } from "../src/runtime/supervisor.js";
import { StateStore } from "../src/store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function buildTempPaths(rootDir: string) {
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
        first_name: "Tester",
        username: "tester"
      }
    }
  };
}

async function createIsolatedApp(allowedUserId: string): Promise<any> {
  const config: AppConfig = createDefaultConfig({
    telegram: {
      botToken: "test-token",
      allowedUserIds: [allowedUserId],
      pollingMode: "long-polling"
    }
  });
  const app = new BridgeApp(config) as any;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cli2chatbot-app-test-"));
  tempDirs.push(tempDir);
  const paths = buildTempPaths(tempDir);
  app.store = new StateStore(paths);
  app.supervisor = new InstanceSupervisor(app.store, config);
  return app;
}

describe("telegram command handling", () => {
  it("returns usage and available instances for bare /use command", async () => {
    const userId = "10001";
    const chatId = userId;
    const app = await createIsolatedApp(userId);
    const messages: string[] = [];
    app.telegram = {
      sendMessage: async (_chatId: string, text: string) => {
        messages.push(text);
        return { message_id: messages.length };
      },
      editMessageText: async () => ({ message_id: 1 }),
      sendTyping: async () => true
    };

    const created = await app.createInstance("codex" satisfies RuntimeKind);
    await app.handleUpdate(makeTelegramUpdate(1, userId, chatId, "/use"));

    expect(messages.at(-1)).toContain("用法：/use <instanceId>");
    expect(messages.at(-1)).toContain(created.instanceId);
    expect(messages.at(-1)).not.toContain("未知命令");
  });
});
