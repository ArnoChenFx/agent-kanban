// Web 看板**真实浏览器**回归：无头 Chrome 点开任务卡片，验证详情抽屉能打开且没有运行时异常。
// 用法：bun run scripts/verify-web-ui.ts
//
// 为什么必须用真浏览器：`bun test` 与 verify:web 只能证明 HTTP 契约对，
// 证明不了 React 组件渲染时会不会抛异常。
// 真实事故：详情页曾把 task.get 的返回值按 `{ task }` 拆开，
// 点开卡片时抛 `Cannot read properties of undefined (reading 'plan_id')` ——
// 那一层形状错误只有在浏览器里点一次才会暴露。
//
// 界面语言：浏览器用 --lang=zh-CN 启动，**固定中文**。看板会根据 navigator.language
// 自动选语言（这是产品行为），所以不钉住它的话，英文系统上跑本脚本连“点开卡片”
// 那一步都过不了（断言写的是中文文案）。双语本身在末尾单独有一节断言。
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

  // ---- 造一张“描述/检查项/依赖 + 时间线/交接/计划”全都有的卡 ----
  // 注意：plan save 默认就挂到任务上（要“不挂”才加 --no-attach）
  // 上游任务放在最后建：这样 CARD_TITLE 仍然是 T-0001，脚本后面的断言不用改
  //
  // ⚠ **不能靠 `session start` 写默认会话文件**：它只在**本地模式**写
  //   （`src/commands/session.ts`：`ctx.backend.mode === "local"`），
  //   而本脚本全程带 KANBAN_SERVER，走的是远程模式。脚本以前依赖那个文件，
  //   结果 task claim / plan save / handoff 全报 “missing session id”，
  //   后面十几个断言（检查项计数、交接角标、计划页签…）连锁失败——
  //   这个门禁在我改文案之前就已经是红的，不是文案改动引起的。
  //   所以这里显式取回 session_id，用 KANBAN_SESSION 传给后面的命令。
  const startRes = await run(["session", "start", "--agent", "pi-fix", "--harness", "pi", "--json"], env);
  let sessionId = "";
  try {
    const parsed = JSON.parse(startRes.out.trim()) as { id?: string; session_id?: string };
    sessionId = parsed.id ?? parsed.session_id ?? "";
  } catch {
    // 解析失败就留空，下面 check 会把原始输出报出来
  }
  check("造数据：session start", startRes.code === 0 && sessionId !== "", sessionId || startRes.err.trim().split("\n").slice(-2).join(" "));
  const envWithSession = { ...env, KANBAN_SESSION: sessionId };

  const seeds: string[][] = [
    ["task", "add", CARD_TITLE, "-p", "0", "--check", "第一步,第二步", "-d", "详情页要能打开"],
    ["task", "claim", "T-0001"],
    ["task", "progress", "T-0001", "--pct", "50", "--check", "第一步", "--note", "做了一半"],
    ["plan", "save", "--task", "T-0001", "--title", "T-0001 的计划", "--body", "1. 修前端 2. 补测试"],
    ["handoff", "--task", "T-0001", "--summary", "交接摘要：前半段完成", "--next", "收尾"],
    ["task", "add", "上游任务", "-p", "2"],
    ["task", "dep", "add", "T-0001", "T-0002"],
  ];
  for (const args of seeds) {
    const r = await run(args, envWithSession);
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
      // 钉住界面语言：看板读 navigator.language 做自动检测，
      // 不固定的话下面的中文断言在英文系统上必然失败
      "--lang=zh-CN",
      "--accept-lang=zh-CN",
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

  /**
   * 读侧栏「建议接下来」那一节的纯文本。
   *
   * 按标题文字定位而不是写死选择器：词典一改（文案或键）这个读取就该跟着走，
   * 不会安静地读到空串然后让断言假绿。返回空串时调用方的正则会失败。
   */
  const readSuggestedNext = (heading: string): Promise<string> =>
    evaluate<string>(`(() => {
      const h = [...document.querySelectorAll('aside h2')].find((e) => e.textContent.trim() === ${JSON.stringify(heading)});
      const ul = h?.parentElement?.querySelector('ul');
      return ul ? ul.innerText.trim() : '';
    })()`);

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
  // 描述 / 检查项 / 依赖：这三样服务端 task.get 一直都在返回，之前的详情面板压根没渲染，
  // 于是“新建任务时填的描述、勾的检查项，创建完就再也看不到”。几何与文案都钉死。
  check("抽屉显示描述正文", sheet.text.includes("详情页要能打开"), "");
  check("抽屉显示检查项标题", sheet.text.includes("检查项"));
  check("检查项逐项列出（已勾/未勾都在）", sheet.text.includes("第一步") && sheet.text.includes("第二步"));
  check("检查项带完成计数", /1\s*\/\s*2\s*完成/.test(sheet.text), "");
  check("抽屉显示关联任务与依赖", sheet.text.includes("关联任务") && sheet.text.includes("T-0002"));
  // 依赖行右侧的可见标签：T-0002 还没做，所以必须是“未完成”而不是“已完成”
  check("依赖行标出未完成", /T-0002[\s\S]{0,40}未完成/.test(sheet.text), "");
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

  // ---- 双语：看板 + 管理页 ----
  // 这节与上面用中文断言不同：它验证的是**切换本身**，所以两种语言下都跑。
  console.log("\n=== 界面语言：自动检测 ===");
  const zhLanes = await evaluate<string[]>(`[...document.querySelectorAll('section h2')].map(e => e.textContent.trim())`);
  check(
    "无 --lang=zh-CN 时看板默认中文",
    zhLanes.length > 0 && zhLanes.every((s) => !/[A-Za-z]{3,}/.test(s)),
    zhLanes.join(" / "),
  );
  check("html lang 跟随 locale", (await evaluate<string>(`document.documentElement.lang`)) === "zh-CN");
  // 建议区的 chrome（“认领新任务：…”这类）必须是中文。
  // 交接摘要、任务标题是**数据**，里面出现中文是正常的，不在这里断言。
  const zhNext = await readSuggestedNext("建议接下来");
  check("中文界面下建议区是中文", /认领新任务|张卡阻塞|条崩溃自动交接|没有待办任务|继续你正在做的|接管失联会话/.test(zhNext), zhNext.replace(/\n+/g, " / "));

  console.log("\n=== 界面语言：看板切换到英文 ===");
  const toggled = await evaluate<boolean>(`(() => {
    const b = document.querySelector('button[aria-label="切换到 English"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check("语言切换按钮存在（aria-label 说出目标语言）", toggled);
  await sleep(900);
  const enLanes = await evaluate<string[]>(`[...document.querySelectorAll('section h2')].map(e => e.textContent.trim())`);
  check("泳道名变成英文", enLanes.includes("To Do") && enLanes.includes("In Progress"), enLanes.join(" / "));
  check("html lang 变成 en", (await evaluate<string>(`document.documentElement.lang`)) === "en");
  check(
    "document.title 本地化",
    (await evaluate<string>(`document.title`)) === "agent-kanban Board",
    await evaluate<string>(`document.title`),
  );
  check("选择写入 localStorage", (await evaluate<string>(`localStorage.getItem('kanban.locale')`)) === "en");
  check(
    "卡片菜单也变成英文",
    (await evaluate<string>(`[...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).join(',')`)).includes(
      "Card actions",
    ),
  );
  // 词典漏键会在控制台打 warn（开发构建）；运行时不至于，但至少不能有运行时异常
  check("切语言后无未捕获异常", exceptions.length === 0, exceptions[0]?.split("\n")[0] ?? "");
  check("切语言后无控制台 error", consoleErrors.length === 0, [...new Set(consoleErrors)][0]?.slice(0, 120) ?? "");

  // 曾经的 bug：建议区直接渲染后端 `next_actions`（给 agent 看的中文串），
  // 英文界面下那个面板漏出“有 1 张卡阻塞中…”/“认领新任务…”。永久回归。
  console.log("\n=== 界面语言：建议区不漏后端中文串 ===");
  const enNext = await readSuggestedNext("Suggested next");
  // 只查 chrome：交接摘要/任务标题是用户数据，里面有中文是应该的
  check(
    "英文界面下建议区没有后端中文模板",
    !/认领新任务|张卡阻塞|条崩溃自动交接|没有待办任务|继续你正在做的|接管失联会话|读交接/.test(enNext),
    enNext.replace(/\n+/g, " / "),
  );
  check(
    "英文界面下建议区显示英文文案",
    /Claim new work|blocked|handoff|Nothing to do/i.test(enNext),
    enNext.replace(/\n+/g, " / "),
  );

  // 详情抽屉的概览区（描述 / 检查项 / 关联任务）也必须跟着切语言。
  // 这三条是新加的键，最容易在补 en 词典时漏掉，而漏掉的表现是"英文界面里露出中文标题"。
  console.log("\n=== 界面语言：详情抽屉概览区 ===");
  await evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(CARD_TITLE)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1800);
  const enSheet = await sheetText();
  check("英文界面显示 Description / Checklist / Related tasks",
    enSheet.text.includes("Description") && enSheet.text.includes("Checklist") && enSheet.text.includes("Related tasks"),
    enSheet.text.slice(0, 200).replace(/\n/g, " / "));
  // 只查概览区的**小节标题**（h3），不查整段文本：
  // 事件流里的“检查项更新（1/2 完成）”是后端事件数据，按约定不翻译，
  // 拿整段文本去扫中文字会把合法的数据判成漏翻。
  const enHeadings = await evaluate<string[]>(
    `[...document.querySelectorAll('[role="dialog"] h3')].map((e) => e.textContent.trim())`,
  );
  check("概览小节标题是英文（没漏翻）", enHeadings.length > 0 && enHeadings.every((s) => !/[一-鿿]/.test(s)), enHeadings.join(" / "));
  await evaluate(`(() => {
    const close = document.querySelector('[data-slot="sheet-close"]');
    if (close) close.click();
    return true;
  })()`);
  await sleep(500);

  console.log("\n=== 界面语言：管理页（/admin）===");
  await send("Page.navigate", { url: `${BASE}/admin` });
  await sleep(1800);
  // /admin 不用 sessionStorage 里的 token（用完即清），所以登录要真的走一遍表单
  const adminLoggedIn = await evaluate<boolean>(`(() => {
    const input = document.getElementById('tokenInput');
    const btn = document.getElementById('loginBtn');
    if (!input || !btn) return false;
    input.value = ${JSON.stringify(token)};
    btn.click();
    return true;
  })()`);
  check("管理页登录表单可提交", adminLoggedIn);
  await sleep(1800);
  check("管理页进入主体（登录成功）", await evaluate<boolean>(`!document.getElementById('app').hidden`));
  const projTable = `document.querySelector('#projectRows')?.closest('table')?.innerText ?? ''`;
  const createdCell = `document.querySelector('#projectRows td.muted')?.textContent ?? ''`;
  // 看板上刚切到英文，而两个页面共用 localStorage["kanban.locale"]，
  // 所以管理页跟着变英文——这是有意的（同一个 origin，不该有两套语言状态）
  const adminEn0 = await evaluate<string>(`document.getElementById('serverInfo').textContent`);
  check("管理页继承看板的语言选择（共用 localStorage）", /project\(s\)/.test(adminEn0), adminEn0);
  check("管理页表头跟着变英文", (await evaluate<string>(projTable)).includes("Created"));
  check(
    "管理页英文日期用逗号分隔（toLocaleString(\"en\")）",
    (await evaluate<string>(createdCell)).includes(","),
    await evaluate<string>(createdCell),
  );
  check(
    "管理页 placeholder 也翻译了",
    (await evaluate<string>(`document.getElementById('newProjectKey').placeholder`)) === "project key (e.g. demo-app)",
    await evaluate<string>(`document.getElementById('newProjectKey').placeholder`),
  );

  await evaluate<boolean>(`(() => {
    const b = document.querySelector('#app [data-locale-btn]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(900);
  const adminZh = await evaluate<string>(`document.getElementById('serverInfo').textContent`);
  check("管理页切到中文", /个 project/.test(adminZh), adminZh);
  check("管理页表头跟着变中文", (await evaluate<string>(projTable)).includes("创建于"));
  check(
    "管理页中文日期不带逗号（toLocaleString(\"zh-CN\")）",
    !(await evaluate<string>(createdCell)).includes(","),
    await evaluate<string>(createdCell),
  );
  check(
    "管理页 placeholder 也切回中文",
    (await evaluate<string>(`document.getElementById('newProjectKey').placeholder`)).includes("project key"),
    await evaluate<string>(`document.getElementById('newProjectKey').placeholder`),
  );
  check("html lang 回到 zh-CN", (await evaluate<string>(`document.documentElement.lang`)) === "zh-CN");
  check("管理页无未捕获异常", exceptions.length === 0, exceptions[0]?.split("\n")[0] ?? "");
  check("管理页无控制台 error", consoleErrors.length === 0, [...new Set(consoleErrors)][0]?.slice(0, 120) ?? "");
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
