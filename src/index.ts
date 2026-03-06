import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import { createDefaultConfig, ensureAppDir, getAppPaths, loadConfig, saveConfig } from "./config.js";
import { BridgeApp } from "./app.js";
import { controlClient, daemonAvailable } from "./control-client.js";
import { acquireDaemonLock } from "./daemon-lock.js";
import { runSmoke } from "./smoke.js";
import { createWebServer } from "./web/server.js";

const program = new Command();

program.name("cli2chatbot").description("Bridge Codex CLI and Claude CLI to Telegram.");

program
  .command("init")
  .description("Create local configuration.")
  .option("--bot-token <token>")
  .option("--allowed-user <id>")
  .option("--cwd <path>")
  .option("--codex-path <path>")
  .option("--claude-path <path>")
  .action(async (options) => {
    await ensureAppDir();
    const rl = createInterface({ input, output });
    const botToken = options.botToken ?? await rl.question("Telegram bot token: ");
    const allowedUser = options.allowedUser ?? await rl.question("Allowed Telegram user id (optional, press enter to skip): ");
    const cwd = options.cwd ?? ((await rl.question("Default working directory: ")) || process.cwd());
    const codexPath = options.codexPath ?? ((await rl.question("Codex executable path [codex]: ")) || "codex");
    const claudePath = options.claudePath ?? ((await rl.question("Claude executable path [claude]: ")) || "claude");
    rl.close();

    const config = createDefaultConfig({
      telegram: { botToken, allowedUserIds: allowedUser ? [allowedUser] : [], pollingMode: "long-polling" },
      runtimes: {
        defaultCwd: cwd,
        codex: { path: codexPath, defaultArgs: [] },
        claude: { path: claudePath, defaultArgs: [] }
      }
    });
    await saveConfig(config);
    output.write(`Saved config to ${getAppPaths().configFile}\n`);
  });

program
  .command("serve")
  .description("Run the Telegram bridge daemon.")
  .action(async () => {
    await ensureAppDir();
    const config = await loadConfig();
    let lock: Awaited<ReturnType<typeof acquireDaemonLock>>;
    try {
      lock = await acquireDaemonLock(getAppPaths());
    } catch (error) {
      output.write(`${String(error)}\n`);
      process.exitCode = 1;
      return;
    }
    const app = new BridgeApp(config);
    const web = await createWebServer(app);

    const shutdown = async () => {
      await lock.release();
      await web.close().catch(() => undefined);
    };

    process.on("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.on("uncaughtException", (error) => {
      output.write(`Fatal daemon error: ${String(error)}\n`);
      void shutdown().finally(() => process.exit(1));
    });

    if (config.web.enabled) {
      await web.listen({ host: config.web.host, port: config.web.port });
      output.write(`Web panel on http://${config.web.host}:${config.web.port}\n`);
    }
    try {
      await app.runTelegramLoop();
    } finally {
      await shutdown();
    }
  });

program
  .command("status")
  .description("Show daemon state snapshot.")
  .action(async () => {
    const config = await loadConfig();
    const result = (await daemonAvailable(config))
      ? await controlClient.status(config)
      : await new BridgeApp(config).commandStatus();
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  });

const instances = program.command("instances").description("Manage instances.");

instances
  .command("list")
  .action(async () => {
    const config = await loadConfig();
    const result = (await daemonAvailable(config))
      ? await controlClient.instances(config)
      : await new BridgeApp(config).commandInstances();
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  });

instances
  .command("start")
  .requiredOption("--runtime <runtime>")
  .action(async (options) => {
    const config = await loadConfig();
    const result = (await daemonAvailable(config))
      ? await controlClient.startInstance(config, options.runtime)
      : await new BridgeApp(config).commandCreateInstance(options.runtime);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  });

instances
  .command("stop")
  .argument("<instanceId>")
  .action(async (instanceId) => {
    const config = await loadConfig();
    const result = (await daemonAvailable(config))
      ? await controlClient.stopInstance(config, instanceId)
      : await new BridgeApp(config).commandStop(instanceId);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  });

instances
  .command("reset")
  .argument("<instanceId>")
  .action(async (instanceId) => {
    const config = await loadConfig();
    const result = (await daemonAvailable(config))
      ? await controlClient.resetInstance(config, instanceId)
      : await new BridgeApp(config).commandReset(instanceId);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  });

instances
  .command("kill")
  .argument("<instanceId>")
  .action(async (instanceId) => {
    const config = await loadConfig();
    const result = (await daemonAvailable(config))
      ? await controlClient.killInstance(config, instanceId)
      : await new BridgeApp(config).commandKill(instanceId);
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("doctor")
  .description("Run local diagnostics.")
  .action(async () => {
    const app = new BridgeApp(await loadConfig());
    output.write(`${JSON.stringify(await app.doctor(), null, 2)}\n`);
  });

program
  .command("smoke")
  .description("Run local simulated Telegram roundtrip smoke test for runtime communication.")
  .option("--runtime <runtime>", "codex | claude | both", "both")
  .option("--timeout-ms <ms>", "per-runtime timeout in milliseconds", "70000")
  .action(async (options) => {
    const runtimeOption = String(options.runtime ?? "both");
    const timeoutMs = Number(options.timeoutMs ?? "70000");
    const runtimes: Array<"codex" | "claude"> =
      runtimeOption === "codex" ? ["codex"] : runtimeOption === "claude" ? ["claude"] : ["codex", "claude"];
    const results = [];
    for (const runtime of runtimes) {
      const result = await runSmoke(runtime, timeoutMs);
      results.push(result);
    }
    output.write(`${JSON.stringify({ ok: results.every((item) => item.ok), results }, null, 2)}\n`);
    if (!results.every((item) => item.ok)) {
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
