import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  it("routes plain text to current instance ask flow", async () => {
    const userId = "10002";
    const chatId = userId;
    const app = await createIsolatedApp(userId);
    const sentTexts: string[] = [];
    const sentOptions: Array<Record<string, unknown> | undefined> = [];
    const editedTexts: string[] = [];
    const askCalls: Array<{ instanceId: string; prompt: string }> = [];
    app.telegram = {
      sendMessage: async (_chatId: string, text: string, options?: Record<string, unknown>) => {
        sentTexts.push(text);
        sentOptions.push(options);
        return { message_id: 1 };
      },
      editMessageText: async (_chatId: string, _messageId: number, text: string) => {
        editedTexts.push(text);
        return { message_id: 1 };
      },
      sendTyping: async () => true
    };

    app.supervisor = {
      selectedInstance: async () => ({
        instanceId: "inst-codex-1",
        runtime: "codex",
        status: "idle",
        cwd: process.cwd()
      }),
      ask: async (
        instanceId: string,
        prompt: string,
        onEvent: (event: { type: string; taskId: string; text?: string; code?: number | null; timestamp: string }) => Promise<void>
      ) => {
        askCalls.push({ instanceId, prompt });
        const timestamp = new Date().toISOString();
        await onEvent({ type: "task_started", taskId: "task-1", timestamp });
        await onEvent({ type: "final_text", taskId: "task-1", text: "自动路由成功", timestamp });
        await onEvent({ type: "exit", taskId: "task-1", code: 0, timestamp });
        return { taskId: "task-1" };
      }
    };

    await app.handleUpdate(makeTelegramUpdate(2, userId, chatId, "帮我看看当前仓库结构"));

    expect(askCalls).toHaveLength(1);
    expect(askCalls[0]?.instanceId).toBe("inst-codex-1");
    expect(askCalls[0]?.prompt).toBe("帮我看看当前仓库结构");
    expect(sentTexts[0]).toContain("已接收任务，正在发送到 codex:inst-codex-1");
    expect(sentOptions[0]).toMatchObject({ replyToMessageId: 2 });
    expect(editedTexts.at(-1)).toContain("自动路由成功");
  });

  it("keeps unknown slash command behavior", async () => {
    const userId = "10003";
    const chatId = userId;
    const app = await createIsolatedApp(userId);
    const messages: string[] = [];
    app.telegram = {
      sendMessage: async (_chatId: string, text: string) => {
        messages.push(text);
        return { message_id: 1 };
      },
      editMessageText: async () => ({ message_id: 1 }),
      sendTyping: async () => true
    };

    await app.handleUpdate(makeTelegramUpdate(3, userId, chatId, "/unknown"));

    expect(messages.at(-1)).toBe("未知命令，使用 /help 查看帮助。");
  });

  it("shows model usage on bare /model and applies model to current runtime", async () => {
    const userId = "10004";
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

    await app.createInstance("codex");
    await app.handleUpdate(makeTelegramUpdate(4, userId, chatId, "/model"));
    await app.handleUpdate(makeTelegramUpdate(5, userId, chatId, "/model gpt-5"));

    expect(messages[0]).toContain("当前 runtime: codex");
    expect(messages[0]).toContain("/model <model>");
    expect(messages[1]).toContain("已设置 codex 模型：gpt-5");
    expect(app.config.runtimes.codex.defaultArgs).toEqual(["--model", "gpt-5"]);
  });

  it("supports /model default to clear model arg", async () => {
    const userId = "10005";
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

    await app.createInstance("claude");
    await app.handleUpdate(makeTelegramUpdate(6, userId, chatId, "/model claude opus"));
    await app.handleUpdate(makeTelegramUpdate(7, userId, chatId, "/model default"));

    expect(messages[0]).toContain("已设置 claude 模型：opus");
    expect(messages[1]).toContain("已清除 claude 模型参数");
    expect(app.config.runtimes.claude.defaultArgs).toEqual([]);
  });

  it("supports /cwd to update selected instance working directory", async () => {
    const userId = "10006";
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

    const instance = await app.createInstance("codex");
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "cli2chatbot-cwd-"));
    tempDirs.push(targetDir);
    await app.handleUpdate(makeTelegramUpdate(8, userId, chatId, `/cwd ${targetDir}`));

    const updated = await app.supervisor.getInstance(instance.instanceId);
    expect(updated.cwd).toBe(targetDir);
    expect(messages.at(-1)).toContain("已设置 codex");
  });

  it("lists and revokes authorized users", async () => {
    const userId = "10007";
    const chatId = userId;
    const app = await createIsolatedApp(userId);
    app.telegram = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => ({ message_id: 1 }),
      sendTyping: async () => true
    };

    await app.handleUpdate(makeTelegramUpdate(9, userId, chatId, "/status"));
    const before = await app.commandAuthorizedUsers();
    expect(before.ok).toBe(true);
    expect(before.data?.some((item: { userId: string }) => item.userId === userId)).toBe(true);

    const revoked = await app.commandRevokeAuth(userId);
    expect(revoked.ok).toBe(true);
    const after = await app.commandAuthorizedUsers();
    expect(after.data).toEqual([]);

    const raw = await readFile(app.store.paths.configFile, "utf8");
    const config = JSON.parse(raw) as { telegram?: { botToken?: string; allowedUserIds?: string[] } };
    expect(config.telegram?.botToken).toBe("test-token");
    expect(config.telegram?.allowedUserIds ?? []).toEqual([]);
  });
});
