/**
 * 管理界面（`/admin`）——单文件 HTML，无外部依赖。
 *
 * 设计取舍：
 * 1. **页面本身不需要鉴权**，所有数据请求都带管理员 token。
 *    好处：可以用 localStorage 记住登录状态，刷新不丢；
 *    安全性由 API 层保证（页面里没有任何数据）。
 * 2. **token 存在 sessionStorage 而不是 localStorage**：
 *    关掉标签页即失效，避免在共享机器上长期驻留管理员凭据。
 * 3. **不用框架**：管理页面功能有限（列 project、发/吊销 token），
 *    引入 React/Vue 反而增加构建与依赖负担。
 * 4. **全部 textContent 渲染**，不拼 innerHTML —— 任务标题、备注等是用户输入。
 */

export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-kanban 管理</title>
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
  input {
    background: #0d1117; border: 1px solid var(--border); color: var(--fg);
    padding: 7px 10px; border-radius: 6px; font-size: 13px; min-width: 200px;
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
    <h1>agent-kanban 管理</h1>
    <p class="muted">用管理员 token 登录，可管理 project 与访问 token。</p>
    <div id="error"></div>
    <div class="row">
      <input id="tokenInput" type="password" placeholder="k_admin_..." autocomplete="off" style="flex:1">
      <button class="primary" id="loginBtn">登录</button>
    </div>
    <p class="muted" style="margin-bottom:0;font-size:12px">
      管理员 token 在 server 首次启动时生成，存于 server 的 <code>.kanban/config.toml</code>。
      也可用环境变量 <code>KANBAN_ADMIN_TOKEN</code> 注入。
    </p>
  </div>
</div>

<!-- 主体 -->
<div id="app" hidden>
  <header>
    <h1>agent-kanban 管理</h1>
    <span class="muted" id="serverInfo"></span>
    <div style="flex:1"></div>
    <button id="refreshBtn">刷新</button>
    <button id="logoutBtn">退出</button>
  </header>

  <main>
    <div id="error" style="margin-bottom:16px"></div>
    <div id="secret" class="secret" hidden>
      <strong>新 token（只显示这一次）</strong>
      <div class="value mono" id="secretValue"></div>
      <div class="row" style="margin-top:8px">
        <button id="copyBtn">复制</button>
        <button id="secretClose">我已保存</button>
      </div>
    </div>

    <div class="panel">
      <h2>Project</h2>
      <div class="row" style="margin-bottom:14px">
        <input id="newProjectKey" placeholder="project key（如 demo-app）">
        <input id="newProjectName" placeholder="显示名（可选）">
        <button class="primary" id="addProjectBtn">新建 project</button>
      </div>
      <table>
        <thead><tr><th>key</th><th>名称</th><th>任务</th><th>关联 token</th><th>创建于</th><th></th></tr></thead>
        <tbody id="projectRows"></tbody>
      </table>
    </div>

    <div class="panel">
      <h2>访问 Token</h2>
      <div class="row" style="margin-bottom:14px">
        <input id="newTokenName" placeholder="名称（如 CI、外包团队）">
        <input id="newTokenProjects" placeholder="project 列表，逗号分隔（留空 = 管理员）">
        <select id="newTokenRole" style="background:#0d1117;border:1px solid var(--border);color:var(--fg);padding:7px 10px;border-radius:6px">
          <option value="project">项目级</option>
          <option value="admin">管理员</option>
        </select>
        <button class="primary" id="addTokenBtn">签发 token</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:-4px">
        一个 token 可授权多个 project；管理员 token 拥有全部 project 权限，且不能再指定列表。
      </p>
      <table>
        <thead><tr><th>token</th><th>名称</th><th>角色</th><th>授权 project</th><th>状态</th><th>最后使用</th><th></th></tr></thead>
        <tbody id="tokenRows"></tbody>
      </table>
    </div>
  </main>
</div>

<script type="module">
// ---- 全局状态 ----
let adminToken = sessionStorage.getItem("kanban_admin_token") || "";

const $ = (id) => document.getElementById(id);
const showError = (msg) => {
  const el = $("error");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
};
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString("zh-CN") : "—");

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
  const body = await res.json().catch(() => ({ ok: false, error: { message: "响应不是 JSON" } }));
  if (!res.ok || !body.ok) {
    const err = body.error || { message: "HTTP " + res.status };
    if (res.status === 401) {
      // token 无效：回到登录页
      logout("登录已失效，请重新输入管理员 token");
    }
    throw new Error(err.message + (err.details?.hint ? "\\n" + err.details.hint : ""));
  }
  return body.data;
}

