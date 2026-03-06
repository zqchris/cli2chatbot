import type { AppConfig, CommandResult, InstanceRecord, PersistedState } from "./domain/types.js";

function baseUrl(config: AppConfig): string {
  return `http://${config.web.host}:${config.web.port}`;
}

async function call<T>(
  config: AppConfig,
  method: string,
  pathname: string,
  body?: unknown
): Promise<CommandResult<T>> {
  const response = await fetch(`${baseUrl(config)}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    throw new Error(`Local control API failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<CommandResult<T>>;
}

export async function daemonAvailable(config: AppConfig): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl(config)}/api/status`);
    return response.ok;
  } catch {
    return false;
  }
}

export const controlClient = {
  status: (config: AppConfig) => call<PersistedState>(config, "GET", "/api/status"),
  instances: (config: AppConfig) => call<InstanceRecord[]>(config, "GET", "/api/instances"),
  startInstance: (config: AppConfig, runtime: "codex" | "claude") =>
    call<InstanceRecord>(config, "POST", "/api/instances", { runtime }),
  useInstance: (config: AppConfig, instanceId: string) =>
    call<InstanceRecord>(config, "POST", `/api/instances/${instanceId}/use`),
  stopInstance: (config: AppConfig, instanceId: string) =>
    call(config, "POST", `/api/instances/${instanceId}/stop`),
  resetInstance: (config: AppConfig, instanceId: string) =>
    call<InstanceRecord>(config, "POST", `/api/instances/${instanceId}/reset`),
  killInstance: (config: AppConfig, instanceId: string) =>
    call(config, "POST", `/api/instances/${instanceId}/kill`),
  logs: (config: AppConfig, instanceId: string) =>
    call<{ transcript: string }>(config, "GET", `/api/instances/${instanceId}/logs`)
};
