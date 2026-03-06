import { execFileSync } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import type { AppConfig, CommandResult, DoctorResult, InstanceRecord, PersistedState, RuntimeKind, StreamEvent } from "./domain/types.js";
import { ensureAppDir } from "./config.js";
import { StateStore } from "./store.js";
import { InstanceSupervisor } from "./runtime/supervisor.js";
import { TelegramApi } from "./telegram/api.js";
import { createDraftStreamLoop } from "./telegram/draft-loop.js";

type TelegramContext = {
  chatId: string;
  userId: string;
};

export class BridgeApp {
  readonly store: StateStore;
  readonly supervisor: InstanceSupervisor;
  readonly telegram: TelegramApi;
  private pollOffset: number | undefined;

  constructor(private readonly config: AppConfig) {
    this.store = new StateStore();
    this.supervisor = new InstanceSupervisor(this.store, config);
    this.telegram = new TelegramApi(config.telegram.botToken);
  }

  async doctor(): Promise<DoctorResult[]> {
    const checks: DoctorResult[] = [];
    try {
      await this.telegram.getMe();
      checks.push({ name: "telegram", ok: true, detail: "Bot token works." });
    } catch (error) {
      checks.push({ name: "telegram", ok: false, detail: String(error) });
    }

    for (const runtime of ["codex", "claude"] as const) {
      const file = runtime === "codex" ? this.config.runtimes.codex.path : this.config.runtimes.claude.path;
      try {
        execFileSync(file, ["--version"], { stdio: "pipe" });
        checks.push({ name: runtime, ok: true, detail: `${file} is executable.` });
      } catch (error) {
        checks.push({ name: runtime, ok: false, detail: String(error) });
      }
    }

    try {
      await ensureAppDir(this.store.paths);
      const tempFile = `${this.store.paths.rootDir}/doctor-${randomUUID()}.tmp`;
      await writeFile(tempFile, "ok\n", "utf8");
      await unlink(tempFile);
      checks.push({ name: "storage", ok: true, detail: `${this.store.paths.rootDir} is writable.` });
    } catch (error) {
      checks.push({ name: "storage", ok: false, detail: String(error) });
    }

    try {
      await import("node-pty");
      checks.push({ name: "node-pty", ok: true, detail: "node-pty native module loaded." });
    } catch (error) {
      checks.push({ name: "node-pty", ok: false, detail: String(error) });
    }

    try {
      await assertPortAvailable(this.config.web.host, this.config.web.port);
      checks.push({ name: "web-port", ok: true, detail: `${this.config.web.host}:${this.config.web.port} is available.` });
    } catch (error) {
      checks.push({ name: "web-port", ok: false, detail: String(error) });
    }

    return checks;
  }

  async status(): Promise<PersistedState> {
    const state = await this.store.read();
    state.daemon.lastHeartbeatAt = new Date().toISOString();
    state.daemon.pid = process.pid;
    state.daemon.startedAt ??= new Date().toISOString();
    await this.store.write(state);
    return state;
  }

  async createInstance(runtime: RuntimeKind): Promise<InstanceRecord> {
    return this.supervisor.createInstance(runtime);
  }

  async commandCreateInstance(runtime: RuntimeKind): Promise<CommandResult<InstanceRecord>> {
    const instance = await this.supervisor.createInstance(runtime);
    return { ok: true, message: `Created ${instance.instanceId}.`, data: instance };
  }

  async commandUseInstance(instanceId: string): Promise<CommandResult<InstanceRecord>> {
    const instance = await this.supervisor.getInstance(instanceId);
    await this.supervisor.setCurrentInstance(instance.runtime, instanceId);
    return { ok: true, message: `Using ${instanceId}.`, data: instance };
  }

  async commandStatus(): Promise<CommandResult<PersistedState>> {
    return { ok: true, message: "ok", data: await this.status() };
  }

  async commandInstances(): Promise<CommandResult<InstanceRecord[]>> {
    return { ok: true, message: "ok", data: await this.supervisor.listInstances() };
  }

  async commandStop(instanceId: string): Promise<CommandResult> {
    await this.supervisor.stop(instanceId);
    return { ok: true, message: `Stopped task on ${instanceId}.` };
  }

