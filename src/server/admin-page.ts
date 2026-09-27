/**
 * 管理界面（`/admin`）——单文件 HTML，无外部依赖。
 *
 * 设计取舍：
 * 1. **页面本身不需要鉴权**，所有数据请求都带管理员 token。
 *    好处：可以用 localStorage 记住登录状态，刷新不丢；
 *    安全性由 API 层保证（页面里没有任何数据）。
 * 2. **token 存在 localStorage**：刷新、重开浏览器都免登录（与看板页的
 *    `kanban.token` 同一策略）。代价是管理员凭据长期驻留在本机浏览器里，
 *    共享机器上用完请手动登出（右上角退出按钮会清掉它）。
 * 3. **不用框架**：管理页面功能有限（列 project、发/吊销 token），
 *    引入 React/Vue 反而增加构建与依赖负担。
 * 4. **全部 textContent 渲染**，不拼 innerHTML —— 任务标题、备注等是用户输入。
 * 5. **中英双语**：内联一小份词典（与看板的 `web/src/lib/i18n.tsx` 同一套约定：
 *    点分键、`{name}` 插值、localStorage `kanban.locale`）。
 *    静态文案用 `data-i18n` / `data-i18n-ph` 标记后统一刷，
 *    动态文案（表格单元、toast、confirm）走 `t()`。
 *    词典在这份模板里而不是外部文件里，是因为整个 admin 页的卖点就是“没有外部依赖”。
 */

