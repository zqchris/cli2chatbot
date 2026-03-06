import { nanoid } from "nanoid";
import type { AppConfig, InstanceRecord, PersistedState, RuntimeKind, StreamEvent, TaskRecord, TaskStatus } from "../domain/types.js";
import { StateStore } from "../store.js";
import { startRuntimeTask, type RuntimeTaskHandle } from "./adapters.js";

type RunningTask = {
  instanceId: string;
  handle: RuntimeTaskHandle;
};

export class InstanceSupervisor {
  private readonly runningTasks = new Map<string, RunningTask>();

  constructor(
    private readonly store: StateStore,
    private readonly config: AppConfig
  ) {}

  async recoverOrphans(): Promise<void> {
    const state = await this.store.read();
    let changed = false;
    for (const instance of state.instances) {
      if (instance.pid && instance.status === "running") {
        try {
          process.kill(instance.pid, 0);
        } catch {
          instance.status = "failed";
          instance.pid = null;
          instance.currentTaskId = null;
          instance.lastError = "Recovered after daemon restart; child process no longer exists.";
          changed = true;
        }
      }
    }
    if (changed) {
      await this.store.write(state);
    }
  }

  async snapshot(): Promise<PersistedState> {
    return this.store.read();
  }

  async createInstance(runtime: RuntimeKind, cwd?: string): Promise<InstanceRecord> {
    const state = await this.store.read();
    const runningCount = state.instances.filter((instance) => instance.runtime === runtime && instance.status !== "killed").length;
    if (runningCount >= this.config.instances.maxRunningPerRuntime) {
      throw new Error(`Too many ${runtime} instances. Limit is ${this.config.instances.maxRunningPerRuntime}.`);
    }

    const now = new Date().toISOString();
    const instance: InstanceRecord = {
      instanceId: nanoid(8),
      runtime,
      cwd: cwd ?? this.config.runtimes.defaultCwd,
      createdAt: now,
      lastActiveAt: now,
      pid: null,
      currentTaskId: null,
      status: "idle",
      lastError: null,
      telegramMessageBinding: null,
      transcript: ""
    };
    state.instances.unshift(instance);
    state.currentInstanceByRuntime[runtime] = instance.instanceId;
    state.currentInstanceId = instance.instanceId;
    await this.store.write(state);
    return instance;
  }

  async listInstances(): Promise<InstanceRecord[]> {
    const state = await this.store.read();
    return state.instances;
  }