  async commandReset(instanceId: string): Promise<CommandResult> {
    await this.supervisor.reset(instanceId);
    return { ok: true, message: `Reset instance ${instanceId}.` };
  }

  async commandKill(instanceId: string): Promise<CommandResult> {
    await this.supervisor.kill(instanceId);
    return { ok: true, message: `Killed instance ${instanceId}.` };
  }

  async commandLogs(instanceId: string): Promise<CommandResult<{ transcript: string }>> {
    const instance = await this.supervisor.getInstance(instanceId);
    return { ok: true, message: "ok", data: { transcript: instance.transcript } };
  }

  async runTelegramLoop(): Promise<void> {
    await this.supervisor.recoverOrphans();
    while (true) {
      let updates: Array<Record<string, unknown>> = [];
      try {
        updates = await this.telegram.getUpdates(this.pollOffset);
      } catch {
        await delay(1500);
        continue;
      }
      for (const update of updates) {
        const updateId = typeof update.update_id === "number" ? update.update_id : null;
        if (typeof updateId === "number") {
          this.pollOffset = updateId + 1;
        }
        await this.handleUpdate(update);
      }
    }
  }

  private isAllowedUser(userId: string): boolean {
    return this.config.telegram.allowedUserIds.includes(userId);
  }

  private async handleUpdate(update: Record<string, unknown>): Promise<void> {
    const message = update.message as Record<string, unknown> | undefined;
    if (!message) {
      return;
    }
    const chat = message.chat as Record<string, unknown> | undefined;
    const from = message.from as Record<string, unknown> | undefined;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!chat || !from || !text) {
      return;
    }

    const chatType = typeof chat.type === "string" ? chat.type : "";
    const chatId = chat.id == null ? "" : String(chat.id);
    const userId = from.id == null ? "" : String(from.id);
    if (chatType !== "private") {
      await this.telegram.sendMessage(chatId, "只支持 Telegram 私聊 DM。");
      return;
    }
    if (!this.isAllowedUser(userId)) {
      await this.telegram.sendMessage(chatId, "未授权用户。");
      return;
    }

