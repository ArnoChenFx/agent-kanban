---
name: agent-kanban-development
description: agent-kanban 仓库内开发新功能的端到端流程：新增 CLI 命令（core → commands → cli.ts → 离线测试 → README → verify:docs）与 Web/管理页改动的完整回归链（先 web:build 再 verify:web:ui 真浏览器验证），含 Windows EPERM、失效 GITHUB_TOKEN、verify:docs 覆盖核对等已验证的踩坑解法。当任务是在 agent-kanban 仓库加命令/功能、改 web/src 或 src/server/admin-page.ts、bun build --compile 报 EPERM、verify:docs 或 verify:web:ui 失败时使用。看板使用与多会话协作协议见 agent-kanban skill 与 AGENTS.md，不在本 skill 范围。
---

# agent-kanban 开发流程

开工先读 AGENTS.md——文案英文化、Web i18n、project 记忆等约定都在那里，本 skill 只补它没覆盖的端到端步骤与踩坑。所有 script 名以 `package.json` 的 `scripts` 为准，接口形状以 `src/core/ops.ts` 为准。

## 新增 CLI 命令的流水线

按顺序走，每一环都有下游守卫：

1. **core 模块**（`src/core/<feature>.ts`）：业务逻辑只放这里，本地与远程共用。依赖网络等外部环境时注入实现参数（如 `fetchImpl`），保证测试离线、测试路径与生产路径不分叉。
2. **commands 模块**（`src/commands/<feature>.ts`）：只做参数解析 → 构造 Op → 调 Backend → 格式化输出。用 `parseArgs` + `assertKnownOptions`，未识别参数必须报 USAGE（agent 依赖报错自我修正，静默吞掉是大错）；输出走 `createOutput(json)`，`--json` 模式 stdout 只能有单个 JSON 对象，错误走 stderr。
3. **cli.ts**：加路由（`case "<cmd>"`）与主帮助文本。退出码语义是已发布契约（`src/core/errors.ts`），不要发明新含义。
4. **测试**（`test/<feature>.test.ts`）：全部离线——fetch 注入、临时目录、已知校验值向量。禁止真联网（CI 与沙箱会挂）。伪造 sha256 要用真实已知向量（如空串 `e3b0c44...`）；断言"文件不存在"前先确认探测函数不会顺手删/建文件。
5. **文档**：README.md 与 README-zh.md 的命令速查表必须加新命令，README 顶层还要覆盖全部全局选项。
6. **验证**：`bun test`、`bun run typecheck`、`bun run verify:docs`、CJK 扫描（`rg -n '[\x{4e00}-\x{9fff}]' src/commands src/cli.ts src/mcp`，非注释行必须为 0）。

`verify:docs` 是硬覆盖核对：README 必须包含全部顶层命令与全局选项，Develop.md 必须覆盖全部 `verify:*` 脚本。新增任何一个而漏改文档，verify:docs 必失败——这是守卫在起作用，不是误报。

## Web / 管理页改动回归链

改 `web/src/**` 或 `src/server/admin-page.ts` 后：

1. `bun run web:build`——**必须先做**。serve 与 verify 脚本读的是 `web/dist` 与生成的 `src/server/assets.generated.ts`，不 build 会拿陈旧产物跑回归，得到假绿/假红。
2. `bun run web:typecheck`——web 不在根 `tsc --noEmit` 范围内，参数名写错根 typecheck 不报。
3. `bun run verify:web:ui`——真浏览器全流程回归。给 UI 加了行为，就在 `scripts/verify-web-ui.ts` 补一条对应断言，别只靠手点。
4. 全量 `bun test` 确认无回归。

改 `admin-page.ts` 内联 JS 时：模板字符串先吃一层转义，`\w` 会变成 `w`、反引号会终止字符串——按"多了一层转义"来审。

## 踩坑速查（已验证）

- **Windows 下 `bun build --compile` 报 EPERM**（"failed to move executable to dist/agent-kanban.exe"）：正在运行的 agent-kanban.exe（serve/mcp 等常驻进程）锁住了输出文件。不要杀它——那是用户开着的进程。换一个输出文件名编译验证即可，例如 `bun build --compile src/cli.ts --outfile dist/agent-kanban-dev-test.exe`，验证完删掉自己的产物。
- **GitHub API 401 而非 403**：环境里的 `GITHUB_TOKEN` 可能已失效，被代码原样带上导致 401。用 curl 对照定位（无 token 200 / 带 token 401）。修复方向：公开仓库的读操作在 401 时退回匿名重试（token 只用于提升限额）；同时提醒用户清理失效 token。
- **verify:docs 失败先查归属**：失败项可能来自用户 staged 的、与本任务无关的改动（如新增 `verify:install` 但 Develop.md 没跟上）。先 `git status` / `git diff --staged` 判断；是别人的进行中工作就不要动，说明归属后跳过该项继续，不要顺手替人补文档。
- **web 改完忘记 build 就跑回归**：症状是改了源码但 verify:web:ui 行为没变。先 `web:build` 再怀疑别的。

## 完成前自查

- [ ] `bun test` 全绿、`tsc --noEmit` 干净
- [ ] 动过 web/admin → 已 `web:build` 并跑过 `verify:web:ui`
- [ ] 动过命令/脚本 → `verify:docs` 通过
- [ ] 新命令进了两份 README 的速查表
- [ ] 面向用户的字符串全英文（`rg` 扫描通过），注释中文 OK
