// 站点双语：EN 原文写在 HTML 里（data-i18n 标记），这里只维护 zh 词条。
// 切换状态存 localStorage("site.locale")，首次访问按浏览器语言。
// 缺词条时回退英文并 console.warn，方便对账。
const SiteZh = {
  "nav.how": "设计理念",
  "nav.install": "安装",
  "nav.docs": "文档",

  "hero.h1": "谁接手，<br>谁就知道发生过什么。",
  "hero.sub": "agent-kanban 是一个项目级任务看板，让多个 AI agent 会话共享同一份事实来源。一个会话崩溃后，下一个能直接接上它的工作。",
  "hero.cta1": "快速开始",
  "hero.cta2": "在 GitHub 上查看",
  "hero.badge1": "单个二进制",
  "hero.badge2": "macOS · Linux · Windows",
  "hero.badge3": "内置 Web 界面",

  "why.h2": "每次重启都是一次考古",
  "why.lead": "你在一个仓库里同时跑多个编码 agent。某个 agent 干到一半死了：网络抖动、OOM，或者合上了笔记本。活下来的只有终端回滚缓冲区里没人能再读到的工作痕迹。",
  "why.c1h": "上下文随会话一起死",
  "why.c1p": "Agent A 改认证层改到一半。那段上下文只存在于 Agent A 的提示窗口里。",
  "why.c2h": "下一个 agent 从零开始",
  "why.c2p": "Agent B 看到一张叫「修认证」的卡，从零摸索，更糟的是，可能与 A 已经做过的直接冲突。",
  "why.c3h": "没人知道哪份是最新的",
  "why.c3p": "三个开着的分支哪条还在用？任务清单在一个 TODO 文件里，推理过程在输出窗口里，状态在你脑子里。",

  "how.h2": "四个理念撑起整个设计",
  "how.lead": "每个 agent 拿到的是一张任务卡上的租约、一条只追加的事件日志，外加一套交接协议。新会话开局就有上一个会话真实的上下文，不是一个任务标题。",
  "how.1h": "所有权是一份租约",
  "how.1p": "<code class=\"inline\">task claim</code> 授予限时租约。租约到期，无论是崩溃、被杀还是走开了，任务自动回收，交给下一个会话。",
  "how.2h": "事件日志是唯一事实",
  "how.2p": "每次状态变更都是一条事件。看板只是投影，<code class=\"inline\">rebuild</code> 可以重放整条日志并与存储逐字段比对。",
  "how.3h": "交接是写出来的，不是生成的",
  "how.3p": "收尾的会话写下：做完了什么、接下来做什么，以及卡在哪。<code class=\"inline\">resume</code> 会先展示它。崩溃时自动合成的交接会明确说明「上一个持有者已失联」。",
  "how.4h": "计划是版本化的",
  "how.4p": "<code class=\"inline\">plan save</code> 从不覆盖，只会把旧版标记为 superseded。完整的版本链，以及当初为什么这么决策，随时可查。",

  "shots.h2": "看板",
  "shots.lead": "自带 Web 界面：看板视图、任务详情时间线和 SSE 实时更新，由同一个二进制在本地直接提供。",
  "shots.cap1": "看板视图：租约持有者、进度和阻塞一目了然",
  "shots.cap2": "任务详情：checklist、依赖关系与完整事件时间线",

  "inst.h2": "安装",
  "inst.lead": "一行安装，无需运行时。二进制自包含：Bun 运行时、数据库 schema 和整个 Web 界面都已内嵌。",
  "inst.tab.macos": "macOS / Linux",
  "inst.tab.win": "Windows",
  "inst.tab.src": "从源码构建",
  "inst.note.mac": "安装到 ~/.local/bin 并加入 PATH，不需要 sudo。升级就是重跑同一条命令，也可以用 agent-kanban update。",
  "inst.note.win": "cmd 和 PowerShell 里都能跑。安装到 %LOCALAPPDATA%\\Programs\\agent-kanban 并加入 PATH，不需要管理员权限。",
  "inst.note.src": "需要 Bun ≥ 1.4.2。",
  "inst.next.h": "然后在你的仓库里",
  "inst.next.note": "install-protocol 会把协作协议写进项目的 AGENTS.md，agent 读到它就知道先跑 session start 和 context。",

  "integ.h": "让 agent 用上看板",
  "integ.lead": "三种方式互补：技能教 agent 怎么做，协议文件让它形成习惯，MCP 工具给它动手的能力。",
  "integ.opt1h": "1. 协议文件",
  "integ.opt1p": "往 AGENTS.md 写入一个受管理的协议块，任何读 AGENTS.md 的 agent 都会知道先跑 <code class=\"inline\">session start</code> 和 <code class=\"inline\">context</code> 再动代码。支持 <code class=\"inline\">--check</code> 做 CI 守卫。",
  "integ.opt2h": "2. MCP 工具",
  "integ.opt2p": "通过 stdio 提供 20 个工具，是 CLI 同一套 core 的薄封装。每个工具返回 <code class=\"inline\">{ ok, data, next_actions }</code>，失败带与 CLI 一致的退出码语义。",
  "integ.opt3h": "3. agent 技能",
  "integ.opt3p": "教的是工作流：task claim 返回退出码 3 该怎么办、task progress 兼职续租、doing → done 为什么要走 review。",
  "integ.more": "更多细节见<a href=\"docs.html\">文档页</a>。",

  "docs.h1": "文档",
  "docs.lead": "运行 agent-kanban 并把 agent 接上看板所需要的一切。",
  "docs.nav.quick": "快速开始",
  "docs.nav.agents": "接入 agent",
  "docs.nav.remote": "服务端与客户端",
  "docs.nav.cli": "命令参考",
  "docs.nav.exit": "退出码",
  "qs.h2": "快速开始",
  "qs.lead": "安装、建板、启动服务，三步。",
  "agents.h2": "接入 agent",
  "agents.lead": "三种方式可以叠加使用：协议文件管习惯，MCP 工具管操作，技能管工作流。",
  "agents.p1h": "协议文件（适用任何 agent）",
  "agents.p1p": "在项目的 AGENTS.md 里写入一个受管理块（agent-kanban:begin / end 之间），不动文件的其他内容。doctor 会在协议块落后于 CLI 版本时提醒你。",
  "agents.p2h": "MCP 工具",
  "agents.p2p": "注册到任何支持 MCP 的 harness。板子按工作目录向上查找，同一个仓库里的 agent 自动共享。",
  "agents.p3h": "agent 技能",
  "agents.p3p": "把 agent 最容易做错的部分打包成参考文件：完整命令参考、MCP 工具对照、本地与远程模式的差异、按退出码索引的排障表。装到已有看板的项目里即可。",
  "cli.h2": "命令参考",
  "cli.lead": "完整参数列表见 <code class=\"inline\">agent-kanban &lt;command&gt; --help</code>。",

  "remote.h2": "服务在一台机器，CLI 在各处",
  "remote.lead": "一个 serve 进程可以承载多个 project，每个 project 完全隔离：独立的任务、独立的 token、独立的 T 编号空间。客户端只需要服务地址、project key 和一个 token，不需要数据库，也不需要运行时。",
  "remote.server.h": "在服务端机器上",
  "remote.client.h": "在客户端机器上",
  "remote.oneline": "或者一条命令搞定：",
  "remote.note": "配了 server 就是 remote 模式，没配就是 local 模式。优先级：CLI 旗标 &gt; 环境变量 &gt; config.toml &gt; 推导默认值。空的环境变量算「未设置」，不是空值。",
  "remote.sec": "serve 不终结 TLS，默认只绑 127.0.0.1。要绑 0.0.0.0 之前先放到 TLS 终结器（nginx、网关、Ingress 均可）后面——没有 TLS，token 就是明文传输。",
  "exit.h2": "退出码",
  "exit.lead": "这是对外发布的契约，agent 应该按退出码（或 --json 里的 error.name）分支，永远不要按报错文案分支。",
  "exit.action.h": "怎么处理",
  "docs.more": "更完整的内容（FAQ、配置、远程模式、HTTP API）见 GitHub 上的 <a href=\"https://github.com/ArnoChenFx/agent-kanban#readme\">README</a> 与 <a href=\"https://github.com/ArnoChenFx/agent-kanban/blob/main/Develop.md\">开发者文档</a>。",
  "docs.purpose": "用途",

  "cmd.init": "在当前目录创建本地看板（.kanban/）",
  "cmd.protocol": "把 agent 协作协议写进项目的 AGENTS.md",
  "cmd.mcp": "运行 MCP server（stdio），让 agent 把看板当工具调用",
  "cmd.session": "会话生命周期",
  "cmd.task": "任务操作",
  "cmd.board": "终端里的泳道视图",
  "cmd.context": "读取现场：看板 + 交接 + 建议动作",
  "cmd.resume": "接管一张卡；注入交接内容与时间线",
  "cmd.handoff": "写交接（summary / next / blockers / open）",
  "cmd.plan": "版本化计划",
  "cmd.rebuild": "重放事件日志并校验投影",
  "cmd.doctor": "一致性自检与修复",
  "cmd.export": "导出事件日志（每天一个文件）",
  "cmd.import": "从日志重建数据库（跨机迁移）",
  "cmd.snapshot": "写一份人类可读的看板快照",
  "cmd.compact": "修剪旧事件（先落快照）",
  "cmd.config": "配置",
  "cmd.project": "查询项目（本地数据库）",
  "cmd.admin": "项目与 token 管理",
  "cmd.update": "从 GitHub Releases 自更新二进制（带校验和）",
  "cmd.serve": "运行 HTTP + SSE 服务",

  "exit.m.0": "成功",
  "exit.a.0": "—",
  "exit.m.1": "参数错误",
  "exit.a.1": "读 details.usage，修正命令",
  "exit.m.2": "状态错误：任务不存在、非法状态迁移、缺 --reason",
  "exit.a.2": "不要原样重试",
  "exit.m.3": "任务被另一个持有活跃租约的会话占着",
  "exit.a.3": "换一张卡或等待，不要伸手要 --force",
  "exit.m.4": "数据库被锁",
  "exit.a.4": "退避重试，最多 3 次",
  "exit.m.5": "没有 .kanban/ 目录，或 schema 需要迁移",
  "exit.a.5": "跑 agent-kanban init",
  "exit.m.6": "内部错误",
  "exit.a.6": "这是 bug，上报，不要重试",
  "exit.m.7": "缺 key、key 错，或 project 不存在",
  "exit.a.7": "修好凭证"
};

(function () {
  const STORE_KEY = "site.locale";
  function stored() {
    try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }
  function detect() {
    const s = stored();
    if (s === "zh" || s === "en") return s;
    return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  function apply(lang) {
    let missing = 0;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      if (!el.dataset.en) el.dataset.en = el.innerHTML;
      const key = el.getAttribute("data-i18n");
      if (lang === "zh") {
        const val = SiteZh[key];
        if (val === undefined) { missing++; el.innerHTML = el.dataset.en; }
        else el.innerHTML = val;
      } else {
        el.innerHTML = el.dataset.en;
      }
    });
    if (missing) console.warn("[site] missing zh keys:", missing);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.querySelectorAll(".lang-toggle").forEach(function (b) {
      b.textContent = lang === "zh" ? "English" : "中文";
      b.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切换到中文");
    });
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* 私密模式忽略 */ }
  }
  window.SiteI18n = {
    current: detect,
    toggle: function () { apply(detect() === "zh" ? "en" : "zh"); }
  };
  document.addEventListener("DOMContentLoaded", function () {
    apply(detect());
    document.querySelectorAll(".lang-toggle").forEach(function (b) {
      b.addEventListener("click", SiteI18n.toggle);
    });
  });
})();
