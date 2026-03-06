export type RuntimeKind = "codex" | "claude";

export type InstanceStatus =
  | "starting"
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "killed";

export type TaskStatus = "running" | "success" | "failed" | "stopped" | "killed";

export type StreamEvent =
  | { type: "task_started"; taskId: string; timestamp: string }
  | { type: "partial_text"; taskId: string; text: string; timestamp: string }
  | { type: "tool_event"; taskId: string; text: string; timestamp: string }
  | { type: "status"; taskId: string; text: string; timestamp: string }
  | { type: "final_text"; taskId: string; text: string; timestamp: string }
  | { type: "error"; taskId: string; text: string; timestamp: string }
  | { type: "exit"; taskId: string; code: number | null; signal?: string; timestamp: string };

export type InstanceRecord = {
  instanceId: string;
  runtime: RuntimeKind;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  pid: number | null;
  currentTaskId: string | null;
  status: InstanceStatus;
  lastError: string | null;
  telegramMessageBinding: {
    chatId: string;
    messageId: number;
  } | null;
  transcript: string;
};

export type TaskRecord = {
  taskId: string;
  instanceId: string;
  runtime: RuntimeKind;
  prompt: string;
  status: TaskStatus;
  startedAt: string;
  completedAt: string | null;
  outputPreview: string;
  exitCode: number | null;
  error: string | null;
};

export type PendingAuthRequest = {
  userId: string;
  chatId: string;
  username: string | null;
  firstName: string | null;
  requestedAt: string;
  lastSeenText: string | null;
};

export type KnownTelegramUser = {
  userId: string;
  chatId: string;
  username: string | null;
  firstName: string | null;
  lastSeenAt: string;
  lastSeenText: string | null;
};

export type RuntimeConfig = {
  path: string;
  defaultArgs: string[];
};

export type AppConfig = {
  telegram: {
    botToken: string;
    allowedUserIds: string[];
    pollingMode: "long-polling";
  };
  runtimes: {
    defaultCwd: string;
    codex: RuntimeConfig;
    claude: RuntimeConfig;
  };
  instances: {
    maxRunningPerRuntime: number;
    idleTimeoutMinutes: number;
    autoCleanupOrphans: boolean;
  };
  web: {
    enabled: boolean;
    host: string;
    port: number;
  };
};

export type PersistedState = {
  currentInstanceId: string | null;
  currentInstanceByRuntime: Partial<Record<RuntimeKind, string>>;
  pendingAuthRequests: PendingAuthRequest[];
  knownTelegramUsers: KnownTelegramUser[];
  instances: InstanceRecord[];
  tasks: TaskRecord[];
  daemon: {
    pid: number | null;
    startedAt: string | null;
    lastHeartbeatAt: string | null;
    lastTelegramUpdateAt: string | null;
    lastTelegramError: string | null;
  };
};

export type DoctorResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export type CommandResult<T = unknown> = {
  ok: boolean;
  message: string;
  data?: T;
};