  async getInstance(instanceId: string): Promise<InstanceRecord> {
    const state = await this.store.read();
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance) {
      throw new Error(`Unknown instance: ${instanceId}`);
    }
    return instance;
  }

  async setCurrentInstance(runtime: RuntimeKind, instanceId: string): Promise<void> {
    const state = await this.store.read();
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId && candidate.runtime === runtime);
    if (!instance) {
      throw new Error(`Instance ${instanceId} is not a ${runtime} instance.`);
    }
    state.currentInstanceByRuntime[runtime] = instanceId;
    state.currentInstanceId = instanceId;
    await this.store.write(state);
  }

  async currentInstance(runtime: RuntimeKind): Promise<InstanceRecord | null> {
    const state = await this.store.read();
    const currentId = state.currentInstanceByRuntime[runtime];
    return currentId ? state.instances.find((candidate) => candidate.instanceId === currentId) ?? null : null;
  }

  async selectedInstance(): Promise<InstanceRecord | null> {
    const state = await this.store.read();
    return state.currentInstanceId
      ? state.instances.find((candidate) => candidate.instanceId === state.currentInstanceId) ?? null
      : null;
  }

  async ask(instanceId: string, prompt: string, onEvent?: (event: StreamEvent) => Promise<void> | void): Promise<TaskRecord> {
    const state = await this.store.read();
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance) {
      throw new Error(`Unknown instance: ${instanceId}`);
    }
    if (this.runningTasks.has(instanceId) || instance.status === "running") {
      throw new Error(`Instance ${instanceId} already has a running task.`);
    }
    const handle = startRuntimeTask({
      runtime: instance.runtime,
      prompt,
      cwd: instance.cwd,
      config: this.config
    });
    const task: TaskRecord = {
      taskId: handle.taskId,
      instanceId,
      runtime: instance.runtime,
      prompt,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      outputPreview: "",
      exitCode: null,
      error: null
    };

    instance.status = "running";
    instance.pid = handle.pid;
    instance.currentTaskId = handle.taskId;
    instance.lastActiveAt = new Date().toISOString();
    state.tasks.unshift(task);
    await this.store.write(state);

    this.runningTasks.set(instanceId, { instanceId, handle });
    void this.consumeTaskStream(instanceId, handle, onEvent);
    return task;
  }

  private async consumeTaskStream(
    instanceId: string,
    handle: RuntimeTaskHandle,
    onEvent?: (event: StreamEvent) => Promise<void> | void
  ): Promise<void> {
    let finalStatus: TaskStatus = "success";
    let exitCode: number | null = null;
    let errorText: string | null = null;
    let combined = "";

    for await (const event of handle.stream) {
      if (event.type === "partial_text" || event.type === "tool_event" || event.type === "status" || event.type === "final_text") {
        combined += `${event.text}\n`;
      }
      if (event.type === "error") {
        errorText = event.text;
        finalStatus = "failed";
      }
      if (event.type === "exit") {
        exitCode = event.code;
        if (finalStatus === "success" && exitCode !== 0) {
          finalStatus = exitCode === null ? "failed" : "failed";
        }
      }
      await this.store.appendEvent(event);
      await onEvent?.(event);
    }

    const state = await this.store.read();
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    const task = state.tasks.find((candidate) => candidate.taskId === handle.taskId);
    if (!instance || !task) {
      this.runningTasks.delete(instanceId);
      return;
    }

    task.status = instance.status === "killed" ? "killed" : instance.status === "stopping" ? "stopped" : finalStatus;
    task.completedAt = new Date().toISOString();
    task.outputPreview = combined.slice(-4000);
    task.exitCode = exitCode;
    task.error = errorText;

    if (instance.status !== "killed") {
      instance.status = task.status === "stopped" ? "idle" : task.status === "failed" ? "failed" : "idle";
    }
    instance.pid = null;
    instance.currentTaskId = null;
    instance.transcript = `${instance.transcript}\n${combined}`.trim();
    instance.lastError = task.error;
    instance.lastActiveAt = new Date().toISOString();

    this.runningTasks.delete(instanceId);
    await this.store.write(state);
  }

  async stop(instanceId: string): Promise<void> {
    const state = await this.store.read();
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    const running = this.runningTasks.get(instanceId);
    if (!instance || !running) {
      throw new Error(`Instance ${instanceId} is not running.`);
    }
    instance.status = "stopping";
    await this.store.write(state);
    running.handle.stop();
  }

  async reset(instanceId: string): Promise<InstanceRecord> {
    const state = await this.store.read();
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance) {
      throw new Error(`Unknown instance: ${instanceId}`);
    }
    if (this.runningTasks.has(instanceId)) {
      await this.stop(instanceId);
    }
    instance.currentTaskId = null;
    instance.pid = null;
    instance.status = "idle";
    instance.lastError = null;
    instance.transcript = "";
    instance.telegramMessageBinding = null;
    instance.lastActiveAt = new Date().toISOString();
    await this.store.write(state);
    return instance;
  }

  async setInstanceCwd(instanceId: string, cwd: string): Promise<InstanceRecord> {
    const state = await this.store.read();
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance) {
      throw new Error(`Unknown instance: ${instanceId}`);
    }
    instance.cwd = cwd;
    instance.lastActiveAt = new Date().toISOString();
    await this.store.write(state);
    return instance;
  }

  async kill(instanceId: string): Promise<void> {
    const state = await this.store.read();
    const instance = state.instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance) {
      throw new Error(`Unknown instance: ${instanceId}`);
    }
    const running = this.runningTasks.get(instanceId);
    if (running) {
      running.handle.kill();
      this.runningTasks.delete(instanceId);
    }
    instance.status = "killed";
    instance.pid = null;
    instance.currentTaskId = null;
    instance.lastError = "Instance killed manually.";
    instance.lastActiveAt = new Date().toISOString();
    if (state.currentInstanceId === instanceId) {
      state.currentInstanceId = null;
    }
    await this.store.write(state);
  }
}
