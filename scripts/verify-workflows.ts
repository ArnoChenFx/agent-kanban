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
    check("release 依赖 binary 与 docker", /needs: \[binary, docker\]/.test(text));
    // 只数 matrix 条目（`- target: bun-`），不能数全文：注释里提到这个字符串会被计入
    const codeLines = text
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    check("4 个平台矩阵", (codeLines.match(/- target: bun-/g) ?? []).length === 4, `${(codeLines.match(/- target: bun-/g) ?? []).length} 个`);

    // ---- artifact 下载必须带 pattern ----
    // 踩过的坑：`cache-to: type=gha` 会额外产生 `<owner>~<repo>~<id>.dockerbuild`，
    // 不带 pattern 的 download-artifact 会把构建缓存也当产物拉下来；它很大且易拉取
    // 失败（见过 “Artifact download failed after 5 retries”），直接把整个 Release 拖垮，
    // 尽管二进制早已下载完成。
    const dlIdx = text.indexOf("actions/download-artifact@v4");
    const dl = dlIdx === -1 ? "" : text.slice(dlIdx, text.indexOf("\n\n", dlIdx));
    check("download-artifact 带 pattern", /pattern:\s*bin-\*/.test(dl), dl.trim().replace(/\s+/g, " ").slice(0, 90));
    check("download-artifact 过滤掉 dockerbuild 缓存", !/dockerbuild/.test(dl));
    check("产物数量按 matrix 校验", /EXPECTED=\$\(grep -c /.test(codeLines));
    check("产物数量不符则报错退出", /::error::expected \$\{EXPECTED\} platform binaries/.test(codeLines));
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
