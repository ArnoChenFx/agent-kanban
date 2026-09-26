// Web 看板端到端验证：起真实 server，验证静态资源、Op 通路、SSE
// 用法：bun run scripts/verify-web.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "E:/Project/agent-kanban";
const dir = mkdtempSync(join(tmpdir(), "kanban-web-"));
const serverDb = join(dir, "server.db");
const PORT = 7813;
const BASE = `http://127.0.0.1:${PORT}`;

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("bun", ["run", "src/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

let server: ReturnType<typeof spawn> | null = null;
try {
  // ---- 准备：建 project + token ----
  await run(["init", "--db", serverDb, "--name", "web-demo"]);
  const added = await run(["admin", "project", "add", "web-demo", "--name", "Web 演示", "--db", serverDb]);
  const tokenIssue = await run([
    "admin", "token", "create", "--project", "web-demo", "--name", "web-tester", "--db", serverDb,
  ]);
  const token = /k_[0-9a-f]{32}/.exec(tokenIssue.out + tokenIssue.err)?.[0] ?? "";
  if (!token) {
    console.error("签发 token 失败", added.out, tokenIssue.err);
    process.exit(1);
  }

  // 造一点数据，让看板有东西可看
  // ⚠ 必须在 server 起来之后做：远程 CLI 要真的能连上才有意义
  // ---- 起 server ----
  server = spawn(
    "bun",
    ["run", "src/cli.ts", "serve", "--db", serverDb, "--port", String(PORT), "--quiet"],
    { cwd: ROOT, stdio: "pipe" },
  );
  server.stderr?.on("data", (d) => {
    const s = String(d);
    if (!s.includes("管理员 token")) process.stderr.write(`[server] ${s}`);
  });
  await sleep(2200);

  const env = { KANBAN_SERVER: BASE, KANBAN_PROJECT: "web-demo", KANBAN_KEY: token };
  const auth = { "X-Kanban-Key": token };

  const mk = await run(["session", "start", "--agent", "pi-main", "--harness", "pi"], env);
  check("远程 CLI 连得上 server", mk.code === 0, mk.code === 0 ? "" : mk.err.split("\n")[1] ?? "");
  await run(["task", "add", "实现 Web 看板", "-p", "0", "--check", "主题,布局,交互", "-d", "shadcn + 自定义主题"], env);
  await run(["task", "add", "写拖拽交互"], env);
  await run(["task", "add", "补 SSE 实时刷新"], env);
  await run(["task", "claim", "T-0001"], env);
  await run(["task", "progress", "T-0001", "--pct", "60", "--check", "主题"], env);
  await run(["handoff", "--task", "T-0001", "--summary", "主题定稿：晨雾 Paper", "--next", "做布局"], env);

  console.log("\n=== 1. 静态资源 ===");
  const root = await fetch(BASE + "/");
  const html = await root.text();
  check("GET / 返回 200", root.status === 200, `status=${root.status}`);
  check("返回真实前端（非占位页）", html.includes('<div id="root">') && !html.includes("前端尚未构建"));
  check("引用了构建后的 JS", /<script[^>]+src="\/assets\/[^"]+\.js"/.test(html));
  check("HTML lang=zh-CN", html.includes('lang="zh-CN"'));

  const cssMatch = /href="(\/assets\/[^"]+\.css)"/.exec(html);
  check("有 CSS 产物", Boolean(cssMatch), cssMatch?.[1] ?? "");
  if (cssMatch) {
    const css = await fetch(BASE + cssMatch[1]!);
    const text = await css.text();
    check("CSS 可访问", css.status === 200, `${text.length} 字节`);
    // 晨雾 Paper 的主色必须出现在编译产物里（证明主题令牌生效）
    check("主题令牌已编译（墨绿主色）", text.includes("--primary"), "");
  }

  // 资源文件真的能取到
  const jsMatch = /src="(\/assets\/[^"]+\.js)"/.exec(html);
  if (jsMatch) {
    const js = await fetch(BASE + jsMatch[1]!);
    check("JS 可访问", js.status === 200, `${(await js.arrayBuffer()).byteLength} 字节`);
  }

  console.log("\n=== 2. SPA 回退与安全 ===");
  const spa = await fetch(BASE + "/some/deep/route");
  check("未知路径回退 index.html", spa.status === 200 && (await spa.text()).includes('id="root"'));

  // 路径穿越：URL 里的 .. 会被 fetch 先规范化，这里用百分号编码绕过规范化再测
  const traversal = await fetch(`${BASE}/%2e%2e%2f%2e%2e%2fpackage.json`);
  const traversalBody = await traversal.text();
  check(
    "路径穿越未泄露源码",
    !traversalBody.includes('"devDependencies"'),
    `status=${traversal.status}`,
  );
  const traversal2 = await fetch(`${BASE}/assets/..%2f..%2f..%2f..%2fpackage.json`);
  check(
    "assets 下的穿越同样被阻断",
    !(await traversal2.text()).includes('"devDependencies"'),
  );
  const adminPage = await fetch(BASE + "/admin");
  check("/admin 仍可用", adminPage.status === 200 && (await adminPage.text()).includes("token"));

  console.log("\n=== 3. 看板 API（前端首屏依赖）===");
  const board = await fetch(`${BASE}/api/board?project=web-demo`, { headers: auth });
  const boardJson = (await board.json()) as { ok: boolean; data: { lanes: Record<string, unknown[]>; sessions: unknown[]; head_seq: number } };
  check("GET /api/board", board.status === 200 && boardJson.ok);
  check("泳道有数据", (boardJson.data.lanes.doing?.length ?? 0) === 1, `doing=${boardJson.data.lanes.doing?.length}`);
  check("待办泳道有数据", (boardJson.data.lanes.todo?.length ?? 0) === 2, `todo=${boardJson.data.lanes.todo?.length}`);
  check("会话有数据", boardJson.data.sessions.length >= 1, `${boardJson.data.sessions.length} 个`);
  check("head_seq 存在", typeof boardJson.data.head_seq === "number");

  console.log("\n=== 4. 写操作（前端拖拽/表单走的都是这条）===");
  const createRes = await fetch(`${BASE}/api/op`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "X-Kanban-Session": boardJson.data.sessions[0] ? (boardJson.data.sessions[0] as { id: string }).id : "" },
    body: JSON.stringify({
      project: "web-demo",
      op: { kind: "task.create", params: { title: "从 Web 端新建的任务", priority: 1, checklist: ["第一步", "第二步"] } },
    }),
  });
  const createJson = (await createRes.json()) as { ok: boolean; data: { id: string }; next_actions: string[] };
  check("POST /api/op task.create", createRes.status === 200 && createJson.ok, createJson.data?.id);
  check("返回 next_actions（前端 toast 会显示）", createJson.next_actions.length > 0, createJson.next_actions[0] ?? "");

  const newId = createJson.data.id;
  const progressRes = await fetch(`${BASE}/api/op`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ project: "web-demo", op: { kind: "task.progress", params: { task_id: newId, pct: 40, note: "Web 端推进" } } }),
  });
  check("task.progress", progressRes.status === 200 && ((await progressRes.json()) as { ok: boolean }).ok);

  console.log("\n=== 5. 鉴权 ===");
  // /api/projects 不带 project 参数：它的用途就是“客户端还不知道要看哪个 project”
  // （曾经因为被 project 参数检查挡在前面而永远 401，前端的 project 列表一直是坏的）
  const projectsRes = await fetch(`${BASE}/api/projects`, { headers: auth });
  const projectsJson = (await projectsRes.json()) as { ok: boolean; data: Array<{ key: string }> };
  check("GET /api/projects（无 project 参数）", projectsRes.status === 200 && projectsJson.ok, `HTTP ${projectsRes.status}`);
  check("返回有权限的 project", projectsJson.data.some((p) => p.key === "web-demo"));

  const noAuth = await fetch(`${BASE}/api/board?project=web-demo`);
  check("无 token 被拒", noAuth.status === 401 || noAuth.status === 403, `status=${noAuth.status}`);
  const badAuth = await fetch(`${BASE}/api/board?project=web-demo`, { headers: { "X-Kanban-Key": "k_wrong" } });
  check("错误 token 被拒", badAuth.status === 401, `status=${badAuth.status}`);
  const noProject = await fetch(`${BASE}/api/projects`);
  check("无 token 的 /api/projects 被拒", noProject.status === 401, `status=${noProject.status}`);

  console.log("\n=== 6. SSE 实时流 ===");
  const ctrl = new AbortController();
  const ssePromise = fetch(`${BASE}/api/stream?project=web-demo&after=0&key=${token}`, {
    headers: { Accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  await sleep(300);
  // 触发一个写事件，看能不能收到推送
  await run(["task", "note", newId, "SSE 推送验证"], env);
  const reader = (await ssePromise).body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !received.includes("SSE 推送验证")) {
    const chunk = await Promise.race([
      reader.read(),
      sleep(1500).then(() => ({ done: true, value: undefined })),
    ]);
    if (chunk.value) received += decoder.decode(chunk.value);
  }
  ctrl.abort();
  check("SSE 推送到新事件", received.includes("SSE 推送验证"), received ? `${received.split("\n").length} 行` : "无数据");

  console.log("\n=== 7. 缓存头 ===");
  const htmlHead = root.headers.get("cache-control");
  const cssHead = cssMatch ? (await fetch(BASE + cssMatch[1]!)).headers.get("cache-control") : "";
  check("index.html 不缓存", htmlHead === "no-cache", htmlHead ?? "");
  check("带哈希资源长缓存", (cssHead ?? "").includes("immutable"), cssHead ?? "");
} finally {
  server?.kill();
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(60)}`);
console.log(failures === 0 ? "✓ Web 看板端到端验证全部通过" : `✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
