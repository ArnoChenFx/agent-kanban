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

// Release notes 的 heredoc 是产品内容，保留中文；这里显式列出豁免区间
const RELEASE_NOTES_START = "cat > release-notes.md <<EOF";
const RELEASE_NOTES_END = "          EOF";

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

  // ---- 中文残留检查（豁免 release notes 正文）----
  const cjk = /[一-鿿]/;
  const offenders: string[] = [];
  let inNotes = false;
  lines.forEach((line, i) => {
    if (line.includes(RELEASE_NOTES_START)) inNotes = true;
    if (line.trim() === RELEASE_NOTES_END.trim()) inNotes = false;
    if (inNotes) return;
    if (cjk.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 60)}`);
  });
  check("工作流机制部分无中文", offenders.length === 0, offenders.slice(0, 3).join(" | "));

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
    check("5 个平台矩阵", (text.match(/target: bun-/g) ?? []).length === 5, `${(text.match(/target: bun-/g) ?? []).length} 个`);
    check("arm64 走 qemu", /--platform linux\/arm64/.test(text));
    check("生成校验和", /sha256sum/.test(text) && /shasum -a 256/.test(text));
    // 只推 GHCR：release.yml 已移除 Docker Hub 步骤（secrets 在 step 级 if 里
    // 不可用，会直接让 workflow 文件解析失败）
    check("只推 GHCR", /ghcr\.io/.test(text) && !/DOCKERHUB/.test(text));
    check("release notes 仍为中文（产品内容）", /多会话 agent 共享的项目级任务看板/.test(text));
    check("产物必须先内嵌前端", /cd web && bun run build[\s\S]*gen:assets/.test(text));
  }
}

console.log(`\n${fails === 0 ? "✓ workflow 校验全部通过" : `✗ ${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