export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-kanban Admin</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --fg: #c9d1d9; --dim: #8b949e; --accent: #58a6ff;
    --red: #f85149; --green: #3fb950; --yellow: #d29922;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  header {
    padding: 16px 24px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  h2 { font-size: 15px; margin: 0 0 12px; font-weight: 600; }
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 20px; margin-bottom: 20px;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--dim); font-weight: 500; font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  code { background: #21262d; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  button {
    background: var(--border); color: var(--fg); border: 1px solid transparent;
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  button:hover { background: #3d444d; }
  button.primary { background: var(--accent); color: #04131f; font-weight: 600; }
  button.danger { border-color: var(--red); color: var(--red); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  /* 语言切换：跟普通按钮区分开，让人一眼知道它不是数据操作 */
  button.ghost { background: transparent; border-color: var(--border); color: var(--dim); min-width: 52px; }
  button.ghost:hover { color: var(--fg); }
  input {
    background: #0d1117; border: 1px solid var(--border); color: var(--fg);
    padding: 7px 10px; border-radius: 6px; font-size: 13px;
    /* min-width:0 + flex 基准：同一行里控件变多时（英文 placeholder 更长）先压缩而不是溢出 */
    min-width: 0; flex: 1 1 200px;
  }
  input:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .tag {
    display: inline-block; padding: 2px 8px; border-radius: 12px;
    font-size: 12px; border: 1px solid var(--border);
  }
  .tag.admin { border-color: var(--yellow); color: var(--yellow); }
  .tag.active { border-color: var(--green); color: var(--green); }
  .tag.revoked, .tag.expired { border-color: var(--red); color: var(--red); }
  .muted { color: var(--dim); }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
  #login { max-width: 420px; margin: 80px auto; }
  #error {
    background: rgba(248,81,73,.12); border: 1px solid var(--red);
    color: var(--red); padding: 10px 14px; border-radius: 6px; margin-bottom: 16px;
    display: none; white-space: pre-wrap;
  }
  .secret {
    background: rgba(88,166,255,.1); border: 1px solid var(--accent);
    padding: 12px 14px; border-radius: 6px; margin: 12px 0;
  }
  .secret .value { font-size: 15px; word-break: break-all; user-select: all; }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<!-- 登录：只需要管理员 token -->
<div id="login">
  <div class="panel">
    <div class="row" style="justify-content:space-between">
      <h1 data-i18n="admin.title"></h1>
      <button data-locale-btn class="ghost" type="button"></button>
    </div>
    <p class="muted" data-i18n="admin.login.hint"></p>
    <div id="error"></div>
    <div class="row">
      <input id="tokenInput" type="password" placeholder="k_admin_..." autocomplete="off" style="flex:1">
      <button class="primary" id="loginBtn" data-i18n="admin.login.btn"></button>
    </div>
    <p class="muted" style="margin-bottom:0;font-size:12px"><span data-i18n="admin.login.note1"></span><code>.kanban/config.toml</code><span data-i18n="admin.login.note2"></span><code>KANBAN_ADMIN_TOKEN</code><span data-i18n="admin.login.note3"></span></p>
  </div>
</div>

<!-- 主体 -->
<div id="app" hidden>
  <header>
    <h1 data-i18n="admin.title"></h1>
    <span class="muted" id="serverInfo"></span>
    <div style="flex:1"></div>
    <button data-locale-btn class="ghost" type="button"></button>
    <button id="refreshBtn" data-i18n="admin.refresh"></button>
    <button id="logoutBtn" data-i18n="admin.logout"></button>
  </header>

  <main>
    <div id="error" style="margin-bottom:16px"></div>
    <div id="secret" class="secret" hidden>
      <strong data-i18n="admin.secret.title"></strong>
      <div class="value mono" id="secretValue"></div>
      <div class="row" style="margin-top:8px">
        <button id="copyBtn" data-i18n="admin.copy"></button>
        <button id="secretClose" data-i18n="admin.saved"></button>
      </div>
    </div>

    <div class="panel">
      <h2 data-i18n="admin.project.heading"></h2>
      <div class="row" style="margin-bottom:14px">
        <input id="newProjectKey" data-i18n-ph="admin.project.keyPh">
        <input id="newProjectName" data-i18n-ph="admin.project.namePh">
        <button class="primary" id="addProjectBtn" data-i18n="admin.project.add"></button>
      </div>
      <table>
        <thead><tr>
          <th data-i18n="admin.th.key"></th><th data-i18n="admin.th.name"></th>
          <th data-i18n="admin.project.thTasks"></th><th data-i18n="admin.project.thTokens"></th>
          <th data-i18n="admin.project.thCreated"></th><th></th>
        </tr></thead>
        <tbody id="projectRows"></tbody>
      </table>
    </div>

    <div class="panel">
      <h2 data-i18n="admin.token.heading"></h2>
      <div class="row" style="margin-bottom:14px">
        <input id="newTokenName" data-i18n-ph="admin.token.namePh">
        <input id="newTokenProjects" data-i18n-ph="admin.token.projPh">
        <select id="newTokenRole" style="background:#0d1117;border:1px solid var(--border);color:var(--fg);padding:7px 10px;border-radius:6px">
          <option value="project" data-i18n="admin.token.roleProject"></option>
          <option value="admin" data-i18n="admin.token.roleAdmin"></option>
        </select>
        <button class="primary" id="addTokenBtn" data-i18n="admin.token.issue"></button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:-4px" data-i18n="admin.token.hint"></p>
      <table>
        <thead><tr>
          <th data-i18n="admin.th.token"></th><th data-i18n="admin.th.name"></th>
          <th data-i18n="admin.token.thRole"></th><th data-i18n="admin.token.thProjects"></th>
          <th data-i18n="admin.token.thStatus"></th><th data-i18n="admin.token.thLastUsed"></th>
          <th></th>
        </tr></thead>
        <tbody id="tokenRows"></tbody>
      </table>
    </div>
  </main>
</div>

<script type="module">
// ---- i18n：内联词典，与看板 web/src/lib/i18n.tsx 同一套约定 ----
const DICT = {
  zh: {
    "admin.title": "agent-kanban 管理",
    "admin.locale.switch": "切换到 {name}",
    "admin.locale.aria": "切换界面语言",
    "admin.login.hint": "用管理员 token 登录，可管理 project 与访问 token。",
    "admin.login.btn": "登录",
    "admin.login.note1": "管理员 token 在 server 首次启动时生成，存于 server 的 ",
    "admin.login.note2": "。也可用环境变量 ",
    "admin.login.note3": " 注入。",
    "admin.refresh": "刷新",
    "admin.logout": "退出",
    "admin.secret.title": "新 token（只显示这一次）",
    "admin.copy": "复制",
    "admin.copied": "已复制",
    "admin.copyFailed": "复制失败，请手动选中",
    "admin.saved": "我已保存",
    "admin.th.key": "key",
    "admin.th.name": "名称",
    "admin.th.token": "token",
    "admin.project.heading": "Project",
    "admin.project.keyPh": "project key（如 demo-app）",
    "admin.project.namePh": "显示名（可选）",
    "admin.project.add": "新建 project",
    "admin.project.thTasks": "任务",
    "admin.project.thTokens": "关联 token",
    "admin.project.thCreated": "创建于",
    "admin.project.empty": "还没有 project",
    "admin.project.delete": "删除",
    "admin.token.heading": "访问 Token",
    "admin.token.namePh": "名称（如 CI、外包团队）",
    "admin.token.projPh": "project 列表，逗号分隔（留空 = 管理员）",
    "admin.token.roleProject": "项目级",
    "admin.token.roleAdmin": "管理员",
    "admin.token.issue": "签发 token",
    "admin.token.hint": "一个 token 可授权多个 project；管理员 token 拥有全部 project 权限，且不能再指定列表。",
    "admin.token.thRole": "角色",
    "admin.token.thProjects": "授权 project",
    "admin.token.thStatus": "状态",
    "admin.token.thLastUsed": "最后使用",
    "admin.token.empty": "还没有 token",
    "admin.token.all": "全部",
    "admin.token.revokeGrant": "点击移除该授权",
    "admin.token.status.active": "有效",
    "admin.token.status.revoked": "已吊销",
    "admin.token.status.expired": "已过期",
    "admin.token.revoke": "吊销",
    "admin.serverInfo": "{projects} 个 project · {tokens} 个 token",
    "admin.err.notJson": "响应不是 JSON",
    "admin.err.sessionLost": "登录已失效，请重新输入管理员 token",
    "admin.err.needToken": "请输入管理员 token",
    "admin.err.needProjectKey": "请输入 project key",
    "admin.confirm.deleteHasTasks": "project \\"{key}\\" 下还有 {n} 个任务，删除后不可恢复。\\n确认删除？",
    "admin.confirm.delete": "确认删除 project \\"{key}\\"？",
    "admin.confirm.revoke": "确认吊销 token {id}？该 token 将立即失效且不可恢复。",
  },
  en: {
    "admin.title": "agent-kanban Admin",
    "admin.locale.switch": "Switch to {name}",
    "admin.locale.aria": "Switch UI language",
    "admin.login.hint": "Sign in with the admin token to manage projects and access tokens.",
    "admin.login.btn": "Sign in",
    "admin.login.note1": "The admin token is generated on the server's first start and stored in the server's ",
    "admin.login.note2": ". You can also inject it with the environment variable ",
    "admin.login.note3": ".",
    "admin.refresh": "Refresh",
    "admin.logout": "Sign out",
    "admin.secret.title": "New token (shown only once)",
    "admin.copy": "Copy",
    "admin.copied": "Copied",
    "admin.copyFailed": "Copy failed — select it manually",
    "admin.saved": "I saved it",
    "admin.th.key": "key",
    "admin.th.name": "Name",
    "admin.th.token": "token",
    "admin.project.heading": "Projects",
    "admin.project.keyPh": "project key (e.g. demo-app)",
    "admin.project.namePh": "Display name (optional)",
    "admin.project.add": "New project",
    "admin.project.thTasks": "Tasks",
    "admin.project.thTokens": "Tokens",
    "admin.project.thCreated": "Created",
    "admin.project.empty": "No projects yet",
    "admin.project.delete": "Delete",
    "admin.token.heading": "Access tokens",
    "admin.token.namePh": "Name (e.g. CI, contractor team)",
    "admin.token.projPh": "project list, comma-separated (empty = admin)",
    "admin.token.roleProject": "Project",
    "admin.token.roleAdmin": "Admin",
    "admin.token.issue": "Issue token",
    "admin.token.hint":
      "One token can be granted several projects. An admin token has access to every project and cannot be given an explicit list.",
    "admin.token.thRole": "Role",
    "admin.token.thProjects": "Granted projects",
    "admin.token.thStatus": "Status",
    "admin.token.thLastUsed": "Last used",
    "admin.token.empty": "No tokens yet",
    "admin.token.all": "All",
    "admin.token.revokeGrant": "Click to remove this grant",
    "admin.token.status.active": "Active",
    "admin.token.status.revoked": "Revoked",
    "admin.token.status.expired": "Expired",
    "admin.token.revoke": "Revoke",
    "admin.serverInfo": "{projects} project(s) · {tokens} token(s)",
    "admin.err.notJson": "Response was not JSON",
    "admin.err.sessionLost": "Your session expired — enter the admin token again",
    "admin.err.needToken": "Enter the admin token",
    "admin.err.needProjectKey": "Enter a project key",
    "admin.confirm.deleteHasTasks":
      'project "{key}" still has {n} task(s); deleting it cannot be undone.\\nDelete anyway?',
    "admin.confirm.delete": 'Delete project "{key}"?',
    "admin.confirm.revoke": "Revoke token {id}? It stops working immediately and cannot be restored.",
  },
};
const LOCALE_NAME = { zh: "中文", en: "English" };
const LOCALE_SHORT = { zh: "中文", en: "EN" };
const HTML_LANG = { zh: "zh-CN", en: "en" };
/** 与看板共用同一个 key：在哪边切语言，另一边下次打开就是新的 */
const LOCALE_KEY = "kanban.locale";

function readLocale() {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch { /* 隐私模式下读不到，按浏览器语言走 */ }
  return (navigator.language || "").toLowerCase().startsWith("en") ? "en" : "zh";
}
let locale = readLocale();
/**
 * 查表 + 插值。
 *
 * **不用正则做替换**：这份 HTML 是 TS 模板字符串，正则里的 \w / { 会被
 * 模板字符串的转义规则先吃掉一层（\w 变成字母 w），到浏览器里就变成了完全不同的模式。
 * 逐个 key 做 split/join 没有这个问题，也没有正则开销。
 * 缺参数时保留占位符原样（看得见的 {n} 好过看不见的 undefined）。
 */
function t(key, params) {
  let s = DICT[locale][key] ?? DICT.en[key] ?? key;
  if (!params) return s;
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    s = s.split("{" + name + "}").join(String(value));
  }
  return s;
}
/** 把 data-i18n / data-i18n-ph 标记的静态文案刷一遍 */
function applyStaticI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
  for (const b of document.querySelectorAll("[data-locale-btn]")) {
    const target = locale === "zh" ? "en" : "zh";
    b.textContent = LOCALE_SHORT[target];
    b.title = t("admin.locale.switch", { name: LOCALE_NAME[target] });
    b.setAttribute("aria-label", t("admin.locale.aria"));
  }
  document.documentElement.lang = HTML_LANG[locale];
  document.title = t("admin.title");
}
function setLocale(next) {
  locale = next;
  try { localStorage.setItem(LOCALE_KEY, next); } catch { /* 存不住只影响下次打开 */ }
  applyStaticI18n();
  // 表格是动态渲染的，得用缓存的数据重画一次（不能顺手重新请求）
  if (lastOverview) { renderProjects(lastOverview.projects); renderTokens(lastOverview.tokens); }
  if (adminToken) loadAll().catch((e) => showError(e.message));
}

// ---- 全局状态 ----
// 与看板页的 kanban.token / kanban.locale 同一命名约定
const TOKEN_STORAGE_KEY = "kanban.admin.token";
let adminToken = localStorage.getItem(TOKEN_STORAGE_KEY) || "";
/** 最近一次 /overview 的响应：切语言时用它重画表格，避免多打一次请求 */
let lastOverview = null;

const $ = (id) => document.getElementById(id);
const showError = (msg) => {
  const el = $("error");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
};
// 日期跟着界面语言走：中文 2026/2/19 08:00:00，英文 2/19/2026, 08:00:00
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString(HTML_LANG[locale]) : "—");

