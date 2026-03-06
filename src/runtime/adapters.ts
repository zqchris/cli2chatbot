import { spawn } from "node:child_process";
import path from "node:path";
import { nanoid } from "nanoid";
import pty from "node-pty";
import type { IPty } from "node-pty";
import type { AppConfig, RuntimeKind, StreamEvent } from "../domain/types.js";
import { normalizeRuntimeChunk } from "./normalizer.js";

export type RuntimeTaskHandle = {
  taskId: string;
  pid: number;
  stream: AsyncIterable<StreamEvent>;
  stop: () => void;
  kill: () => void;
};

type StreamProcess = {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on: (event: "error" | "close", listener: (...args: unknown[]) => void) => unknown;
  pid?: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function buildArgs(runtime: RuntimeKind, prompt: string, config: AppConfig): string[] {
  if (runtime === "codex") {
    return ["exec", "--skip-git-repo-check", "--json", prompt, ...config.runtimes.codex.defaultArgs];
  }

  return [
    "--print",
    "--output-format=stream-json",
    "--include-partial-messages",
    prompt,
    ...config.runtimes.claude.defaultArgs
  ];
}

function executableFor(runtime: RuntimeKind, config: AppConfig): string {
  return runtime === "codex" ? config.runtimes.codex.path : config.runtimes.claude.path;
}

async function* ptyEvents(runtime: RuntimeKind, taskId: string, term: IPty): AsyncIterable<StreamEvent> {
  const queue: StreamEvent[] = [{ type: "task_started", taskId, timestamp: new Date().toISOString() }];
  let resolver: (() => void) | null = null;
  let done = false;

  const wake = () => {
    if (resolver) {
      resolver();
      resolver = null;
    }
  };

  term.onData((chunk) => {
    queue.push(...normalizeRuntimeChunk(runtime, taskId, chunk));
    wake();
  });

  term.onExit(({ exitCode, signal }) => {
    queue.push({
      type: "exit",
      taskId,
      code: exitCode,
      signal: signal ? String(signal) : undefined,
      timestamp: new Date().toISOString()
    });
    done = true;
    wake();
  });

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
      continue;
    }
    yield queue.shift() as StreamEvent;
  }
}

async function* processEvents(runtime: RuntimeKind, taskId: string, child: StreamProcess): AsyncIterable<StreamEvent> {
  const queue: StreamEvent[] = [{ type: "task_started", taskId, timestamp: new Date().toISOString() }];
  let resolver: (() => void) | null = null;
  let done = false;

  const wake = () => {
    if (resolver) {
      resolver();
      resolver = null;
    }
  };

  const pushChunk = (chunk: string) => {
    queue.push(...normalizeRuntimeChunk(runtime, taskId, chunk));
    wake();
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    pushChunk(String(chunk));
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    pushChunk(String(chunk));
  });

  child.on("error", (error) => {
    queue.push({
      type: "error",
      taskId,
      text: String(error),
      timestamp: new Date().toISOString()
    });
    wake();
  });

  child.on("close", (code, signal) => {
    queue.push({
      type: "exit",
      taskId,
      code: typeof code === "number" ? code : null,
      signal: typeof signal === "string" ? signal : undefined,
      timestamp: new Date().toISOString()
    });
    done = true;
    wake();
  });

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
      continue;
    }
    yield queue.shift() as StreamEvent;
  }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export function startRuntimeTask(params: {
  runtime: RuntimeKind;
  prompt: string;
  cwd: string;
  config: AppConfig;
}): RuntimeTaskHandle {
  const taskId = nanoid(10);
  const file = executableFor(params.runtime, params.config);
  const args = buildArgs(params.runtime, params.prompt, params.config);
  const cwd = path.resolve(params.cwd);
  const env = processEnv();

  try {
    const term = pty.spawn(file, args, {
      cols: 120,
      rows: 40,
      cwd,
      env,
      name: "xterm-color"
    });

    return {
      taskId,
      pid: term.pid,
      stream: ptyEvents(params.runtime, taskId, term),
      stop: () => term.kill("SIGINT"),
      kill: () => term.kill("SIGKILL")
    };
  } catch (error) {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const stream = (async function* (): AsyncIterable<StreamEvent> {
      yield {
        type: "status",
        taskId,
        text: "终端兼容模式已启用，正在继续执行任务。",
        timestamp: new Date().toISOString()
      };
      for await (const event of processEvents(params.runtime, taskId, child)) {
        yield event;
      }
    })();

    return {
      taskId,
      pid: child.pid ?? 0,
      stream,
      stop: () => void child.kill("SIGINT"),
      kill: () => void child.kill("SIGKILL")
    };
  }
}
