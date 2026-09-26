// 校验 GitHub workflow 文件：YAML 可解析 + 关键结构没被改坏。
// 顺便把「工作流机制部分不该有中文」这条规则固化下来，防止后来者加回中文 step 名。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const FILES = ["ci.yml", "release.yml"];

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

// 简单的行级 YAML 缩进/结构检查：够用即可，不引入 yaml 依赖
function parseYaml(text: string): { jobs: string[]; steps: number; ok: boolean } {
  const lines = text.split("\n");
  const jobs: string[] = [];
  let inJobs = false;
  let steps = 0;
  let ok = true;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S/.test(line) && line.trim() !== "") inJobs = false;
    if (!inJobs) continue;
    const job = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
    if (job) jobs.push(job[1]!);
    if (/^ {6}- (?:name|uses|run):/.test(line)) steps++;
    // tab 缩进会让 YAML 直接失效
    if (/^\t/.test(line)) ok = false;
  }
  return { jobs, steps, ok };
}

// Workflow 文件（含 release notes heredoc）全文应为英文：这些内容面向 GitHub 界面
// 与国际使用者，无豁免区间。
for (const file of FILES) {
  console.log(`\n=== ${file} ===`);
  const path = join(ROOT, ".github", "workflows", file);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");

  check("文件非空", text.length > 0, `${lines.length} 行`);

  const { jobs, steps, ok } = parseYaml(text);
  check("无 tab 缩进", ok);
  check("有 jobs 段且非空", jobs.length > 0, jobs.join(", "));
  check("有 steps", steps > 5, `${steps} 个`);

  // ---- 中文残留检查（全文，无豁免）----
  const cjk = /[一-鿿]/;
  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (cjk.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 60)}`);
  });
  check("全文无中文", offenders.length === 0, offenders.slice(0, 3).join(" | "));

  // ---- 关键结构 ----
  check("有 bun 版本固定", /BUN_VERSION:\s*"[\d.]+"/.test(text));
  check("安装依赖用 --frozen-lockfile", /bun install --frozen-lockfile/.test(text));
  check("引用 actions/checkout", /actions\/checkout@/.test(text));

  if (file === "ci.yml") {
    check("name: ci", /^name: ci$/m.test(text));
    check("PR 触发", /pull_request:/.test(text));
    check("三平台矩阵", /ubuntu-latest, windows-latest, macos-latest/.test(text));
    check("跑了 verify:deps", /verify:deps/.test(text));
    check("跑后端 typecheck", /bun run typecheck/.test(text));
    check("跑前端 typecheck", /cd web && bun run typecheck/.test(text));
    check("跑单元测试", /bun test/.test(text));
    check("二进制冒烟含 schema 前置动作", /gen:assets[\s\S]*build --compile[\s\S]*kanban --version/.test(text));
    check("有自包含二进制验证", /verify-binary\.ts/.test(text));
    check("Docker 只构建不推送", /Build Docker image \(no push\)/.test(text) && /push: false/.test(text));
    // GHA 缓存导出必须搭配 buildx：runner 默认的 `docker` driver 不支持导出
    check("用 GHA 缓存前装了 buildx", /docker\/setup-buildx-action/.test(text) && /cache-to:\s*type=gha/.test(text));
    check("并发时取消旧任务", /cancel-in-progress: true/.test(text));
  } else {
    check("name: release", /^name: release$/m.test(text));
    check("tag 触发 v*.*.*", /- "v\*\.\*\.\*"/.test(text));
    check("版本一致性校验", /GITHUB_REF_NAME#v/.test(text));
    check("不一致时报错退出", /::error::tag version/.test(text));
    check("需要 verify 门禁", /needs: verify/.test(text));

    // 只数 matrix 条目（行首锚定）。注意不能数全文，也不能用未锚定的 `- target: bun-`：
    // verify job 里那句 `grep -cE '^ *- target: bun-'` 自身就含该子串。
    const codeLines = text
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    const targetCount = (codeLines.match(/^ *- target: bun-/gm) ?? []).length;
    check("release 依赖 verify / binary / docker", /needs: \[verify, binary, docker\]/.test(codeLines));
    check("4 个平台矩阵", targetCount === 4, `${targetCount} 个`);

    // ---- artifact 下载必须带 pattern ----
    // 踩过的坑：`cache-to: type=gha` 会额外产生 `<owner>~<repo>~<id>.dockerbuild`，
    // 不带 pattern 的 download-artifact 会把构建缓存也当产物拉下来；它很大且易拉取
    // 失败（见过 “Artifact download failed after 5 retries”），直接把整个 Release 拖垮，
    // 尽管二进制早已下载完成。
    const dlIdx = text.indexOf("actions/download-artifact@v4");
    const dl = dlIdx === -1 ? "" : text.slice(dlIdx, text.indexOf("\n\n", dlIdx));
    check("download-artifact 带 pattern", /pattern:\s*bin-\*/.test(dl), dl.trim().replace(/\s+/g, " ").slice(0, 90));
    check("download-artifact 过滤掉 dockerbuild 缓存", !/dockerbuild/.test(dl));
    check("产物数量按 matrix 校验", /needs\.verify\.outputs\.platforms/.test(codeLines));
    check("产物数量不符则报错退出", /::error::expected \$\{EXPECTED\} platform binaries/.test(codeLines));
    check("校验和数量单独校验", /::error::expected \$\{EXPECTED\} \.sha256 files/.test(codeLines));

    // ---- files: 的 glob 不得互相重叠 ----
    // 踩过的坑：`files:` 同时写了 `release-assets/kanban-*` 和 `release-assets/*.sha256`。
    // glob 的 `*` 不跨越 `/`，但**可以匹配点号**，所以第一行已经把 4 个校验和文件收进来了，
    // 第二行让它们各被上传两次。action 把所有模式的匹配结果直接 concat（util.ts 的
    // `paths()` 不去重）后用 Promise.all 并发上传，同名资产并发 POST 是竞态：GitHub
    // 拒掉其中一个（404/422），action 只能靠重新列举资产碰运气找回，找不到就整个 step
    // 挂掉（`Error: Not Found - .../update-a-release-asset`，v0.1.1 发布失败；
    // v0.1.0 用同一份配置侥幸通过了）。日志里只有被传两遍的 `.sha256` 报错，
    // 8 个唯一文件全部上传成功，这个特征就是重复上传的指纹。
    // 这里反过来做：用矩阵里的 asset 名展开 `files:` 的每个模式，要求每个资产
    // （含 `.sha256`）**恰好**被一个模式命中。
    const filesIdx = text.indexOf("\n          files: |");
    const filesEnd = filesIdx === -1 ? -1 : text.indexOf("fail_on_unmatched_files", filesIdx);
    // 只取 glob 本身：块里还跟着 `overwrite_files:` / `fail_on_unmatched_files:` 这类
    // 同缩进的键值行，它们不是路径，包含进来会让每个模式的命中数都算错。
    const filePatterns =
      filesIdx === -1 || filesEnd === -1
        ? []
        : text
            .slice(filesIdx, filesEnd)
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "" && !l.startsWith("#") && !/^[a-z_]+:/.test(l));
    check("release 的 files: 块可解析", filePatterns.length > 0, filePatterns.join(" | "));

    // 极简 glob：只支持 `*`（不跨 `/`），够覆盖 files: 里的写法
    const globRe = (pattern: string) =>
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    // 注意用 [ \t] 而不是 \s：带 m 标志时 \s 会吃掉换行，跨行误匹配
    const assetNames = [...text.matchAll(/^[ \t]*asset:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]!);
    // 模式带目录前缀，比对时也要带上，否则 `release-assets/kanban-*` 一个都匹配不上
    const expectedAssets = assetNames.flatMap((a) => [`release-assets/${a}`, `release-assets/${a}.sha256`]);
    check("矩阵里取到 4 个 asset 名", assetNames.length === 4, assetNames.join(", "));
    const badMatches = expectedAssets.filter(
      (name) => filePatterns.filter((p) => globRe(p).test(name)).length !== 1,
    );
    check(
      "每个平台资产（含 .sha256）恰好被一个 glob 命中",
      expectedAssets.length > 0 && badMatches.length === 0,
      badMatches.length ? `命中数不为 1：${badMatches.join(", ")}` : `${expectedAssets.length} 个资产`,
    );
    check("release-notes.md 在 files: 里", filePatterns.includes("release-notes.md"));
    // 重跑失败发布是常规修复手段，overwrite_files 决定重跑能否收敛（默认 true，显式钉住）
    check("显式 overwrite_files: true", /overwrite_files:\s*true/.test(text));

    // ---- 自引用计数陷阱 ----
    // 踩过的坑：在 release 里 `grep -c 'target: bun-' .github/workflows/release.yml`，
    // 那条 grep 命令自己也是一处匹配，计数被抬高 1 → “expected 5, found 4”。
    // 现在平台数由 verify job 通过 job outputs 传递；且 grep 模式必须锚定行首。
    check("平台数经 job outputs 传递", /platforms: \$\{\{ steps\.count\.outputs\.platforms \}\}/.test(text));
    // 「release job 不得自行 grep 计数」：只检查 release job 段，verify job 里
    // 同一个 grep 是合法的（它就是权威计数点）
    const relIdx = codeLines.indexOf("\n  release:");
    const relBody = relIdx === -1 ? "" : codeLines.slice(relIdx);
    check("release 不自行 grep 计数", !/grep -c/.test(relBody), relBody.match(/grep -c[^\n]*/)?.[0] ?? "");
    check("grep 模式锚定行首", /grep -cE '\^ \*- target: bun-'/.test(codeLines));
    check("release 的 needs 含 verify", /needs: \[verify, binary, docker\]/.test(codeLines));
    // arm64 二进制已移除：Docker 镜像多架构覆盖，且 arm64 独立产物只能用 qemu 冒烟
    check("不再发布 linux-arm64 二进制", !/bun-linux-arm64/.test(text) && !/kanban-linux-arm64/.test(text));
    // 只要求**冒烟测试里**没有 qemu 分支；setup-qemu-action 本身仍需要，
    // 因为 Docker 镜像本身就是多架构（linux/amd64 + linux/arm64）。
    check("冒烟测试不再有 qemu 分支", !/platform linux\/arm64/.test(text));
    check("Docker 仍构建多架构", /platforms:\s*linux\/amd64,linux\/arm64/.test(text));
    check("release notes 指向 Docker 替代 arm64", /linux-arm64|aarch64|arm64/i.test(text));

    // ---- digest 记录 ----
    // 曾用 `| head -c 200` 截断多行 JSON 再写 $GITHUB_OUTPUT，GitHub 按 key=value
    // 逐行解析，遇到 JSON 片段直接报 Invalid format。现在必须产出**单行**值。
    check("digest 提取不截断多行输出", !/head -c \d+/.test(text), "仍有 head -c 截断");
    check("digest 从 imagetools inspect 取 sha256", /imagetools inspect[\s\S]*sha256:/.test(text));
    check("digest 通过 job outputs 传给 release", /outputs:[\s\S]*steps\.digest\.outputs\.digest/.test(text));
    check("release notes 展示 digest", /needs\.docker\.outputs\.digest/.test(text));
    check("生成校验和", /sha256sum/.test(text) && /shasum -a 256/.test(text));
    // 只推 GHCR：release.yml 已移除 Docker Hub 步骤（secrets 在 step 级 if 里
    // 不可用，会直接让 workflow 文件解析失败）
    check("只推 GHCR", /ghcr\.io/.test(text) && !/DOCKERHUB/.test(text));
    check("release notes 已改为英文", /project-scoped task board shared by multiple agent sessions/.test(text));
    check("产物必须先内嵌前端", /cd web && bun run build[\s\S]*gen:assets/.test(text));

    // ---- registry 路径必须全小写 ----
    // 踩过的坑：github.repository 的 owner 可以带大写（ArnoChenFx），直接拼进 tag
    // 会被 buildx 拒绝（repository name must be lowercase），而且只在真推送时才炸。
    // 固化成门禁，并要求“先小写化，再引用”。
    check(
      "tag 未直接拼接 github.repository",
      !/ghcr\.io\/\$\{\{ github\.repository \}\}/.test(text),
      "有直接拼 ${{ github.repository }} 的地方",
    );
    check("镜像坐标经小写化步骤产出", /tr '\[:upper:\]'\ '\[:lower:\]'/.test(text) && /steps\.meta\.outputs\.ghcr/.test(text));
    check("镜像路径不重复拼仓库名", !/github\.repository \}\}\/agent-kanban:/.test(text));

    // compose 的默认镜像必须与 release 推送到的是同一个（小写、同一路径）
    const composeImg =
      /image:\s*"?ghcr\.io\/([\w.\/-]+)/.exec(readFileSync(`${ROOT}/docker-compose.yml`, "utf8"))?.[1] ?? "";
    check("compose 默认镜像已解析", composeImg.length > 0, composeImg);
    check("compose 默认镜像全小写", composeImg === composeImg.toLowerCase(), composeImg);
    check("compose 默认镜像不含大写 owner", !/ArnoChenFx/.test(composeImg), composeImg);
  }
}

console.log(`\n${fails === 0 ? "✓ workflow 校验全部通过" : `✗ ${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