/** 调 admin API（统一错误处理） */
async function api(path, options = {}) {
  const res = await fetch("/api/admin" + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Kanban-Key": adminToken,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({ ok: false, error: { message: t("admin.err.notJson") } }));
  if (!res.ok || !body.ok) {
    const err = body.error || { message: "HTTP " + res.status };
    if (res.status === 401) {
      // token 无效：回到登录页
      logout(t("admin.err.sessionLost"));
    }
    throw new Error(err.message + (err.details?.hint ? "\\n" + err.details.hint : ""));
  }
  return body.data;
}

// ---- 登录 / 登出 ----
function logout(msg) {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  adminToken = "";
  $("app").hidden = true;
  $("login").hidden = false;
  if (msg) showError(msg);
}

// token 入参用于启动时恢复记忆的登录；表单提交则从输入框取值
async function doLogin(token) {
  token = (token ?? $("tokenInput").value).trim();
  if (!token) return showError(t("admin.err.needToken"));
  showError("");
  adminToken = token;
  try {
    await loadAll();
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    $("login").hidden = true;
    $("app").hidden = false;
    showError("");
  } catch (e) {
    adminToken = "";
    showError(e.message);
  }
}

// ---- 渲染 ----
function renderProjects(projects) {
  const tbody = $("projectRows");
  tbody.textContent = "";
  if (projects.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "muted";
    td.textContent = t("admin.project.empty");
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const p of projects) {
    const tr = document.createElement("tr");

    const key = document.createElement("td");
    key.textContent = p.key;
    const name = document.createElement("td");
    name.textContent = p.name;
    const tasks = document.createElement("td");
    tasks.textContent = String(p.task_count);
    const tokens = document.createElement("td");
    tokens.textContent = String(p.token_count ?? 0);
    const created = document.createElement("td");
    created.className = "muted";
    created.textContent = fmtTime(p.created_at);

    const actions = document.createElement("td");
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = t("admin.project.delete");
    del.onclick = () => deleteProject(p.key, p.task_count);
    actions.appendChild(del);

    tr.append(key, name, tasks, tokens, created, actions);
    tbody.appendChild(tr);
  }
}

function renderTokens(tokens) {
  const tbody = $("tokenRows");
  tbody.textContent = "";
  if (tokens.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "muted";
    td.textContent = t("admin.token.empty");
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const tk of tokens) {
    const tr = document.createElement("tr");

    const id = document.createElement("td");
    id.className = "mono";
    id.textContent = tk.id;   // 掩码值

    const name = document.createElement("td");
    name.textContent = tk.name || "—";

    const role = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = "tag " + tk.role;
    tag.textContent = tk.role === "admin" ? t("admin.token.roleAdmin") : t("admin.token.roleProject");
    role.appendChild(tag);

    const projects = document.createElement("td");
    if (tk.role === "admin") {
      projects.textContent = t("admin.token.all");
      projects.className = "muted";
    } else if (tk.projects && tk.projects.length > 0) {
      // 每个 project 一个可点击的标签，点一下即切换授权状态
      for (const key of tk.projects) {
        const chip = document.createElement("span");
        chip.className = "tag active";
        chip.style.cursor = "pointer";
        chip.textContent = key + " ×";
        chip.title = t("admin.token.revokeGrant");
        chip.onclick = () => revokeProjectGrant(tk.id, tk.projects.filter((p) => p !== key));
        projects.appendChild(chip);
        projects.appendChild(document.createTextNode(" "));
      }
    } else {
      projects.textContent = "—";
    }

    const status = document.createElement("td");
    const st = document.createElement("span");
    st.className = "tag " + tk.status;
    // 未知状态直接显示原值，而不是把 "admin.token.status.xxx" 摆到界面上
    const statusKey = "admin.token.status." + tk.status;
    st.textContent = DICT[locale][statusKey] ?? DICT.en[statusKey] ?? tk.status;
    status.appendChild(st);

    const used = document.createElement("td");
    used.className = "muted";
    used.textContent = fmtTime(tk.last_used_at);

    const actions = document.createElement("td");
    if (tk.status === "active") {
      const revoke = document.createElement("button");
      revoke.className = "danger";
      revoke.textContent = t("admin.token.revoke");
      revoke.onclick = () => revokeToken(tk.id);
      actions.appendChild(revoke);
    }

    tr.append(id, name, role, projects, status, used, actions);
    tbody.appendChild(tr);
  }
}

// ---- 操作 ----
async function loadAll() {
  showError("");
  const data = await api("/overview");
  lastOverview = data;
  renderProjects(data.projects);
  renderTokens(data.tokens);
  $("serverInfo").textContent = t("admin.serverInfo", {
    projects: data.projects.length,
    tokens: data.tokens.length,
  });
}

async function addProject() {
  const key = $("newProjectKey").value.trim();
  const name = $("newProjectName").value.trim();
  if (!key) return showError(t("admin.err.needProjectKey"));
  try {
    await api("/projects", { method: "POST", body: JSON.stringify({ key, name: name || key }) });
    $("newProjectKey").value = "";
    $("newProjectName").value = "";
    await loadAll();
  } catch (e) {
    showError(e.message);
  }
}

async function deleteProject(key, taskCount) {
  if (taskCount > 0) {
    const ok = confirm(t("admin.confirm.deleteHasTasks", { key, n: taskCount }));
    if (!ok) return;
  } else if (!confirm(t("admin.confirm.delete", { key }))) {
    return;
  }
  try {
    await api("/projects/" + encodeURIComponent(key) + "?force=1", { method: "DELETE" });
    await loadAll();
  } catch (e) {
    showError(e.message);
  }
}

async function addToken() {
  const name = $("newTokenName").value.trim();
  const role = $("newTokenRole").value;
  const projects = $("newTokenProjects").value
    .split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const data = await api("/tokens", {
      method: "POST",
      body: JSON.stringify({ role, projects, name: name || null }),
    });
    $("newTokenName").value = "";
    $("newTokenProjects").value = "";
    // 明文只在这里出现
    $("secretValue").textContent = data.token;
    $("secret").hidden = false;
    await loadAll();
  } catch (e) {
    showError(e.message);
  }
}

