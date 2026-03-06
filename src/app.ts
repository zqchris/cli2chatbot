import { execFileSync } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import type { AppConfig, CommandResult, DoctorResult, InstanceRecord, PersistedState, RuntimeKind, StreamEvent } from "./domain/types.js";
import { ensureAppDir, saveConfig } from "./config.js";
import { StateStore } from "./store.js";
import { InstanceSupervisor } from "./runtime/supervisor.js";
import { TelegramApi } from "./telegram/api.js";
import { createDraftStreamLoop } from "./telegram/draft-loop.js";

type TelegramContext = {
  chatId: string;
  userId: string;
};

type PendingAuthPayload = {
  chatId: string;
  userId: string;
  username: string | null;
  firstName: string | null;
  text: string | null;
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
      await saveConfig(this.config);
    }

    state.pendingAuthRequests = state.pendingAuthRequests.filter((candidate) => candidate.userId !== userId);
    await this.store.write(state);
    await this.telegram.sendMessage(
      pending.chatId,
      "已通过本机面板授权。现在可以直接使用 /help 查看命令。"
    ).catch(() => undefined);
    return { ok: true, message: `Approved ${userId}.`, data: { userId } };
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
          await this.telegram.editMessageText(
            ctx.chatId,
            ack.message_id,
            truncateForTelegram(terminalText, 3500)
          ).catch(async () => {
            await this.telegram.sendMessage(ctx.chatId, truncateForTelegram(terminalText, 3500));
          });
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
}

function truncateForTelegram(text: string, maxLen = 3500): string {
  const normalized = text.trim() || "运行中...";
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLen - 100))}\n\n[输出过长，更多内容请用 /logs 或 /web 查看]`;
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
    let mergedText = compactAbsolutePathFlood(lines);
    if (mergedText.length > 1800) {
      mergedText = `${mergedText.slice(0, 1700)}\n... (输出过长，已截断)`;
    }
    return mergedText;
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
  const filtered = stripTracePrefixesLineByLine(stripExecutionScaffold(base));

  if (!filtered) {
    return null;
  }
  const compacted = compactAbsolutePathFlood(filtered.split(/\r?\n/));
  return truncateLongCodeBlocks(compacted, 700);
}

function truncateLongCodeBlocks(input: string, maxBlockChars: number): string {
  return input.replace(/```([\s\S]*?)```/g, (_all, body: string) => {
    if (body.length <= maxBlockChars) {
      return `\`\`\`${body}\`\`\``;
    }
    return `\`\`\`${body.slice(0, maxBlockChars)}\n... (代码块过长，已截断)\n\`\`\``;
  });
}

function stripExecutionScaffold(input: string): string {
  const output: string[] = [];
  let previousBlank = false;
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && isExecutionTraceLine(trimmed)) {
      continue;
    }
    if (!trimmed) {
      if (previousBlank) {
        continue;
      }
      previousBlank = true;
      output.push("");
      continue;
    }
    previousBlank = false;
    output.push(line);
  }
  return output.join("\n").trim();
}

function isExecutionTraceLine(trimmed: string): boolean {
  const lower = trimmed.toLowerCase();
  return (
    /^(\d+\s*→)/.test(trimmed) ||
    /^[-─]{6,}$/.test(trimmed) ||
    /^↳/.test(trimmed) ||
    /^\(no output\)$/i.test(trimmed) ||
    /^([•●◦▪▫🟢🟡🔵⚪⭕]\s*)?(bash|ran|running|explored|read|search|list|apply_patch|command|tool loaded)\b/i.test(trimmed) ||
    /^[└├│]/.test(trimmed) ||
    lower.includes("终端兼容模式已启用，正在继续执行任务")
  );
}

function stripTracePrefixesLineByLine(input: string): string {
  const result: string[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = stripSingleLineTracePrefix(rawLine);
    if (!line.trim() && rawLine.trim()) {
      continue;
    }
    result.push(line);
  }
  return result.join("\n").trim();
}

function stripSingleLineTracePrefix(line: string): string {
  const text = line
    .replace(/^\s*\d+\s*→\s*/, "")
    .replace(/^\s*[•●◦▪▫🟢🟡🔵⚪⭕]\s*/, "")
    .replace(/^\s*(bash|ran|running|explored|read|search|list)\([^)]*\)\s*/i, "")
    .replace(/^\s*(ran|explored|read|search|list)\s+/i, "")
    .replace(/^\s*[└├│]\s*/, "")
    .replace(/^\s*↳\s*/, "");

  if (/^\s*(\(no output\)|no output)\s*$/i.test(text)) {
    return "";
  }
  return text;
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

function compactAbsolutePathFlood(lines: string[]): string {
  const pathLikeIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines[i]?.trim() ?? "";
    if (!candidate) {
      continue;
    }
    if (isAbsolutePathLikeLine(candidate)) {
      pathLikeIndexes.push(i);
    }
  }

  if (pathLikeIndexes.length < 6 || pathLikeIndexes.length < Math.ceil(lines.length * 0.55)) {
    return lines.join("\n").trim();
  }

  const preview: string[] = [];
  let picked = 0;
  for (const line of lines) {
    if (isAbsolutePathLikeLine(line.trim())) {
      if (picked < 4) {
        preview.push(line);
      }
      picked += 1;
      continue;
    }
    preview.push(line);
  }
  const omitted = pathLikeIndexes.length - Math.min(pathLikeIndexes.length, 4);
  preview.push(`... (路径输出过长，已省略 ${omitted} 行)`);
  return preview.join("\n").trim();
}

function isAbsolutePathLikeLine(line: string): boolean {
  if (!line) {
    return false;
  }
  if (line.startsWith("/Users/") || line.startsWith("/home/") || line.startsWith("/tmp/")) {
    return true;
  }
  if (line.includes("/cli2chatbot/")) {
    return true;
  }
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(line) && line.includes(".ts");
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
