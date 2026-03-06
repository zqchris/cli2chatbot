import Fastify from "fastify";
import type { BridgeApp } from "../app.js";

export async function createWebServer(app: BridgeApp) {
  const server = Fastify({ logger: false });

  server.get("/", async () => {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>cli2chatbot</title>
    <style>
      :root { color-scheme: light; --bg: #f4f1ea; --fg: #171717; --accent: #0f766e; --card: #fffdf8; --muted: #6b7280; }
      body { margin: 0; font-family: "IBM Plex Sans", "Helvetica Neue", sans-serif; background: radial-gradient(circle at top, #fff9ec, var(--bg)); color: var(--fg); }
      main { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
      h1 { font-family: "IBM Plex Mono", monospace; font-size: 28px; margin: 0 0 8px; }
      .sub { color: var(--muted); margin-bottom: 24px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
      .card { background: var(--card); border: 1px solid #e5dfd0; border-radius: 16px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
      .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
      .value { font-size: 22px; margin-top: 8px; }
      .intro { margin: 18px 0 22px; display: grid; grid-template-columns: 1.2fr .8fr; gap: 16px; }
      .intro p { margin: 0; line-height: 1.6; color: #333; }
      .tips { font-family: "IBM Plex Mono", monospace; font-size: 12px; background: #171717; color: #f5f5f5; border-radius: 16px; padding: 16px; white-space: pre-wrap; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; background: var(--card); border-radius: 16px; overflow: hidden; }
      th, td { text-align: left; padding: 12px; border-bottom: 1px solid #ece5d9; font-size: 14px; }
      th { color: var(--muted); font-weight: 600; }
      .log { white-space: pre-wrap; font-family: "IBM Plex Mono", monospace; font-size: 12px; max-height: 280px; overflow: auto; background: #171717; color: #f5f5f5; border-radius: 16px; padding: 16px; margin-top: 20px; }
      .section-title { margin-top: 28px; margin-bottom: 10px; font-size: 14px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
      @media (max-width: 760px) { .intro { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <h1>cli2chatbot</h1>
      <div class="sub">Telegram 驱动的 Codex / Claude 本地控制面板。</div>
      <div class="intro">
        <div class="card">
          <p>
            这是 bridge daemon 的本地监控界面。远程控制主要走 Telegram 私聊，
            这个页面负责在本机查看实例状态、任务输出预览，以及做基础排障。
          </p>
        </div>
        <div class="tips">/start_codex
/start_claude
/use &lt;instanceId&gt;
/ask &lt;prompt&gt;
/stop
/reset
/kill
/logs</div>
      </div>
      <div id="app">Loading...</div>
    </main>
    <script>
      async function load() {
        const [statusRes, instancesRes] = await Promise.all([fetch('/api/status'), fetch('/api/instances')]);
        const status = await statusRes.json();
        const instances = await instancesRes.json();
        const state = status.data;
        const rows = instances.data.map((instance) => '<tr>' +
          '<td>' + instance.instanceId + '</td>' +
          '<td>' + instance.runtime + '</td>' +
          '<td>' + instance.status + '</td>' +
          '<td>' + (instance.currentTaskId || '-') + '</td>' +
          '<td>' + instance.lastActiveAt + '</td>' +
          '</tr>').join('');
        document.getElementById('app').innerHTML =
          '<div class="grid">' +
            '<div class="card"><div class="label">daemon 进程</div><div class="value">' + (state.daemon.pid || '-') + '</div></div>' +
            '<div class="card"><div class="label">实例数量</div><div class="value">' + state.instances.length + '</div></div>' +
            '<div class="card"><div class="label">任务数量</div><div class="value">' + state.tasks.length + '</div></div>' +
          '</div>' +
          '<div class="section-title">受管实例</div>' +
          '<table><thead><tr><th>ID</th><th>运行时</th><th>状态</th><th>当前任务</th><th>最后活跃</th></tr></thead><tbody>' +
            (rows || '<tr><td colspan="5">当前还没有实例。</td></tr>') +
          '</tbody></table>' +
          '<div class="section-title">最近输出预览</div>' +
          '<div class="log">' + (state.tasks[0]?.outputPreview || '当前还没有任务输出。') + '</div>';
      }
      load();
      setInterval(load, 5000);
    </script>
  </body>
</html>`;
  });

  server.get("/api/status", async () => app.commandStatus());
  server.get("/api/instances", async () => app.commandInstances());
  server.post<{ Body: { runtime: "codex" | "claude" } }>("/api/instances", async (request) => {
    return app.commandCreateInstance(request.body.runtime);
  });
  server.post<{ Params: { instanceId: string } }>("/api/instances/:instanceId/use", async (request) =>
    app.commandUseInstance(request.params.instanceId)
  );
  server.post<{ Params: { instanceId: string } }>("/api/instances/:instanceId/stop", async (request) =>
    app.commandStop(request.params.instanceId)
  );
  server.post<{ Params: { instanceId: string } }>("/api/instances/:instanceId/reset", async (request) =>
    app.commandReset(request.params.instanceId)
  );
  server.post<{ Params: { instanceId: string } }>("/api/instances/:instanceId/kill", async (request) =>
    app.commandKill(request.params.instanceId)
  );
  server.get<{ Params: { instanceId: string } }>("/api/instances/:instanceId/logs", async (request) =>
    app.commandLogs(request.params.instanceId)
  );

  return server;
}
