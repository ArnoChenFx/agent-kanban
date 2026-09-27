// Web 看板端到端验证：起真实 server，验证静态资源、Op 通路、SSE
// 用法：bun run scripts/verify-web.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 仓库根目录：从本脚本位置推导，不能写死绝对路径（CI 克隆路径不同）
const ROOT = resolve(import.meta.dir, "..");
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
    if (!s.includes("Admin token:")) process.stderr.write(`[server] ${s}`);
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
  await run(["handoff", "--task", "T-0001", "--summary", "主题定稿：中性灰 + 白底，状态色保留彩色", "--next", "做布局"], env);

  console.log("\n=== 1. 静态资源 ===");
  const root = await fetch(BASE + "/");
  const html = await root.text();
  check("GET / 返回 200", root.status === 200, `status=${root.status}`);
  check("返回真实前端（非占位页）", html.includes('<div id="root">') && !html.includes("has not been built yet"));
  check("引用了构建后的 JS", /<script[^>]+src="\/assets\/[^"]+\.js"/.test(html));
  check("HTML lang=zh-CN", html.includes('lang="zh-CN"'));

  const cssMatch = /href="(\/assets\/[^"]+\.css)"/.exec(html);
  check("有 CSS 产物", Boolean(cssMatch), cssMatch?.[1] ?? "");
  if (cssMatch) {
    const css = await fetch(BASE + cssMatch[1]!);
    const text = await css.text();
    check("CSS 可访问", css.status === 200, `${text.length} 字节`);
    // 主题令牌必须出现在编译产物里（证明 index.css 被打进了 bundle）
    check("主题令牌已编译", text.includes("--primary"), "");
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

  // 详情页那条链路：前端点开卡片后 fetchTaskDetail 发的三个 Op。
  // 曾经的真实故障：task.get 的 data 被前端按 { task } 拆开 → 读 plan_id 崩；
  // handoff.list / task.transition 前端在调、服务端没实现（静默失效）。
  console.log("\n=== 4.1 任务详情链路（点开单卡走这条）===");
  const op = async (kind: string, params: Record<string, unknown>) => {
    const res = await fetch(`${BASE}/api/op`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ project: "web-demo", op: { kind, params } }),
    });
    return (await res.json()) as { ok: boolean; data?: Record<string, unknown> & Record<string, unknown>[]; error?: { code: number; message: string } };
  };

  const detail = await op("task.get", { task_id: newId, timeline: true, tail: 20 });
  check("task.get 成功", detail.ok, detail.error?.message ?? "");
  const d = (detail.data ?? {}) as Record<string, unknown>;
  check("data 就是任务本体（无 { task } 包装）", d.id === newId && !("task" in d), `id=${d.id}`);
  check("含 plan_id 字段（前端用它决定要不要拉计划）", "plan_id" in d);
  check("timeline 同响应返回（前端省一次往返）", Array.isArray(d.timeline) && (d.timeline as unknown[]).length > 0);

  const handoffs = await op("handoff.list", { task_id: newId });
  check("handoff.list 存在且返回数组", handoffs.ok && Array.isArray(handoffs.data), handoffs.error?.message ?? "");
  console.log("\n=== 4.2 事件字段形状（时间线上显示的“session 名”）===");
// 曾经的真实故障：事件是驼峰领域对象直出（sessionId/taskId/…），
// 前端 task-detail.tsx 读 e.session_id 恒为 undefined → 每条都走 `?? "system"` 兜底，
// 于是**每张卡的时间线都显示 system**，而库里 session_id 本来是真值。
// 不报错、不空屏，只是全错，所以只能在 HTTP 契约这一层钉。
const timeline = (d.timeline ?? []) as Array<Record<string, unknown>>;
const camelLeak = timeline.filter((e) => "sessionId" in e || "taskId" in e || "projectKey" in e);
check("timeline 无驼峰键（没有绕过 eventToJson）", camelLeak.length === 0, `泄漏 ${camelLeak.length} 条`);
const noSession = timeline.filter((e) => !("session_id" in e));
check("每条事件都带 session_id", noSession.length === 0, `缺 ${noSession.length} 条`);
// 注意 session_id 允许是 null：那表示“这次操作没关联会话”（本节里那条
// task.progress 就没带 X-Kanban-Session 头），前端把它显示成 system 是**对的**。
// 修复前的 bug 是**每一条**都显示 system——连明明有会话的也不显示。
const sessionValues = timeline.map((e) => String(e.session_id));
check(
  "session_id 真送到了前端（有会话的事件显示 s-xxx）",
  sessionValues.some((v) => /^s-[0-9a-z]+$/.test(v)),
  sessionValues.join(","),
);
check(
  "数据里没有 system 这个占位值（那是前端渲染时的兜底，不是存的值）",
  !sessionValues.includes("system"),
  sessionValues.join(","),
);
// /api/events 是同一份数据的另一个出口，两边不能漂移
const eventsRes = await fetch(`${BASE}/api/events?project=web-demo&after=0&limit=200`, { headers: auth });
const eventsJson = (await eventsRes.json()) as { ok: boolean; data?: Array<Record<string, unknown>> };
const allEvents = eventsJson.data ?? [];
check(
  "/api/events 与 Op 同形（都过 eventToJson）",
  allEvents.length > 0 &&
    allEvents.every((e) => "session_id" in e) &&
    allEvents.every((e) => !("sessionId" in e)),
  `${allEvents.length} 条`,
);

const trans = await op("task.transition", { task_id: newId, to: "blocked", reason: "等接口定稿" });
  check("task.transition 能改状态", trans.ok && (trans.data as { status?: string } | undefined)?.status === "blocked", trans.error?.message ?? "");

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
  // SSE 与 /api/op 是两个独立出口，payload 形状也必须一致（否则看板收事件那条路又默默失效）
  const sseDataLine = received.split("\n").find((l) => l.startsWith("data: "));
  const sseEvent = sseDataLine ? (JSON.parse(sseDataLine.slice(6)) as Record<string, unknown>) : null;
  check(
    "SSE 事件也走 eventToJson（带 session_id，无驼峰键）",
    sseEvent !== null && "session_id" in sseEvent && !("sessionId" in sseEvent),
    sseEvent ? Object.keys(sseEvent).join(",") : "未收到事件",
  );

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