async function revokeToken(id) {
  if (!confirm(t("admin.confirm.revoke", { id }))) return;
  try {
    await api("/tokens/" + encodeURIComponent(id) + "/revoke", { method: "POST" });
    await loadAll();
  } catch (e) {
    showError(e.message);
  }
}

async function revokeProjectGrant(id, projects) {
  try {
    await api("/tokens/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify({ projects }),
    });
    await loadAll();
  } catch (e) {
    showError(e.message);
  }
}

// ---- 事件绑定 ----
applyStaticI18n();
$("loginBtn").onclick = () => doLogin();
$("tokenInput").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
$("logoutBtn").onclick = () => logout();
$("refreshBtn").onclick = () => loadAll().catch((e) => showError(e.message));
$("addProjectBtn").onclick = addProject;
$("addTokenBtn").onclick = addToken;
$("secretClose").onclick = () => { $("secret").hidden = true; };
for (const b of document.querySelectorAll("[data-locale-btn]")) {
  b.onclick = () => setLocale(locale === "zh" ? "en" : "zh");
}
$("copyBtn").onclick = async () => {
  // 按钮文字会被 setTimeout 改回去，所以用 data-i18n 而不是写死字符串
  const reset = () => setTimeout(() => { $("copyBtn").textContent = t("admin.copy"); }, 1500);
  try {
    await navigator.clipboard.writeText($("secretValue").textContent);
    $("copyBtn").textContent = t("admin.copied");
    reset();
  } catch {
    $("copyBtn").textContent = t("admin.copyFailed");
    reset();
  }
};

// ---- 启动：有记忆的 token 就直接进（校验失败时 api() 会走 logout 回登录页），
// 否则显示登录页 ----
if (adminToken) {
  doLogin(adminToken);
} else {
  $("login").hidden = false;
}
</script>
</body>
</html>`;
}
