import { appendFile } from "node:fs/promises";
import { getAppPaths, loadState, saveState, type AppPaths } from "./config.js";
import type { PersistedState, StreamEvent } from "./domain/types.js";

export class StateStore {
  readonly paths: AppPaths;

  constructor(paths = getAppPaths()) {
    this.paths = paths;
  }

  async read(): Promise<PersistedState> {
    return loadState(this.paths);
  }

  async write(state: PersistedState): Promise<void> {
    await saveState(state, this.paths);
  }

  async appendEvent(event: StreamEvent): Promise<void> {
    await appendFile(this.paths.logFile, `${JSON.stringify(event)}\n`, "utf8");
  }
}
