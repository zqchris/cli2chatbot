import Fastify from "fastify";
import type { BridgeApp } from "../app.js";

export async function createWebServer(app: BridgeApp) {
  const server = Fastify({ logger: false });

  server.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
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
      .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      .btn { border: 0; border-radius: 10px; padding: 7px 12px; cursor: pointer; font-size: 12px; font-weight: 600; background: #0f766e; color: #fff; }
      .btn.secondary { background: #44403c; }
      .btn.danger { background: #b91c1c; }
      .btn.small { padding: 5px 8px; font-size: 11px; }
      .ops { display: flex; gap: 6px; flex-wrap: wrap; }
      .notice { margin-top: 8px; color: #0f766e; font-size: 12px; min-height: 18px; }
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
/cwd &lt;path&gt;
/ask &lt;prompt&gt;
/stop
/reset
/kill
/logs</div>
      </div>
      <div id="notice" class="notice"></div>
      <div id="app">Loading...</div>
    </main>
    <script>
      async function postJson(url, body) {
        const hasBody = body !== undefined;
        const res = await fetch(url, {
          method: 'POST',
          headers: hasBody ? { 'content-type': 'application/json' } : undefined,
          body: hasBody ? JSON.stringify(body) : undefined
        });
        return res.json();
      }

      function showNotice(text, isError) {
        const el = document.getElementById('notice');
        el.style.color = isError ? '#b91c1c' : '#0f766e';
        el.textContent = text;
      }

      async function action(label, fn) {
        try {
          const result = await fn();
          if (!result.ok) {
            showNotice(label + ' 失败: ' + (result.message || 'unknown error'), true);
            return;
          }
          showNotice(label + ' 成功');
          await load();
        } catch (error) {
          showNotice(label + ' 失败: ' + String(error), true);
        }
      }

      window.createInstance = async function(runtime) {
        await action('创建实例', () => postJson('/api/instances', { runtime }));
      }

      window.useInstance = async function(instanceId) {
        await action('切换实例', () => postJson('/api/instances/' + instanceId + '/use'));
      }

      window.stopInstance = async function(instanceId) {
        await action('停止任务', () => postJson('/api/instances/' + instanceId + '/stop'));
      }

      window.resetInstance = async function(instanceId) {
        await action('重置实例', () => postJson('/api/instances/' + instanceId + '/reset'));
      }

      window.killInstance = async function(instanceId) {
        await action('强杀实例', () => postJson('/api/instances/' + instanceId + '/kill'));
      }

      window.approveAuth = async function(userId) {
        await action('批准授权', () => postJson('/api/auth/approve/' + userId));
      }

      window.revokeAuth = async function(userId) {
        if (!confirm('确认撤销用户 ' + userId + ' 的授权吗？')) {
          return;
        }
        await action('撤销授权', () => postJson('/api/auth/revoke/' + userId));
      }

      window.showLogs = async function(instanceId) {
        try {
          const res = await fetch('/api/instances/' + instanceId + '/logs');
          const payload = await res.json();
          if (!payload.ok) {
            showNotice('读取日志失败: ' + (payload.message || 'unknown error'), true);
            return;
          }
          const log = payload.data?.transcript?.trim() || '暂无日志。';
          alert(log.slice(-5000));
        } catch (error) {
          showNotice('读取日志失败: ' + String(error), true);
        }
      }

      async function load() {
        const [statusRes, instancesRes, authPendingRes, authAllowedRes] = await Promise.all([
          fetch('/api/status'),
          fetch('/api/instances'),
          fetch('/api/auth/pending'),
          fetch('/api/auth/allowed')
        ]);
        const status = await statusRes.json();
        const instances = await instancesRes.json();
        const authPending = await authPendingRes.json();
        const authAllowed = await authAllowedRes.json();
        const state = status.data;
        const rows = instances.data.map((instance) => '<tr>' +
          '<td>' + instance.instanceId + '</td>' +
          '<td>' + instance.runtime + '</td>' +
          '<td>' + instance.status + '</td>' +
          '<td>' + instance.cwd + '</td>' +
          '<td>' + (instance.currentTaskId || '-') + '</td>' +
          '<td>' + instance.lastActiveAt + '</td>' +
          '<td><div class="ops">' +
            '<button class="btn small secondary" onclick="useInstance(\\'' + instance.instanceId + '\\')">使用</button>' +
            '<button class="btn small secondary" onclick="stopInstance(\\'' + instance.instanceId + '\\')">停止</button>' +
            '<button class="btn small secondary" onclick="resetInstance(\\'' + instance.instanceId + '\\')">重置</button>' +
            '<button class="btn small danger" onclick="killInstance(\\'' + instance.instanceId + '\\')">强杀</button>' +
            '<button class="btn small" onclick="showLogs(\\'' + instance.instanceId + '\\')">日志</button>' +
          '</div></td>' +
          '</tr>').join('');
        const authRows = authPending.data.map((request) => '<tr>' +
          '<td>' + request.userId + '</td>' +
          '<td>' + ((request.firstName || '-') + (request.username ? ' (@' + request.username + ')' : '')) + '</td>' +
          '<td>' + request.requestedAt + '</td>' +
          '<td>' + (request.lastSeenText || '-') + '</td>' +
          '<td><button class="btn small" onclick="approveAuth(\\'' + request.userId + '\\')">批准</button></td>' +
          '</tr>').join('');
        const allowedRows = authAllowed.data.map((user) => '<tr>' +
          '<td>' + user.userId + '</td>' +
          '<td>' + ((user.firstName || '-') + (user.username ? ' (@' + user.username + ')' : '')) + '</td>' +
          '<td>' + user.connectionStatus + '</td>' +
          '<td>' + (user.boundInstances || 0) + '</td>' +
          '<td>' + (user.lastSeenAt || '-') + '</td>' +
          '<td>' + (user.lastSeenText || '-') + '</td>' +
          '<td><button class="btn small danger" onclick="revokeAuth(\\'' + user.userId + '\\')">踢掉</button></td>' +
          '</tr>').join('');
        const onlineUsers = authAllowed.data.filter((user) => user.connectionStatus === 'online' || user.connectionStatus === 'running').length;
        document.getElementById('app').innerHTML =
          '<div class="grid">' +
            '<div class="card"><div class="label">daemon 进程</div><div class="value">' + (state.daemon.pid || '-') + '</div></div>' +
            '<div class="card"><div class="label">实例数量</div><div class="value">' + state.instances.length + '</div></div>' +
            '<div class="card"><div class="label">任务数量</div><div class="value">' + state.tasks.length + '</div></div>' +
            '<div class="card"><div class="label">待授权请求</div><div class="value">' + authPending.data.length + '</div></div>' +
            '<div class="card"><div class="label">授权用户</div><div class="value">' + authAllowed.data.length + '</div></div>' +
            '<div class="card"><div class="label">在线授权用户</div><div class="value">' + onlineUsers + '</div></div>' +
            '<div class="card"><div class="label">Telegram 最近更新</div><div class="value" style="font-size:13px;">' + (state.daemon.lastTelegramUpdateAt || '-') + '</div></div>' +
            '<div class="card"><div class="label">Telegram 错误</div><div class="value" style="font-size:13px;">' + (state.daemon.lastTelegramError || '-') + '</div></div>' +
          '</div>' +
          '<div class="section-title">已授权 Telegram 用户</div>' +
          '<table><thead><tr><th>User ID</th><th>账号</th><th>连接</th><th>绑定实例</th><th>最近活跃</th><th>最近消息</th><th>操作</th></tr></thead><tbody>' +
            (allowedRows || '<tr><td colspan="7">当前没有授权用户。</td></tr>') +
          '</tbody></table>' +
          '<div class="section-title">待授权 Telegram 用户</div>' +
          '<table><thead><tr><th>User ID</th><th>账号</th><th>请求时间</th><th>最近消息</th><th>操作</th></tr></thead><tbody>' +
            (authRows || '<tr><td colspan="5">当前没有待授权请求。</td></tr>') +
          '</tbody></table>' +
          '<div class="section-title">受管实例</div>' +
          '<div class="toolbar">' +
            '<button class="btn" onclick="createInstance(\\'codex\\')">新建 Codex 实例</button>' +
            '<button class="btn" onclick="createInstance(\\'claude\\')">新建 Claude 实例</button>' +
          '</div>' +
          '<table><thead><tr><th>ID</th><th>运行时</th><th>状态</th><th>工作目录</th><th>当前任务</th><th>最后活跃</th><th>操作</th></tr></thead><tbody>' +
            (rows || '<tr><td colspan="7">当前还没有实例。</td></tr>') +
          '</tbody></table>' +
          '<div class="section-title">最近输出预览</div>' +
          '<div class="log">' + (state.tasks[0]?.outputPreview || '当前还没有任务输出。') + '</div>';
      }
      load();
      setInterval(load, 5000);
    </script>
  </body>
</html>`);
  });

  server.get("/api/status", async () => app.commandStatus());
  server.get("/api/instances", async () => app.commandInstances());
  server.get("/api/auth/pending", async () => app.commandPendingAuth());
  server.get("/api/auth/allowed", async () => app.commandAuthorizedUsers());
  server.post<{ Params: { userId: string } }>("/api/auth/approve/:userId", async (request) =>
    app.commandApproveAuth(request.params.userId)
  );
  server.post<{ Params: { userId: string } }>("/api/auth/revoke/:userId", async (request) =>
    app.commandRevokeAuth(request.params.userId)
  );
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