// ---- 登录 / 登出 ----
function logout(msg) {
  sessionStorage.removeItem("kanban_admin_token");
  adminToken = "";
  $("app").hidden = true;
  $("login").hidden = false;
  if (msg) showError(msg);
}

async function doLogin() {
  const token = $("tokenInput").value.trim();
  if (!token) return showError("请输入管理员 token");
  showError("");
  adminToken = token;
  try {
    await loadAll();
    sessionStorage.setItem("kanban_admin_token", token);
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
    td.textContent = "还没有 project";
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
    del.textContent = "删除";
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
    td.textContent = "还没有 token";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const t of tokens) {
    const tr = document.createElement("tr");

    const id = document.createElement("td");
    id.className = "mono";
    id.textContent = t.id;   // 掩码值

    const name = document.createElement("td");
    name.textContent = t.name || "—";

    const role = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = "tag " + t.role;
    tag.textContent = t.role === "admin" ? "管理员" : "项目级";
    role.appendChild(tag);

    const projects = document.createElement("td");
    if (t.role === "admin") {
      projects.textContent = "全部";
      projects.className = "muted";
    } else if (t.projects && t.projects.length > 0) {
      // 每个 project 一个可点击的标签，点一下即切换授权状态
      for (const key of t.projects) {
        const chip = document.createElement("span");
        chip.className = "tag active";
        chip.style.cursor = "pointer";
        chip.textContent = key + " ×";
        chip.title = "点击移除该授权";
        chip.onclick = () => revokeProjectGrant(t.id, t.projects.filter((p) => p !== key));
        projects.appendChild(chip);
        projects.appendChild(document.createTextNode(" "));
      }
    } else {
      projects.textContent = "—";
    }

    const status = document.createElement("td");
    const st = document.createElement("span");
    st.className = "tag " + t.status;
    st.textContent = { active: "有效", revoked: "已吊销", expired: "已过期" }[t.status] || t.status;
    status.appendChild(st);

    const used = document.createElement("td");
    used.className = "muted";
    used.textContent = fmtTime(t.last_used_at);

    const actions = document.createElement("td");
    if (t.status === "active") {
      const revoke = document.createElement("button");
      revoke.className = "danger";
      revoke.textContent = "吊销";
      revoke.onclick = () => revokeToken(t.id);
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
  renderProjects(data.projects);
  renderTokens(data.tokens);
  $("serverInfo").textContent = data.projects.length + " 个 project · " + data.tokens.length + " 个 token";
}

async function addProject() {
  const key = $("newProjectKey").value.trim();
  const name = $("newProjectName").value.trim();
  if (!key) return showError("请输入 project key");
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
    const ok = confirm(\`project "\${key}" 下还有 \${taskCount} 个任务，删除后不可恢复。\n确认删除？\`);
    if (!ok) return;
  } else if (!confirm(\`确认删除 project "\${key}"？\`)) {
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
  if (!confirm(\`确认吊销 token \${id}？该 token 将立即失效且不可恢复。\`)) return;
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
$("loginBtn").onclick = doLogin;
$("tokenInput").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
$("logoutBtn").onclick = () => logout();
$("refreshBtn").onclick = () => loadAll().catch((e) => showError(e.message));
$("addProjectBtn").onclick = addProject;
$("addTokenBtn").onclick = addToken;
$("secretClose").onclick = () => { $("secret").hidden = true; };
$("copyBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("secretValue").textContent);
    $("copyBtn").textContent = "已复制";
    setTimeout(() => ($("copyBtn").textContent = "复制"), 1500);
  } catch {
    $("copyBtn").textContent = "复制失败，请手动选中";
  }
};

// ---- 启动：有已登录 token 就直接进，否则显示登录页 ----
if (adminToken) {
  doLogin();
} else {
  $("login").hidden = false;
}
</script>
</body>
</html>`;
}
