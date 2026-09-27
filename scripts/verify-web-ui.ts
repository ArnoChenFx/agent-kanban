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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
/** 第二个 project：用来验证「记住上次选的那个」记住的确实是**选的那个**，而不是碰巧每次都回第一个 */
const ALT_PROJECT = "web-ui-alt";
const CARD_TITLE = "点开我有惊喜";

/**
 * 跑一次真实 CLI，**工作目录是临时目录而不是仓库根**。
 *
 * 为什么不用 ROOT：CLI 会把 session 身份写进 `<cwd>/.kanban/sessions/<key>`。
 * 在仓库根跑的话，`session start` 会拿测试 session **覆盖掉开发者自己的身份文件**——
 * 下一次在真项目里跑命令就会被认成这个测试 session。用临时目录则两者互不干扰。
 *
 * 同时这也让脚本回到真实用户的用法：进一个目录 → session start → 后续命令免 --session。
 * 以前这里是显式塞 KANBAN_SESSION 绕过去的（绕的是 session start 在远程模式下
 * 不写身份文件那个 bug，已修，见 src/commands/session.ts）。
 */
function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((res) => {
    const p = spawn("bun", ["run", join(ROOT, "src", "cli.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
    });
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
  await run(["admin", "project", "add", ALT_PROJECT, "--name", "备用看板", "--db", dbPath]);
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
  // ⚠ 命令一律不带 --session / KANBAN_SESSION：身份必须从
  //   `session start` 写下的身份文件里读出来。带了就等于把这个 bug 又盖住了。
  //   身份文件落在临时工作目录里（见 run() 的注释），不会碰开发者自己的。
  const startRes = await run(["session", "start", "--agent", "pi-fix", "--harness", "pi", "--json"], env);
  let sessionId = "";
  try {
    const parsed = JSON.parse(startRes.out.trim()) as { id?: string; session_id?: string };
    sessionId = parsed.id ?? parsed.session_id ?? "";
  } catch {
    // 解析失败就留空，下面 check 会把原始输出报出来
  }
  check("造数据：session start", startRes.code === 0 && sessionId !== "", sessionId || startRes.err.trim().split("\n").slice(-2).join(" "));
  // 直接读目录而不去猜身份 key（那是 resolveSessionKey 的活，测试不重复它的逻辑）：
  // 临时目录是全新的，所以该有且只有一个分片，内容就是刚拿到的 session id
  const sessionFiles = readdirSync(join(dir, ".kanban", "sessions"));
  check("session start 写下了身份分片（远程模式也得写）", sessionFiles.length === 1, sessionFiles.join(","));
  check(
    "分片内容就是刚拿到的 session id",
    readFileSync(join(dir, ".kanban", "sessions", sessionFiles[0] ?? ""), "utf8").trim() === sessionId,
    sessionId,
  );

  const seeds: string[][] = [
    ["task", "add", CARD_TITLE, "-p", "0", "--check", "第一步,第二步", "-d", "详情页要能打开"],
    ["task", "claim", "T-0001"],
    ["task", "progress", "T-0001", "--pct", "50", "--check", "第一步", "--note", "做了一半"],
    // 同一张卡**连存两版**计划：版本切换器才有东西可切。
    // 顺序有意义——后存的那版是当前版（v2），先存的那版被顶替（v1）。
    ["plan", "save", "--task", "T-0001", "--title", "T-0001 的计划 v1", "--body", "1. 修前端 2. 补测试"],
    ["plan", "save", "--task", "T-0001", "--title", "T-0001 的计划", "--body", "1. 修前端 2. 补测试 3. 上线灰度"],
    ["handoff", "--task", "T-0001", "--summary", "交接摘要：前半段完成", "--next", "收尾"],
    ["task", "add", "上游任务", "-p", "2"],
    ["task", "dep", "add", "T-0001", "T-0002"],
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

  // ---- 时间线的“session 名”（真实事故：每条都显示 system）----
  // 详情抽屉默认就停在 Timeline 页签（Tabs defaultValue="timeline"），
  // 所以下面这几条读的就是时间线区的文本。
  //
  // 格式：`{相对时间} · {agent 名 + session_id ?? "system"}`。
  // 修复前事件是驼峰领域对象直出，前端读 e.session_id 恒为 undefined，
  // 于是每行都走 `?? "system"` —— 库里 session_id 本来是真值，只是没送到前端。
  // 后来署名又从裸 id 升级成“名字 + id”（造数据的会话叫 pi-fix），
  // 所以时间线行尾应出现 `· pi-fix s-xxx`。
  //
  // 用 `· ` 定位而不是“含 s-xxx”：检查项那行是 `pi-fix s-xxx · 刚刚`（顺序相反），
  // 不加这个限定会误把检查项的 session 当成时间线的。
  console.log("\n=== 时间线显示真实 session 名（不是 system）===");
  check("时间线有事件", /认领任务|Claimed|Created|创建任务|推进/.test(sheet.text), "");
  check(
    "时间线里出现 `· s-xxx`（session_id 送到了前端）",
    /·\s*(pi-fix\s+)?s-[0-9a-z]+/.test(sheet.text),
    sheet.text.match(/·\s*\S+/g)?.slice(0, 6).join(" ") ?? "无",
  );
  check(
    "时间线署名是「agent 名 + session id」（pi-fix s-xxx）",
    /pi-fix\s+s-[0-9a-z]+/.test(sheet.text),
    sheet.text.match(/pi-fix[\s\S]{0,16}/g)?.slice(0, 3).join(" | ") ?? "无",
  );
  check(
    "时间线里没有 `· system`（修复前每行都是它）",
    !/·\s*system/.test(sheet.text),
    sheet.text.match(/.{0,12}·\s*system.{0,6}/g)?.slice(0, 3).join(" | ") ?? "无",
  );
  const tabHandoff = await openTab("交接");
  sheet = await sheetText();
  check("交接页签可点开", tabHandoff);
  check("交接内容渲染", sheet.text.includes("交接摘要"), "");

  const tabPlan = await openTab("计划");
  sheet = await sheetText();
  check("计划页签可点开", tabPlan);
  check("计划正文渲染", sheet.text.includes("修前端"), "");

  // ---- 计划的历史版本（v1 被 v2 顶替）----
  // 后端 plan.list 早就支持 status:"all"，但详情面板一直只拉 plan.show 当前那一份。
  // 这里钉住：版本链列得出来、默认看当前版、切到旧版真的换正文、界面语言下不漏英文枚举值。
  console.log("\n=== 计划历史版本 ===");
  check(
    "版本切换器列出两个版本",
    await evaluate<boolean>(`(() => {
      const sheet = document.querySelector('[role="dialog"]');
      const labels = [...(sheet?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim());
      return labels.includes('v1') && labels.includes('v2');
    })()`),
  );
  check("页签上标出历史版本数", /计划\s*\n?\s*2/.test(sheet.text), sheet.text.match(/计划[\s\S]{0,6}/)?.[0] ?? "");
  // 默认看当前版：v2 的正文与标题在，v1 独有的标题不在
  check("默认显示当前版本（v2）的正文", sheet.text.includes("3. 上线灰度"), "");
  check("默认不显示 v1 的标题", !sheet.text.includes("T-0001 的计划 v1"), "");
  // 计划 status 是界面 chrome，不能把后端枚举值直接印在中文界面上
  check("当前版本标为“生效中”（不是裸 active）", sheet.text.includes("生效中") && !/v2\s*\n?\s*active/.test(sheet.text), "");

  const clickVersion = async (label: string) => {
    const ok = await evaluate<boolean>(`(() => {
      const sheet = document.querySelector('[role="dialog"]');
      const btn = [...(sheet?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await sleep(900);
    return ok;
  };
  check("点到 v1", await clickVersion("v1"));
  sheet = await sheetText();
  check("切到 v1 后正文换成旧版", sheet.text.includes("1. 修前端 2. 补测试") && !sheet.text.includes("3. 上线灰度"), "");
  // 角标跟的是**正在看的那一版**，所以“已被顶替”要到切到 v1 之后才该出现
  check("切到 v1 后标为“已被顶替”", sheet.text.includes("已被顶替"), "");
  check("看历史版时提示当前生效的是 v2", /当前生效的是\s*v2/.test(sheet.text), "");

  check("点回 v2", await clickVersion("v2"));
  sheet = await sheetText();
  check("切回 v2 恢复当前版正文", sheet.text.includes("3. 上线灰度"), "");
  check("切回当前版不再提示“当前生效的是”", !/当前生效的是/.test(sheet.text), "");
  // 切页签再切回来：选中态存在父组件，不该被 radix 卸载页签吃掉
  await openTab("交接");
  await openTab("计划");
  sheet = await sheetText();
  check("切走页签再回来仍是 v2（选中态没被卸载吃掉）", sheet.text.includes("3. 上线灰度"), "");
  check("全程无未捕获异常", exceptions.length === 0, exceptions[0]?.split("\n")[0] ?? "");

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

  // ---- 项目记忆：记住上次选的，记忆失效（或没有）就自动选第一个 ----
  // 曾经的 bug：下拉框只改了 React state，没写 localStorage，页面上一切正常，
  // 刷新一下就弹回上一个 project —— “记住最后选择”形同虚设，而且不报任何错。
  //
  // 这里不去点 Radix Select（它只在 pointerdown 上展开，模拟不好很容易假绿），
  // 改成直接改 localStorage 再 reload：能证明「读记忆 + 兜底」这一半。
  // 「写记忆」那一半由 test/web-contract.test.ts 的静态守卫钉住
  // （onValueChange 必须是 selectProject，且每个 setProject 都要配一次落盘）。
  console.log("\n=== 项目记忆（localStorage → 重开页面）===");
  const projectList = await evaluate<{ key: string; name: string }[]>(`(async () => {
    const res = await fetch('/api/projects', { headers: { 'X-Kanban-Key': localStorage.getItem('kanban.token') } });
    return (await res.json()).data;
  })()`);
  check("token 能看到两个 project（“第一个”才有意义）", projectList.length >= 2, projectList.map((p) => p.key).join(" / "));

  /** 顶栏 project 下拉框当前显示的名字（project 名是数据，不随界面语言变） */
  const projectShown = async () => (await evaluate<string>(`(document.querySelector('[role="combobox"]')?.innerText ?? '').trim()`));
  const cardCount = async () => evaluate<number>(`document.querySelectorAll('[data-slot="task-id"]').length`);
  /** 改完记忆就重开页面（模拟关掉标签页再打开） */
  const reopenWith = async (remembered: string) => {
    await evaluate(`localStorage.setItem('kanban.project', ${JSON.stringify(remembered)})`);
    await send("Page.reload", {});
    await sleep(2500);
  };

  const firstProject = projectList[0];
  const altProject = projectList.find((p) => p.key === ALT_PROJECT);
  if (firstProject && altProject) {
    check("刚打开时用的是分享链接带来的 project", (await projectShown()) === "Web UI 回归", await projectShown());

    await reopenWith(altProject.key);
    check("记住的 project 重开后仍然生效（不是碰巧每次都回第一个）", (await projectShown()) === altProject.name, `显示 ${await projectShown()}`);
    check("看板也跟着切到了那个 project（备用 project 里一张卡都没有）", (await cardCount()) === 0, `${await cardCount()} 张`);

    await reopenWith("gone-project");
    check("记住的 project 已失效 → 自动退回第一个", (await projectShown()) === firstProject.name, `显示 ${await projectShown()}`);
    check(
      "自动选中的也写回记忆（下次打开不必再判断一次）",
      (await evaluate<string>(`localStorage.getItem('kanban.project')`)) === firstProject.key,
      await evaluate<string>(`localStorage.getItem('kanban.project')`),
    );

    // 回到有卡的那个 project：后面的断言（点卡片、切页签）都靠它，别把现场留坏
    await reopenWith(PROJECT);
    check("切回有卡的 project 后卡片重新出现", (await cardCount()) > 0, `${await cardCount()} 张`);
  }
  check("切 project 过程中无未捕获异常", exceptions.length === 0, exceptions[0]?.split("\n")[0] ?? "");
  // 上面那次“用失效 project 重开页面”必然换来一个 400：看板先拿记忆里的死 key
  // 乐观地打一次 /api/board（快过列表请求），拿到 400 被 .catch 吃掉，界面随即自愈成
  // 第一个 project。这条 network error 是浏览器记的，JS 屏蔽不了，所以只允许它出现，
  // 并在这里把计数清零当基线——后面的断言衡量的是“恢复正常之后还有没有新错”。
  const newErrors = [...new Set(consoleErrors)];
  check(
    "只有那次必然的 400，没有别的报错",
    newErrors.every((e) => e.includes("400")),
    newErrors.join(" | ").slice(0, 160),
  );
  consoleErrors.length = 0;
  exceptions.length = 0;

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
  // /admin 的 token 不在看板的 localStorage key 里，所以登录要真的走一遍表单
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

  // token 记在 localStorage：重开页面应当自动恢复登录，不再弹登录表单
  await send("Page.navigate", { url: `${BASE}/admin` });
  await sleep(1500);
  check(
    "管理页记住登录（重开免登）",
    await evaluate<boolean>(`!document.getElementById('app').hidden`),
  );
  check(
    "记忆登录用的是 localStorage",
    await evaluate<boolean>(`localStorage.getItem('kanban.admin.token') !== null`),
  );
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