    try {
      await this.handleTelegramCommand({ chatId, userId }, text);
    } catch (error) {
      await this.telegram.sendMessage(chatId, `命令执行失败：${String(error)}`);
    }
  }

  private async handleTelegramCommand(ctx: TelegramContext, text: string): Promise<void> {
    if (text === "/help") {
      await this.telegram.sendMessage(
        ctx.chatId,
        ["/status", "/instances", "/start_codex", "/start_claude", "/use <id>", "/ask <text>", "/stop", "/reset", "/kill", "/logs", "/web"].join("\n")
      );
      return;
    }

    if (text === "/status") {
      const status = await this.status();
      await this.telegram.sendMessage(
        ctx.chatId,
        `bridge pid=${status.daemon.pid ?? "n/a"} instances=${status.instances.length} tasks=${status.tasks.length}`
      );
      return;
    }

    if (text === "/instances") {
      const instances = await this.supervisor.listInstances();
      await this.telegram.sendMessage(
        ctx.chatId,
        instances.length === 0
          ? "暂无实例。"
          : instances.map((instance) => `${instance.instanceId} ${instance.runtime} ${instance.status} cwd=${instance.cwd}`).join("\n")
      );
      return;
    }

    if (text === "/start_codex" || text === "/start_claude") {
      const runtime = text === "/start_codex" ? "codex" : "claude";
      const instance = await this.createInstance(runtime);
      await this.telegram.sendMessage(ctx.chatId, `已创建 ${runtime} 实例 ${instance.instanceId}`);
      return;
    }

    if (text.startsWith("/use ")) {
      const instanceId = text.slice(5).trim();
      const instance = await this.supervisor.getInstance(instanceId);
      await this.supervisor.setCurrentInstance(instance.runtime, instanceId);
      await this.telegram.sendMessage(ctx.chatId, `已切换到 ${instance.runtime} 实例 ${instanceId}`);
      return;
    }

    if (text.startsWith("/ask ")) {
      const prompt = text.slice(5).trim();
      if (!prompt) {
        await this.telegram.sendMessage(ctx.chatId, "请提供 prompt。");
        return;
      }
      const instance = await this.supervisor.selectedInstance();
      if (!instance) {
        await this.telegram.sendMessage(ctx.chatId, "没有当前实例，请先 /start_codex 或 /start_claude。");
        return;
      }
      const ack = await this.telegram.sendMessage(ctx.chatId, `已接收任务，正在发送到 ${instance.runtime}:${instance.instanceId} ...`);
      let stopped = false;
      let buffer = "";
      const draft = createDraftStreamLoop({
        throttleMs: 1200,
        isStopped: () => stopped,
        sendOrEditStreamMessage: async (nextText) => {
          try {
            await this.telegram.editMessageText(ctx.chatId, ack.message_id, truncateForTelegram(nextText));
            return true;
          } catch {
            const fallback = await this.telegram.sendMessage(ctx.chatId, truncateForTelegram(nextText));
            ack.message_id = fallback.message_id;
            return true;
          }
        }
      });

      const ticker = setInterval(() => {
        void this.telegram.sendTyping(ctx.chatId).catch(() => undefined);
      }, 4000);

      const task = await this.supervisor.ask(instance.instanceId, prompt, async (event) => {
        await this.handleTelegramTaskEvent(ctx.chatId, ack.message_id, instance.instanceId, event);
        if (
          event.type === "partial_text" ||
          event.type === "tool_event" ||
          event.type === "status" ||
          event.type === "final_text" ||
          event.type === "error"
        ) {
          buffer = `${buffer}\n${event.text}`.trim();
          draft.update(buffer);
        }
        if (event.type === "exit") {
          stopped = true;
          clearInterval(ticker);
          await draft.flush();
          const finalText = truncateForTelegram(`${buffer}\n\n[${event.code === 0 ? "success" : "failed"}] task=${event.taskId}`);
          try {
            await this.telegram.editMessageText(ctx.chatId, ack.message_id, finalText);
          } catch {
            await this.telegram.sendMessage(ctx.chatId, finalText);
          }
        }
      });

      const stateForBinding = await this.store.read();
      const target = stateForBinding.instances.find((candidate) => candidate.instanceId === instance.instanceId);
      if (target) {
        target.telegramMessageBinding = { chatId: ctx.chatId, messageId: ack.message_id };
        target.currentTaskId = task.taskId;
        await this.store.write(stateForBinding);
      }
      return;
    }

    if (text === "/stop" || text === "/reset" || text === "/kill" || text === "/logs") {
      const current = await this.supervisor.selectedInstance();
      if (!current) {
        await this.telegram.sendMessage(ctx.chatId, "当前没有实例。");
        return;
      }
      if (text === "/stop") {
        await this.commandStop(current.instanceId);
        await this.telegram.sendMessage(ctx.chatId, `已停止 ${current.instanceId} 当前任务。`);
        return;
      }
      if (text === "/reset") {
        await this.commandReset(current.instanceId);
        await this.telegram.sendMessage(ctx.chatId, `已重置 ${current.instanceId}。`);
        return;
      }
      if (text === "/kill") {
        await this.commandKill(current.instanceId);
        await this.telegram.sendMessage(ctx.chatId, `已 kill ${current.instanceId}。`);
        return;
      }

      await this.telegram.sendMessage(ctx.chatId, truncateForTelegram(current.transcript || "暂无日志。"));
      return;
    }

    if (text === "/web") {
      await this.telegram.sendMessage(ctx.chatId, `本地面板：http://${this.config.web.host}:${this.config.web.port}`);
      return;
    }

    await this.telegram.sendMessage(ctx.chatId, "未知命令，使用 /help 查看帮助。");
  }

  private async handleTelegramTaskEvent(
    _chatId: string,
    _messageId: number,
    _instanceId: string,
    _event: StreamEvent
  ): Promise<void> {
    return;
  }
}

function truncateForTelegram(text: string): string {
  const normalized = text.trim() || "运行中...";
  if (normalized.length <= 3500) {
    return normalized;
  }
  return `${normalized.slice(0, 3400)}\n\n[输出过长，更多内容请用 /logs 或 /web 查看]`;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
