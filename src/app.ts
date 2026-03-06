import { execFileSync } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppConfig,
  CommandResult,
  DoctorResult,
  InstanceRecord,
  KnownTelegramUser,
  PersistedState,
  RuntimeKind,
  StreamEvent
} from "./domain/types.js";
import { ensureAppDir, saveConfig } from "./config.js";
import { StateStore } from "./store.js";
import { InstanceSupervisor } from "./runtime/supervisor.js";
import { TelegramApi } from "./telegram/api.js";
import { createDraftStreamLoop } from "./telegram/draft-loop.js";

type TelegramContext = {
  chatId: string;
  userId: string;
  messageId: number | null;
};

type PendingAuthPayload = {
  chatId: string;
  userId: string;
  username: string | null;
  firstName: string | null;
  text: string | null;
};

const TELEGRAM_NATIVE_COMMANDS = [
  { command: "help", description: "显示命令帮助" },
  { command: "menu", description: "显示按钮菜单" },
  { command: "status", description: "查看 bridge 状态" },
  { command: "instances", description: "列出全部实例" },
  { command: "current", description: "查看当前实例" },
  { command: "start_codex", description: "创建 codex 实例" },
  { command: "start_claude", description: "创建 claude 实例" },
  { command: "use", description: "切换实例: /use <id>" },
  { command: "cwd", description: "设置工作目录: /cwd [path]" },
  { command: "ask", description: "向当前实例提问" },
  { command: "args", description: "查看运行参数" },
  { command: "setargs", description: "设置参数: /setargs <runtime> <args>" },
  { command: "clearargs", description: "清空参数: /clearargs <runtime>" },
  { command: "model", description: "设置模型: /model [runtime] <name>" },
  { command: "restart", description: "重建当前实例" },
  { command: "stop", description: "停止当前任务" },
  { command: "reset", description: "重置当前实例上下文" },
  { command: "kill", description: "强杀当前实例" },
  { command: "logs", description: "查看当前实例日志摘要" },
  { command: "web", description: "查看本地面板地址" }
];

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

  async commandPendingAuth(): Promise<CommandResult<PersistedState["pendingAuthRequests"]>> {
    const state = await this.store.read();
    return { ok: true, message: "ok", data: state.pendingAuthRequests };
  }

  async commandApproveAuth(userId: string): Promise<CommandResult<{ userId: string }>> {
    const state = await this.store.read();
    const pending = state.pendingAuthRequests.find((candidate) => candidate.userId === userId);
    if (!pending) {
      return { ok: false, message: `No pending auth request for ${userId}.` };
    }

    if (!this.config.telegram.allowedUserIds.includes(userId)) {
      this.config.telegram.allowedUserIds.push(userId);
      await saveConfig(this.config, this.store.paths);
    }

    state.pendingAuthRequests = state.pendingAuthRequests.filter((candidate) => candidate.userId !== userId);
    await this.store.write(state);
    await this.telegram.sendMessage(
      pending.chatId,
      "已通过本机面板授权。现在可以直接使用 /help 查看命令。",
      { replyMarkup: mainCommandKeyboard() }
    ).catch(() => undefined);
    return { ok: true, message: `Approved ${userId}.`, data: { userId } };
  }

  async commandRevokeAuth(userId: string): Promise<CommandResult<{ userId: string }>> {
    if (!this.config.telegram.allowedUserIds.includes(userId)) {
      return { ok: false, message: `User ${userId} is not authorized.` };
    }

    this.config.telegram.allowedUserIds = this.config.telegram.allowedUserIds.filter((candidate) => candidate !== userId);
    await saveConfig(this.config, this.store.paths);

    const state = await this.store.read();
    state.pendingAuthRequests = state.pendingAuthRequests.filter((candidate) => candidate.userId !== userId);
    for (const instance of state.instances) {
      if (instance.telegramMessageBinding?.chatId === userId) {
        instance.telegramMessageBinding = null;
      }
    }
    await this.store.write(state);

    await this.telegram.sendMessage(
      userId,
      "当前 Telegram 账号已被本机管理员撤销授权。若需恢复，请重新发消息并在本地面板批准。"
    ).catch(() => undefined);

    return { ok: true, message: `Revoked ${userId}.`, data: { userId } };
  }

  async commandAuthorizedUsers(): Promise<CommandResult<Array<{
    userId: string;
    username: string | null;
    firstName: string | null;
    lastSeenAt: string | null;
    lastSeenText: string | null;
    chatId: string | null;
    connectionStatus: "online" | "idle" | "running" | "unknown";
    boundInstances: number;
  }>>> {
    const state = await this.store.read();
    const now = Date.now();
    const knownById = new Map<string, KnownTelegramUser>();
    for (const user of state.knownTelegramUsers) {
      knownById.set(user.userId, user);
    }

    const data = this.config.telegram.allowedUserIds.map((userId) => {
      const known = knownById.get(userId);
      const bound = state.instances.filter((instance) => instance.telegramMessageBinding?.chatId === userId);
      const lastSeenAt = known?.lastSeenAt ?? null;
      const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
      let connectionStatus: "online" | "idle" | "running" | "unknown" = "unknown";
      if (bound.some((instance) => instance.status === "running")) {
        connectionStatus = "running";
      } else if (Number.isFinite(lastSeenMs)) {
        connectionStatus = now - (lastSeenMs as number) <= 10 * 60 * 1000 ? "online" : "idle";
      } else if (bound.length > 0) {
        connectionStatus = "idle";
      }

      return {
        userId,
        username: known?.username ?? null,
        firstName: known?.firstName ?? null,
        lastSeenAt,
        lastSeenText: known?.lastSeenText ?? null,
        chatId: known?.chatId ?? null,
        connectionStatus,
        boundInstances: bound.length
      };
    });
    return { ok: true, message: "ok", data };
  }

  async runTelegramLoop(): Promise<void> {
    await this.supervisor.recoverOrphans();
    await this.syncTelegramCommandMenu();
    while (true) {
      let updates: Array<Record<string, unknown>> = [];
      try {
        updates = await this.telegram.getUpdates(this.pollOffset);
        await this.markTelegramLoopHealthy();
      } catch (error) {
        await this.markTelegramLoopError(`getUpdates failed: ${String(error)}`);
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
    const messageId = typeof message.message_id === "number" ? message.message_id : null;
    await this.upsertKnownUser({
      chatId,
      userId,
      username: typeof from.username === "string" ? from.username : null,
      firstName: typeof from.first_name === "string" ? from.first_name : null,
      text
    });

    if (chatType !== "private") {
      await this.telegram.sendMessage(chatId, "只支持 Telegram 私聊 DM。");
      return;
    }
    if (!this.isAllowedUser(userId)) {
      await this.recordPendingAuth({
        chatId,
        userId,
        username: typeof from.username === "string" ? from.username : null,
        firstName: typeof from.first_name === "string" ? from.first_name : null,
        text
      });
      await this.telegram.sendMessage(
        chatId,
        "已记录授权请求。请在本机 Web 面板批准这个 Telegram 账号，批准后再继续发送命令。"
      );
      return;
    }

    try {
      await this.handleTelegramCommand({ chatId, userId, messageId }, text);
    } catch (error) {
      await this.telegram.sendMessage(chatId, `命令执行失败：${String(error)}`);
    }
  }

  private async syncTelegramCommandMenu(): Promise<void> {
    await this.telegram.setMyCommands(TELEGRAM_NATIVE_COMMANDS).catch(() => undefined);
  }

  private parseRuntimeToken(value: string): RuntimeKind | null {
    if (value === "codex" || value === "claude") {
      return value;
    }
    return null;
  }

  private async setRuntimeArgs(runtime: RuntimeKind, args: string[]): Promise<void> {
    this.config.runtimes[runtime].defaultArgs = args;
    await saveConfig(this.config, this.store.paths);
  }

  private runtimeArgsText(runtime: RuntimeKind): string {
    const args = this.config.runtimes[runtime].defaultArgs;
    if (!args || args.length === 0) {
      return `${runtime}: (none)`;
    }
    return `${runtime}: ${args.join(" ")}`;
  }

  private async handleTelegramCommand(ctx: TelegramContext, text: string): Promise<void> {
    if (text === "/help" || text === "/menu") {
      await this.telegram.sendMessage(
        ctx.chatId,
        [
          "/menu",
          "/status",
          "/instances",
          "/current",
          "/start_codex",
          "/start_claude",
          "/use <id>",
          "/cwd [path]",
          "/ask <text>",
          "/args [codex|claude]",
          "/setargs <runtime> <args...>",
          "/clearargs <runtime>",
          "/model [runtime] <model>",
          "/restart",
          "/stop",
          "/reset",
          "/kill",
          "/logs",
          "/web"
        ].join("\n"),
        { replyMarkup: mainCommandKeyboard() }
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
      const current = await this.supervisor.selectedInstance();
      await this.telegram.sendMessage(
        ctx.chatId,
        instances.length === 0
          ? "暂无实例。"
          : instances
            .map((instance) => {
              const marker = current?.instanceId === instance.instanceId ? "👉 " : "";
              return `${marker}${instance.instanceId} ${instance.runtime} ${instance.status} cwd=${instance.cwd}`;
            })
            .join("\n"),
        { replyMarkup: instancesCommandKeyboard(instances) }
      );
      return;
    }

    if (text === "/current") {
      const current = await this.supervisor.selectedInstance();
      if (!current) {
        await this.telegram.sendMessage(ctx.chatId, "当前没有实例。");
        return;
      }
      await this.telegram.sendMessage(
        ctx.chatId,
        [
          `instance=${current.instanceId}`,
          `runtime=${current.runtime}`,
          `status=${current.status}`,
          `cwd=${current.cwd}`,
          `args=${this.config.runtimes[current.runtime].defaultArgs.join(" ") || "(none)"}`
        ].join("\n")
      );
      return;
    }

    if (text === "/start_codex" || text === "/start_claude") {
      const runtime = text === "/start_codex" ? "codex" : "claude";
      const instance = await this.createInstance(runtime);
      await this.telegram.sendMessage(ctx.chatId, `已创建 ${runtime} 实例 ${instance.instanceId}`);
      return;
    }

    if (text === "/use" || text.startsWith("/use ")) {
      const instanceId = text.slice(5).trim();
      if (!instanceId) {
        const instances = await this.supervisor.listInstances();
        if (instances.length === 0) {
          await this.telegram.sendMessage(ctx.chatId, "用法：/use <instanceId>\n当前暂无实例，请先 /start_codex 或 /start_claude。");
          return;
        }
        await this.telegram.sendMessage(
          ctx.chatId,
          [
            "用法：/use <instanceId>",
            "可用实例：",
            ...instances.map((instance) => `- ${instance.instanceId} (${instance.runtime}, ${instance.status})`)
          ].join("\n")
        );
        return;
      }
      const instance = await this.supervisor.getInstance(instanceId);
      await this.supervisor.setCurrentInstance(instance.runtime, instanceId);
      await this.telegram.sendMessage(ctx.chatId, `已切换到 ${instance.runtime} 实例 ${instanceId}`);
      return;
    }

    if (text === "/cwd" || text.startsWith("/cwd ")) {
      const current = await this.supervisor.selectedInstance();
      if (!current) {
        await this.telegram.sendMessage(ctx.chatId, "当前没有实例。先 /start_codex 或 /start_claude。");
        return;
      }
      if (text === "/cwd") {
        await this.telegram.sendMessage(
          ctx.chatId,
          [
            `当前实例: ${current.instanceId} (${current.runtime})`,
            `当前 cwd: ${current.cwd}`,
            "用法：/cwd <path>",
            "示例：/cwd ~/Projects/Github/zqchris/cli2chatbot"
          ].join("\n")
        );
        return;
      }

      const rawPath = text.slice("/cwd ".length).trim();
      if (!rawPath) {
        await this.telegram.sendMessage(ctx.chatId, "用法：/cwd <path>");
        return;
      }
      const nextCwd = resolveWorkdir(rawPath, current.cwd, this.config.runtimes.defaultCwd);
      await assertDirectory(nextCwd);
      const updated = await this.supervisor.setInstanceCwd(current.instanceId, nextCwd);
      await this.telegram.sendMessage(
        ctx.chatId,
        `已设置 ${updated.runtime}:${updated.instanceId} 工作目录为\n${updated.cwd}`
      );
      return;
    }

    if (text === "/ask" || text.startsWith("/ask ")) {
      const prompt = text.slice(5).trim();
      if (!prompt) {
        await this.telegram.sendMessage(ctx.chatId, "用法：/ask <prompt>");
        return;
      }
      await this.startTelegramAskTask(ctx, prompt);
      return;
    }

    if (text === "/args" || text.startsWith("/args ")) {
      const token = text === "/args" ? "" : text.slice(6).trim();
      if (!token) {
        await this.telegram.sendMessage(
          ctx.chatId,
          [this.runtimeArgsText("codex"), this.runtimeArgsText("claude")].join("\n")
        );
        return;
      }
      const runtime = this.parseRuntimeToken(token);
      if (!runtime) {
        await this.telegram.sendMessage(ctx.chatId, "用法：/args [codex|claude]");
        return;
      }
      await this.telegram.sendMessage(ctx.chatId, this.runtimeArgsText(runtime));
      return;
    }

    if (text === "/setargs" || text.startsWith("/setargs ")) {
      const body = text.slice("/setargs ".length).trim();
      const firstSpace = body.indexOf(" ");
      if (firstSpace <= 0) {
        await this.telegram.sendMessage(ctx.chatId, "用法：/setargs <codex|claude> <args...>");
        return;
      }
      const runtimeToken = body.slice(0, firstSpace).trim();
      const argText = body.slice(firstSpace + 1).trim();
      const runtime = this.parseRuntimeToken(runtimeToken);
      if (!runtime) {
        await this.telegram.sendMessage(ctx.chatId, "runtime 只能是 codex 或 claude。");
        return;
      }
      const args = parseShellStyleArgs(argText);
      await this.setRuntimeArgs(runtime, args);
      await this.telegram.sendMessage(ctx.chatId, `已更新 ${runtime} 参数：${args.join(" ") || "(none)"}`);
      return;
    }

    if (text === "/clearargs" || text.startsWith("/clearargs ")) {
      const runtime = this.parseRuntimeToken(text.slice("/clearargs ".length).trim());
      if (!runtime) {
        await this.telegram.sendMessage(ctx.chatId, "用法：/clearargs <codex|claude>");
        return;
      }
      await this.setRuntimeArgs(runtime, []);
      await this.telegram.sendMessage(ctx.chatId, `已清空 ${runtime} 参数。`);
      return;
    }

    if (text === "/model" || text.startsWith("/model ")) {
      const body = text === "/model" ? "" : text.slice("/model ".length).trim();
      const tokens = body ? parseShellStyleArgs(body) : [];
      const firstToken = tokens[0] ?? "";
      const tokenRuntime = this.parseRuntimeToken(firstToken);

      let runtime: RuntimeKind | null = tokenRuntime;
      let modelName = tokenRuntime ? tokens.slice(1).join(" ").trim() : tokens.join(" ").trim();

      if (!runtime) {
        const current = await this.supervisor.selectedInstance();
        runtime = current?.runtime ?? null;
      }

      if (!runtime) {
        await this.telegram.sendMessage(
          ctx.chatId,
          [
            "当前没有实例，无法推断 runtime。",
            "用法：/model <codex|claude> <model>",
            "示例：/model claude opus",
            "提示：先 /start_codex 或 /start_claude，再用 /model <model>。"
          ].join("\n")
        );
        return;
      }

      if (!modelName) {
        const currentModel = readModelArg(this.config.runtimes[runtime].defaultArgs) ?? "(default)";
        await this.telegram.sendMessage(
          ctx.chatId,
          [
            `当前 runtime: ${runtime}`,
            `当前模型参数: ${currentModel}`,
            "用法：",
            `- /model <model>（作用于当前 runtime=${runtime}）`,
            "- /model <codex|claude> <model>",
            "- /model default（清除 --model，回到 CLI 默认）",
            "示例：/model opus"
          ].join("\n"),
          { replyMarkup: modelCommandKeyboard(runtime) }
        );
        return;
      }

      const resolvedModel = normalizeModelInput(modelName);
      const nextArgs = resolvedModel === null
        ? removeModelArg(this.config.runtimes[runtime].defaultArgs)
        : upsertModelArg(this.config.runtimes[runtime].defaultArgs, resolvedModel);
      await this.setRuntimeArgs(runtime, nextArgs);
      await this.telegram.sendMessage(
        ctx.chatId,
        resolvedModel === null
          ? `已清除 ${runtime} 模型参数，恢复 CLI 默认模型。`
          : `已设置 ${runtime} 模型：${resolvedModel}`
      );
      return;
    }

    if (text === "/restart") {
      const current = await this.supervisor.selectedInstance();
      if (!current) {
        await this.telegram.sendMessage(ctx.chatId, "当前没有实例。先 /start_codex 或 /start_claude。");
        return;
      }
      await this.commandKill(current.instanceId).catch(() => undefined);
      const next = await this.createInstance(current.runtime);
      await this.telegram.sendMessage(
        ctx.chatId,
        `已重建实例：${current.instanceId} -> ${next.instanceId} (${next.runtime})`
      );
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

    if (!text.startsWith("/")) {
      await this.startTelegramAskTask(ctx, text);
      return;
    }

    await this.telegram.sendMessage(ctx.chatId, "未知命令，使用 /help 查看帮助。");
  }

  private async startTelegramAskTask(ctx: TelegramContext, prompt: string): Promise<void> {
    const instance = await this.supervisor.selectedInstance();
    if (!instance) {
      await this.telegram.sendMessage(ctx.chatId, "没有当前实例，请先 /start_codex 或 /start_claude。");
      return;
    }
    const ack = await this.telegram.sendMessage(
      ctx.chatId,
      `已接收任务，正在发送到 ${instance.runtime}:${instance.instanceId} ...`,
      ctx.messageId ? { replyToMessageId: ctx.messageId } : undefined
    );
    let stopped = false;
    let draftText = "";
    let finalText = "";
    let spinnerIndex = 0;
    let toolSteps = 0;
    const draft = createDraftStreamLoop({
      throttleMs: 1200,
      isStopped: () => stopped,
      sendOrEditStreamMessage: async (nextText) => {
        await this.telegram.editMessageText(ctx.chatId, ack.message_id, truncateForTelegram(nextText, 3500));
        return true;
      }
    });

    const ticker = setInterval(() => {
      void this.telegram.sendTyping(ctx.chatId).catch(() => undefined);
      if (!draftText) {
        spinnerIndex += 1;
        const elapsed = spinnerIndex * 4;
        const frame = loadingFrame(spinnerIndex);
        const stepText = toolSteps > 0 ? ` · steps ${toolSteps}` : "";
        void this.telegram.editMessageText(
          ctx.chatId,
          ack.message_id,
          `已接收任务，正在发送到 ${instance.runtime}:${instance.instanceId} ... ${frame} ${elapsed}s${stepText}`
        ).catch(() => undefined);
      }
    }, 4000);

    const task = await this.supervisor.ask(instance.instanceId, prompt, async (event) => {
      await this.handleTelegramTaskEvent(ctx.chatId, ack.message_id, instance.instanceId, event);
      if (event.type === "tool_event") {
        toolSteps += 1;
      }
      const displayChunk = formatTelegramDisplayChunk(event);
      if (displayChunk) {
        draftText = mergeDraftText(draftText, displayChunk, event.type);
        draft.update(draftText);
      }
      if (event.type === "final_text" && event.text.trim()) {
        finalText = sanitizeFinalTelegramText(event.text) ?? event.text.trim();
      }
      if (event.type === "error" && event.text.trim()) {
        finalText = sanitizeFinalTelegramText(event.text) ?? event.text.trim();
      }
      if (event.type === "exit") {
        stopped = true;
        clearInterval(ticker);
        await draft.flush();
        const terminalText = event.code === 0
          ? (finalText || draftText || `[success] task=${event.taskId}`)
          : `${finalText || draftText || "任务失败。"}\n\n[failed] task=${event.taskId}`;
        await this.publishTerminalMessage(ctx.chatId, ack.message_id, terminalText);
      }
    });

    const stateForBinding = await this.store.read();
    const target = stateForBinding.instances.find((candidate) => candidate.instanceId === instance.instanceId);
    if (target) {
      target.telegramMessageBinding = { chatId: ctx.chatId, messageId: ack.message_id };
      target.currentTaskId = task.taskId;
      await this.store.write(stateForBinding);
    }
  }

  private async handleTelegramTaskEvent(
    _chatId: string,
    _messageId: number,
    _instanceId: string,
    _event: StreamEvent
  ): Promise<void> {
    return;
  }

  private async publishTerminalMessage(chatId: string, messageId: number, rawText: string): Promise<void> {
    const formatted = formatTelegramFinalDelivery(rawText);
    try {
      await this.telegram.editMessageText(chatId, messageId, formatted.text, {
        parseMode: formatted.parseMode
      });
      return;
    } catch {
      if (formatted.parseMode) {
        const plain = stripSimpleMarkdown(formatted.fallbackPlain);
        await this.telegram.editMessageText(chatId, messageId, plain).catch(async () => {
          await this.telegram.sendMessage(chatId, plain);
        });
        return;
      }
      await this.telegram.sendMessage(chatId, formatted.text);
    }
  }

  private async recordPendingAuth(payload: PendingAuthPayload): Promise<void> {
    const state = await this.store.read();
    const existing = state.pendingAuthRequests.find((candidate) => candidate.userId === payload.userId);
    if (existing) {
      existing.chatId = payload.chatId;
      existing.username = payload.username;
      existing.firstName = payload.firstName;
      existing.lastSeenText = payload.text;
    } else {
      state.pendingAuthRequests.unshift({
        userId: payload.userId,
        chatId: payload.chatId,
        username: payload.username,
        firstName: payload.firstName,
        requestedAt: new Date().toISOString(),
        lastSeenText: payload.text
      });
    }
    await this.store.write(state);
  }

  private async upsertKnownUser(payload: PendingAuthPayload): Promise<void> {
    const state = await this.store.read();
    const existing = state.knownTelegramUsers.find((candidate) => candidate.userId === payload.userId);
    if (existing) {
      existing.chatId = payload.chatId;
      existing.username = payload.username;
      existing.firstName = payload.firstName;
      existing.lastSeenAt = new Date().toISOString();
      existing.lastSeenText = payload.text;
    } else {
      state.knownTelegramUsers.unshift({
        userId: payload.userId,
        chatId: payload.chatId,
        username: payload.username,
        firstName: payload.firstName,
        lastSeenAt: new Date().toISOString(),
        lastSeenText: payload.text
      });
    }
    await this.store.write(state);
  }

  private async markTelegramLoopHealthy(): Promise<void> {
    const state = await this.store.read();
    state.daemon.lastTelegramUpdateAt = new Date().toISOString();
    state.daemon.lastTelegramError = null;
    await this.store.write(state);
  }

  private async markTelegramLoopError(errorText: string): Promise<void> {
    const state = await this.store.read();
    state.daemon.lastTelegramError = errorText;
    await this.store.write(state);
  }
}

function truncateForTelegram(text: string, maxLen = 3500): string {
  const normalized = text.trim() || "运行中...";
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLen - 100))}\n\n[输出过长，更多内容请用 /logs 或 /web 查看]`;
}

type TelegramFinalDelivery = {
  text: string;
  parseMode?: "HTML";
  fallbackPlain: string;
};

function formatTelegramFinalDelivery(rawText: string): TelegramFinalDelivery {
  const plain = truncateForTelegram(rawText, 3500);
  if (plain.includes("[输出过长")) {
    return { text: stripSimpleMarkdown(plain), fallbackPlain: plain };
  }
  const rendered = renderSimpleMarkdownToTelegramHtml(plain);
  if (!rendered.usedFormatting) {
    return { text: plain, fallbackPlain: plain };
  }
  if (rendered.html.length > 3900) {
    return { text: stripSimpleMarkdown(plain), fallbackPlain: plain };
  }
  return {
    text: rendered.html,
    parseMode: "HTML",
    fallbackPlain: plain
  };
}

function renderSimpleMarkdownToTelegramHtml(input: string): { html: string; usedFormatting: boolean } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let usedFormatting = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        out.push("<pre><code>");
      } else {
        out.push("</code></pre>");
      }
      inCodeBlock = !inCodeBlock;
      usedFormatting = true;
      continue;
    }
    if (inCodeBlock) {
      out.push(escapeTelegramHtml(line));
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading?.[1]) {
      out.push(`<b>${renderInlineMarkdown(heading[1])}</b>`);
      usedFormatting = true;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet?.[1]) {
      out.push(`• ${renderInlineMarkdown(bullet[1])}`);
      usedFormatting = true;
      continue;
    }

    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered?.[1] && numbered?.[2]) {
      out.push(`${numbered[1]}. ${renderInlineMarkdown(numbered[2])}`);
      usedFormatting = true;
      continue;
    }

    const inline = renderInlineMarkdown(line);
    if (inline !== escapeTelegramHtml(line)) {
      usedFormatting = true;
    }
    out.push(inline);
  }

  if (inCodeBlock) {
    out.push("</code></pre>");
  }
  return { html: out.join("\n"), usedFormatting };
}

function renderInlineMarkdown(line: string): string {
  const codeSlots: string[] = [];
  const withPlaceholders = line.replace(/`([^`\n]+)`/g, (_all, code: string) => {
    const token = `@@CODE_SLOT_${codeSlots.length}@@`;
    codeSlots.push(`<code>${escapeTelegramHtml(code)}</code>`);
    return token;
  });

  let escaped = escapeTelegramHtml(withPlaceholders);
  escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  escaped = escaped.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  escaped = escaped.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

  for (let i = 0; i < codeSlots.length; i += 1) {
    const token = `@@CODE_SLOT_${i}@@`;
    const slot = codeSlots[i] ?? "";
    escaped = escaped.replace(token, slot);
  }
  return escaped;
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripSimpleMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function loadingFrame(index: number): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return frames[index % frames.length] ?? "⏳";
}

function formatTelegramDisplayChunk(event: StreamEvent): string | null {
  // Default UX: keep Telegram draft as progress-only preview.
  // Final answer is delivered on task exit after structured cleanup.
  void event;
  return null;
}

function sanitizeDisplayText(input: string, fromTool: boolean): string | null {
  if (input.length === 0) {
    return null;
  }
  const text = input.replace(/\r\n/g, "\n");

  const lower = text.toLowerCase();
  if (
    lower.includes('"type":"user"') ||
    lower.includes('"type":"tool_result"') ||
    lower.includes('"type":"stream_event"') ||
    lower.includes('"type":"system"') ||
    lower.includes("tool loaded.")
  ) {
    return null;
  }

  const lines = text
    .split(/\r?\n/)
    .filter((line) => !isTransportMetaLine(line))
    .filter((line) => !line.includes("/node_modules/"))
    .filter((line) => !line.endsWith(".cjs"))
    .filter((line) => !line.endsWith(".LICENSE"));

  if (lines.length === 0 || lines.every((line) => line.length === 0)) {
    return null;
  }

  if (!fromTool) {
    return lines.join("\n").trim();
  }

  // Tool output can be very verbose; keep the first N lines only.
  const maxLines = 8;
  const clipped = lines.slice(0, maxLines);
  const omitted = lines.length - clipped.length;
  let merged = clipped.join("\n");
  if (omitted > 0) {
    merged = `${merged}\n... (省略 ${omitted} 行)`;
  }

  if (merged.length > 700) {
    merged = `${merged.slice(0, 620)}\n... (输出过长，已截断)`;
  }
  return merged.trim() || null;
}

function sanitizeFinalTelegramText(input: string): string | null {
  const base = sanitizeDisplayText(input, false);
  if (!base) {
    return null;
  }
  const filtered = collapseBlankLines(
    base
      .split(/\r?\n/)
      .filter((line) => !isLikelyTraceLine(line.trim()))
      .join("\n")
  );

  if (!filtered) {
    return null;
  }
  return filtered;
}

function isLikelyTraceLine(trimmed: string): boolean {
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  return (
    /^(\d+\s*→)/.test(trimmed) ||
    /^[-─]{6,}$/.test(trimmed) ||
    /^↳/.test(trimmed) ||
    /^\(no output\)$/i.test(trimmed) ||
    /^([•●◦▪▫🟢🟡🔵⚪⭕]\s*)?(bash\(|ran\b|explored\b|read\b|search\b|list\b)/i.test(trimmed) ||
    /^([└├│]\s*)(read|list|search|ran)\b/i.test(trimmed) ||
    lower === "tool loaded." ||
    lower.includes("终端兼容模式已启用，正在继续执行任务")
  );
}

function collapseBlankLines(input: string): string {
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank) {
      if (previousBlank) {
        continue;
      }
      previousBlank = true;
      out.push("");
      continue;
    }
    previousBlank = false;
    out.push(line);
  }
  return out.join("\n").trim();
}

function isTransportMetaLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  return (
    lower.includes('"stdout":') ||
    lower.includes('"stderr":') ||
    lower.includes('"interrupted":') ||
    lower.includes('"isimage":') ||
    lower.includes('"nooutputexpected":') ||
    lower.includes('"tool_use_id"') ||
    lower.includes('"type":"tool_result"') ||
    lower === "tool loaded." ||
    lower === "}" ||
    lower === "}}" ||
    lower.startsWith("{\"type\":\"user\"")
  );
}

function mergeDraftText(current: string, chunk: string, eventType: StreamEvent["type"]): string {
  if (!chunk) {
    return current;
  }
  if (eventType === "partial_text") {
    return `${current}${chunk}`;
  }
  if (!current) {
    return chunk;
  }
  return `${current.endsWith("\n") ? current : `${current}\n`}${chunk}`;
}

function parseShellStyleArgs(input: string): string[] {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if (
        (token.startsWith("\"") && token.endsWith("\"")) ||
        (token.startsWith("'") && token.endsWith("'"))
      ) {
        return token.slice(1, -1);
      }
      return token;
    });
}

function upsertModelArg(args: string[], modelName: string): string[] {
  return ["--model", modelName, ...removeModelArg(args)];
}

function removeModelArg(args: string[]): string[] {
  const next: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--model" || token === "-m") {
      i += 1;
      continue;
    }
    next.push(token);
  }
  return next;
}

function readModelArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if ((token === "--model" || token === "-m") && typeof args[i + 1] === "string") {
      return args[i + 1] as string;
    }
  }
  return null;
}

function normalizeModelInput(modelName: string): string | null {
  const normalized = modelName.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "default" || normalized === "auto") {
    return null;
  }
  return normalized;
}

function resolveWorkdir(rawPath: string, instanceCwd: string, defaultCwd: string): string {
  const trimmed = rawPath.trim();
  const withHome = trimmed.startsWith("~")
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;
  if (path.isAbsolute(withHome)) {
    return path.resolve(withHome);
  }
  const base = instanceCwd || defaultCwd || process.cwd();
  return path.resolve(base, withHome);
}

async function assertDirectory(cwd: string): Promise<void> {
  const info = await stat(cwd);
  if (!info.isDirectory()) {
    throw new Error(`不是目录：${cwd}`);
  }
}

function mainCommandKeyboard(): Record<string, unknown> {
  return {
    keyboard: [
      [{ text: "/menu" }, { text: "/status" }, { text: "/instances" }],
      [{ text: "/start_codex" }, { text: "/start_claude" }, { text: "/current" }],
      [{ text: "/cwd" }, { text: "/model" }, { text: "/args" }],
      [{ text: "/stop" }, { text: "/reset" }, { text: "/kill" }],
      [{ text: "/logs" }, { text: "/web" }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "直接输入文本即可提问；或点按钮执行命令"
  };
}

function instancesCommandKeyboard(instances: InstanceRecord[]): Record<string, unknown> {
  const baseRows: Array<Array<{ text: string }>> = [
    [{ text: "/instances" }, { text: "/current" }, { text: "/cwd" }],
    [{ text: "/stop" }, { text: "/reset" }, { text: "/kill" }]
  ];
  const useRows = instances.slice(0, 6).map((instance) => [{ text: `/use ${instance.instanceId}` }]);
  return {
    keyboard: [...useRows, ...baseRows],
    resize_keyboard: true,
    is_persistent: true
  };
}

function modelCommandKeyboard(runtime: RuntimeKind): Record<string, unknown> {
  const options = runtime === "claude"
    ? ["default", "sonnet", "opus", "haiku"]
    : ["default", "gpt-5", "gpt-5-mini"];
  const firstRow = options.slice(0, 2).map((name) => ({ text: `/model ${runtime} ${name}` }));
  const secondRow = options.slice(2).map((name) => ({ text: `/model ${runtime} ${name}` }));
  const rows: Array<Array<{ text: string }>> = [firstRow];
  if (secondRow.length > 0) {
    rows.push(secondRow);
  }
  rows.push([{ text: "/model" }, { text: "/args" }]);
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true
  };
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
