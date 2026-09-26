// Web 看板**真实浏览器**回归：无头 Chrome 点开任务卡片，验证详情抽屉能打开且没有运行时异常。
// 用法：bun run scripts/verify-web-ui.ts
//
// 为什么必须用真浏览器：`bun test` 与 verify:web 只能证明 HTTP 契约对，
// 证明不了 React 组件渲染时会不会抛异常。
// 真实事故：详情页曾把 task.get 的返回值按 `{ task }` 拆开，
// 点开卡片时抛 `Cannot read properties of undefined (reading 'plan_id')` ——
// 那一层形状错误只有在浏览器里点一次才会暴露。
//
// 找不到 Chrome/Edge 时**跳过并返回 0**（CI 镜像未必带浏览器，不能因此卡门禁）。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "kanban-web-ui-"));
const dbPath = join(dir, "server.db");
const PORT = 7841;
const CDP_PORT = 9341;
const BASE = `http://127.0.0.1:${PORT}`;
const PROJECT = "web-ui";
const CARD_TITLE = "点开我有惊喜";

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((res) => {
    const p = spawn("bun", ["run", "src/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => res({ code: c ?? -1, out, err }));
  });
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const browserPath = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!browserPath) {
  console.log("未找到 Chrome/Edge，跳过 Web UI 回归（不影响其他门禁）");
  process.exit(0);
}

let server: ReturnType<typeof spawn> | null = null;
let browser: ReturnType<typeof spawn> | null = null;
let ws: WebSocket | null = null;

try {
  // ---- 起 project + server ----
  await run(["init", "--db", dbPath, "--name", "web-ui-check"]);
  await run(["admin", "project", "add", PROJECT, "--name", "Web UI 回归", "--db", dbPath]);
  server = spawn("bun", ["run", "src/cli.ts", "serve", "--db", dbPath, "--port", String(PORT), "--quiet"], {
    cwd: ROOT,
    stdio: "pipe",
  });
  let token = "";
  server.stdout?.on("data", (d) => {
    token = /k_[0-9a-f]{32}/.exec(String(d))?.[0] ?? token;
  });
  server.stderr?.on("data", (d) => {
    const s = String(d);
    if (!s.includes("token")) process.stderr.write(`[server] ${s}`);
  });
  await sleep(2500);
  if (!token) throw new Error("未能从 server 启动输出中取得管理员 token");
  const env = { KANBAN_SERVER: BASE, KANBAN_PROJECT: PROJECT, KANBAN_KEY: token };

  // ---- 造一张“时间线/交接/计划”三样都有的卡 ----
  // 注意：plan save 默认就挂到任务上（要“不挂”才加 --no-attach）
  const seeds: string[][] = [
    ["session", "start", "--agent", "pi-fix", "--harness", "pi"],
    ["task", "add", CARD_TITLE, "-p", "0", "--check", "第一步,第二步", "-d", "详情页要能打开"],
    ["task", "claim", "T-0001"],
    ["task", "progress", "T-0001", "--pct", "50", "--check", "第一步", "--note", "做了一半"],
    ["plan", "save", "--task", "T-0001", "--title", "T-0001 的计划", "--body", "1. 修前端 2. 补测试"],
    ["handoff", "--task", "T-0001", "--summary", "交接摘要：前半段完成", "--next", "收尾"],
  ];
  for (const args of seeds) {
    const r = await run(args, env);
    check(`造数据：${args.slice(0, 2).join(" ")}`, r.code === 0, r.code === 0 ? "" : (r.out + r.err).split("\n").slice(-3).join(" "));
  }

  // ---- 无头浏览器 + CDP ----
  browser = spawn(
    browserPath,
    [
      "--headless=new",
      `--user-data-dir=${join(dir, "chrome-profile")}`,
      "--no-first-run",
      "--disable-gpu",
      `--remote-debugging-port=${CDP_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let wsUrl = "";
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as Array<{
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      /* devtools 端口还没起来 */
    }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error("CDP 没连上（Chrome 可能没起来）");

  // 极简 CDP 客户端：按 id 配对请求/响应，事件单独收集
  const pending = new Map<number, (v: unknown) => void>();
  const exceptions: string[] = [];
  const consoleErrors: string[] = [];
  let seq = 0;
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++seq;
    return new Promise<any>((res) => {
      pending.set(id, res);
      ws!.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) {
      throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    }
    return r?.result?.value as T;
  };

  ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws!.onopen = () => res();
    ws!.onerror = () => rej(new Error("CDP WebSocket 连接失败"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; method?: string; params?: any; result?: any };
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      exceptions.push(d?.exception?.description ?? d?.text ?? "unknown");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push((msg.params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" "));
    }
    if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
      consoleErrors.push(msg.params.entry.text);
    }
  };
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");

  // static=1：不建 SSE 长连接（否则页面永远等不到“网络空闲”）
  await send("Page.navigate", { url: `${BASE}/?key=${encodeURIComponent(token)}&project=${PROJECT}&static=1` });
  await sleep(3000);

  const sheetText = () =>
    evaluate<{ role: string; text: string }>(`(() => {
      const sheet = document.querySelector('[role="dialog"]');
      return { role: sheet ? "dialog" : "none", text: sheet ? sheet.innerText : document.body.innerText };
    })()`);
  /** Radix Tabs 在 mousedown 上切换，只派发 click 切不动 */
  const openTab = async (label: string) => {
    const ok = await evaluate<boolean>(`(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(label)}));
      if (!tab) return false;
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      tab.dispatchEvent(new PointerEvent("pointerdown", opts));
      tab.dispatchEvent(new MouseEvent("mousedown", opts));
      tab.dispatchEvent(new PointerEvent("pointerup", opts));
      tab.dispatchEvent(new MouseEvent("mouseup", opts));
      tab.dispatchEvent(new MouseEvent("click", opts));
      return true;
    })()`);
    await sleep(700);
    return ok;
  };

  console.log("\n=== 点开任务详情（真实点击）===");
  const clicked = await evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(CARD_TITLE)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check("找到卡片并点击", clicked);
  await sleep(2000);

  let sheet = await sheetText();
  check("详情抽屉已打开", sheet.role === "dialog", `role=${sheet.role}`);
  check("抽屉显示任务号", sheet.text.includes("T-0001"));
  check("无「plan_id」运行时异常", ![...exceptions, ...consoleErrors].some((e) => e.includes("plan_id")));
  check("无未捕获异常", exceptions.length === 0, exceptions[0]?.split("\n")[0] ?? "");
  check("无控制台 error", consoleErrors.length === 0, [...new Set(consoleErrors)][0]?.slice(0, 120) ?? "");

  console.log("\n=== 三个页签都有数据 ===");
  // 交接角标出现即说明 handoff.list 返回了数据
  const badge = /交接\s*\n?\s*(\d+)/.exec(sheet.text);
  check("交接页签有角标计数（handoff.list 生效）", Number(badge?.[1] ?? 0) > 0, `count=${badge?.[1] ?? "无"}`);
  // 计划页签只有 plan.show 成功才会渲染
  check("有「计划」页签（plan_id + plan.show 生效）", sheet.text.includes("计划"));

  const tabHandoff = await openTab("交接");
  sheet = await sheetText();
  check("交接页签可点开", tabHandoff);
  check("交接内容渲染", sheet.text.includes("交接摘要"), "");

  const tabPlan = await openTab("计划");
  sheet = await sheetText();
  check("计划页签可点开", tabPlan);
  check("计划正文渲染", sheet.text.includes("修前端"), "");

  // ---- 排版回归：几何断言（比看截图可靠）----
  // 真实事故：①任务号与 hover 浮现的操作按钮叠在同一位置，卡片一悬停 id 就被盖住；
  //         ②详情抽屉的进度条放在 SheetContent 根下，左右顶到抽屉边框、上下无空隙。
  console.log("\n=== 排版（几何断言）===");

  // 卡片：任务号与操作按钮不得相交；标题不得被按钮压住
  const cardLayout = await evaluate<{ idVsMenu: number; titleUnderMenu: number; cards: number }>(`(() => {
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    let idVsMenu = 0;
    let titleUnderMenu = 0;
    const cards = [...document.querySelectorAll('[data-slot="task-id"]')];
    for (const id of cards) {
      const card = id.closest('[class*="rounded-lg"]') || id.parentElement;
      const menu = card.querySelector('[aria-label="卡片操作"]');
      if (!menu) continue;
      if (hit(id.getBoundingClientRect(), menu.getBoundingClientRect())) idVsMenu++;
      const title = card.querySelector("button:nth-of-type(2)") || card.querySelectorAll("button")[1];
      if (title && hit(title.getBoundingClientRect(), menu.getBoundingClientRect())) titleUnderMenu++;
    }
    return { idVsMenu, titleUnderMenu, cards: cards.length };
  })()`);
  check("卡片已渲染", cardLayout.cards > 0, `${cardLayout.cards} 张`);
  check("任务号与操作按钮不重叠", cardLayout.idVsMenu === 0, `重叠 ${cardLayout.idVsMenu} 张`);
  check("标题不被操作按钮压住", cardLayout.titleUnderMenu === 0, `被压 ${cardLayout.titleUnderMenu} 张`);

  // 抽屉：进度条左右有内缩（不顶边），且与描述、页签都有空隙
  const sheetLayout = await evaluate<{    inset: number;
    gapToDesc: number;
    gapToTabs: number;
  }>(`(() => {
    const sheet = document.querySelector('[role="dialog"]');
    const header = sheet.querySelector('[data-slot="sheet-header"]');
    const progress = sheet.querySelector('[data-slot="progress"]');
    const desc = sheet.querySelector('[data-slot="sheet-description"]');
    const tabs = sheet.querySelector('[role="tablist"]');
    if (!progress || !header || !desc || !tabs) return { inset: -1, gapToDesc: -1, gapToTabs: -1 };
    const hp = header.getBoundingClientRect();
    const pp = progress.getBoundingClientRect();
    const dp = desc.getBoundingClientRect();
    const tp = tabs.getBoundingClientRect();
    return {
      inset: Math.round(Math.min(pp.left - hp.left, hp.right - pp.right)),
      gapToDesc: Math.round(pp.top - dp.bottom),
      gapToTabs: Math.round(tp.top - pp.bottom),
    };
  })()`);
  check("进度条左右有内缩（>=12px，不顶抽屉边框）", sheetLayout.inset >= 12, `${sheetLayout.inset}px`);
  check("进度条与描述有空隙（>=4px）", sheetLayout.gapToDesc >= 4, `${sheetLayout.gapToDesc}px`);
  check("进度条与页签有空隙（>=8px）", sheetLayout.gapToTabs >= 8, `${sheetLayout.gapToTabs}px`);

  // 卡片操作菜单：菜单项不得折行
  // 真实事故：DropdownMenuContent 默认 `w-(--radix-dropdown-menu-trigger-width)`，
  // 而触发器是 size-6（24px）的图标按钮 → 菜单被压到 128px，“释放（保留进度）”断成两行。
  // 单行菜单项高约 30px（py-1 + text-sm 行高）；一旦折行会明显变高。
  console.log("\n=== 操作菜单不折行 ===");
  // 先关掉详情抽屉：Sheet 是 modal，打开时焦点锁会让看板上的点击全部失效
  await evaluate(`(() => {
    const close = document.querySelector('[data-slot="sheet-close"]');
    if (close) { close.click(); return true; }
    return false;
  })()`);
  await sleep(600);
  const menuItem = await evaluate<{ x: number; y: number } | null>(`(() => {
    const id = document.querySelector('[data-slot="task-id"]');
    if (!id) return null;
    const card = id.closest('[class*="rounded-lg"]');
    const r = card.getBoundingClientRect();
    return { x: Math.round(r.right - 14), y: Math.round(r.top + 12) };
  })()`);
  if (menuItem) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: menuItem.x, y: menuItem.y });
    await sleep(500);
    // Radix 的 DropdownMenuTrigger 监听的是 pointerdown，不是 click
    // （和 Tabs 一样的坑：只派发 click 不会有任何反应）
    await evaluate(`(() => {
      const b = document.querySelector('[aria-label="卡片操作"]');
      if (!b) return false;
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      b.dispatchEvent(new PointerEvent("pointerdown", opts));
      b.dispatchEvent(new MouseEvent("mousedown", opts));
      b.dispatchEvent(new PointerEvent("pointerup", opts));
      b.dispatchEvent(new MouseEvent("mouseup", opts));
      b.dispatchEvent(new MouseEvent("click", opts));
      return true;
    })()`);
    await sleep(600);
    const menu = await evaluate<{ width: number; wrapped: string[]; count: number }>(`(() => {
      const items = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')];
      const content = document.querySelector('[data-slot="dropdown-menu-content"]');
      // 单行项高约 30px；超过 36px 视为折行
      const wrapped = items
        .filter((el) => el.getBoundingClientRect().height > 36)
        .map((el) => el.textContent.trim());
      return { width: content ? Math.round(content.getBoundingClientRect().width) : -1, wrapped, count: items.length };
    })()`);
    check("菜单已打开", menu.count > 0, `${menu.count} 项`);
    check("菜单宽度不是被触发器压窄的", menu.width >= 150, `${menu.width}px`);
    check("菜单项无折行", menu.wrapped.length === 0, menu.wrapped.join("、"));
  }
} catch (e) {
  console.error(`✗ Web UI 回归异常：${String(e).split("\n")[0]}`);
  failures++;
} finally {
  try {
    ws?.close();
  } catch {
    /* 忽略 */
  }
  browser?.kill();
  server?.kill();
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "✓ Web 看板 UI 回归全部通过" : `✗ ${failures} 项未通过`}`);
process.exit(failures === 0 ? 0 : 1);
