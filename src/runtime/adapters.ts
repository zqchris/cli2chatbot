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

export function startRuntimeTask(params: {
  runtime: RuntimeKind;
  prompt: string;
  cwd: string;
  config: AppConfig;
}): RuntimeTaskHandle {
  const taskId = nanoid(10);
  const file = executableFor(params.runtime, params.config);
  const args = buildArgs(params.runtime, params.prompt, params.config);
  const term = pty.spawn(file, args, {
    cols: 120,
    rows: 40,
    cwd: path.resolve(params.cwd),
    env: process.env as Record<string, string>,
    name: "xterm-color"
  });

  return {
    taskId,
    pid: term.pid,
    stream: ptyEvents(params.runtime, taskId, term),
    stop: () => term.kill("SIGINT"),
    kill: () => term.kill("SIGKILL")
  };
}
