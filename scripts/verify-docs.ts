// 校验 README / Develop 文档里的事实性陈述是否与代码一致。
//
// 为什么需要：文档里最容易腐烂的不是措辞，而是「看起来对但其实编了」的细节
// （退出码、命令名、环境变量、脚本名）。人不会去核对，CI 可以。
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DOCS = ["README.md", "README-zh.md", "Develop.md", "Develop-zh.md"];

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

console.log("=== 文件与语言切换 ===");
for (const f of DOCS) {
  check(`${f} 存在`, existsSync(join(ROOT, f)), `${readFileSync(join(ROOT, f), "utf8").length} 字节`);
}

// 每个文档都必须在顶部提供四份文档的互链
for (const f of DOCS) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const head = text.split("\n").slice(0, 12).join("\n");
  const links = ["README.md", "README-zh.md", "Develop.md", "Develop-zh.md"].filter((l) => head.includes(`](${l})`));
  check(`${f} 顶部链到全部四份文档`, links.length === 4, links.join(" "));
}

// ---- 事实核对：退出码 ----
const errorsSrc = readFileSync(join(ROOT, "src/core/errors.ts"), "utf8");
const realCodes = [...errorsSrc.matchAll(/^\s{2}([A-Z_]+):\s*(\d+),/gm)].map((m) => ({
  name: m[1]!,
  code: Number(m[2]),
}));
console.log(`\n=== 退出码（实际 ${realCodes.length} 个）===`);
for (const f of ["README.md", "README-zh.md"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  for (const { name, code } of realCodes) {
    check(`${f} 列出 ${name} = ${code}`, text.includes(`\`${code}\``) && text.includes(name));
  }
  // 文档不能编造不存在的码
  const docCodes = [...text.matchAll(/^\| `(\d+)` \| ([A-Z_]+) \|/gm)].map((m) => Number(m[1]));
  const real = new Set(realCodes.map((c) => c.code));
  const bogus = docCodes.filter((c) => !real.has(c));
  check(`${f} 无编造的退出码`, bogus.length === 0, bogus.length ? `多余：${bogus.join(",")}` : `${docCodes.length} 个`);
}

// ---- 事实核对：环境变量 ----
// ⚠ 扫描范围必须包含 compose/Dockerfile/.env.example：容器场景的变量
//   （KANBAN_BIND 等）只在那里定义，只扫 src/ 会把它们误报成「编造」。
//   匹配方式取宽松的标识符扫描：这些文件里出现的 KANBAN_ 开头 token
//   必然是环境变量名（插值写作 "${KANBAN_BIND:-...}"，不是行首声明）。
//   src/core/paths.ts 也在列：身份分片相关的 KANBAN_SESSION_KEY 定义在那里，
//   只扫 commands/ 会把 README 里对它的说明误报成「编造」。
const envFound = new Set<string>();
for (const f of [
  "src/core/config.ts",
  "src/core/paths.ts",
  "src/server/http.ts",
  "src/commands/context.ts",
  "src/commands/project.ts",
  "docker-compose.yml",
  "Dockerfile",
  ".env.example",
]) {
  const src = readFileSync(join(ROOT, f), "utf8");
  // 同名**常量**要排除：paths.ts 里的 `KANBAN_DIR` 是数据目录名 ".kanban"，
  // 不是环境变量。写成 `const KANBAN_X = ...` 的声明一律不算命中。
  // （目前全仓只有 KANBAN_DIR 一处，且没有任何真环境变量是这个形式，
  //   所以这条规则误伤不到东西——若将来出现，先把那个变量改成真读取。）
  const declared = new Set([...src.matchAll(/\bconst\s+(KANBAN_[A-Z_]+)\b/g)].map((m) => m[1]!));
  for (const m of src.matchAll(/\bKANBAN_[A-Z_]+\b/g)) {
    if (!declared.has(m[0])) envFound.add(m[0]);
  }
}
console.log(`\n=== 环境变量（实际 ${envFound.size} 个）===`);
for (const f of ["README.md", "Develop.md"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const docVars = new Set([...text.matchAll(/`(KANBAN_[A-Z_]+)`/g)].map((m) => m[1]!));
  const bogus = [...docVars].filter((v) => !envFound.has(v));
  const missing = [...envFound].filter((v) => !docVars.has(v));
  check(`${f} 环境变量准确`, bogus.length === 0, bogus.length ? `编造：${bogus.join(",")}` : `${docVars.size} 个`);
  if (f === "README.md") check(`${f} 未漏掉关键变量`, missing.length === 0, `漏：${missing.join(",")}`);
}

// ---- 事实核对：全局命令行选项 ----
const cliSrc = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
const flags = [...cliSrc.matchAll(/arg === "(--[a-z-]+)"/g)].map((m) => m[1]!);
console.log(`\n=== 全局选项（实际 ${flags.length} 个）===`);
for (const f of ["README.md"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const missing = flags.filter((fl) => !text.includes(`\`${fl}\``));
  check(`${f} 覆盖全部全局选项`, missing.length === 0, `漏：${missing.join(",") || "无"}`);
}

// ---- 事实核对：顶层命令 ----
// help / --help / -h / --version / -V / version 是内置别名而非功能命令，速查表不必列
const ALIASES = new Set(["help", "--help", "-h", "--version", "-V", "version", "undefined"]);
const topCmds = [...cliSrc.matchAll(/^ {4}case "([a-z-]+)":/gm)]
  .map((m) => m[1]!)
  .filter((c) => !ALIASES.has(c));
console.log(`\n=== 顶层命令（实际 ${topCmds.length} 个）===`);
for (const f of ["README.md"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const missing = topCmds.filter((c) => !text.includes(`agent-kanban ${c}`));
  check(`${f} 速查表覆盖全部顶层命令`, missing.length === 0, `漏：${missing.join(",") || "无"}`);
}

// ---- 事实核对：npm scripts ----
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
console.log(`\n=== package.json scripts ===`);
for (const f of ["Develop.md"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const docScripts = [...text.matchAll(/bun run ([\w:-]+)/g)].map((m) => m[1]!);
  const bogus = docScripts.filter((s) => !(s in pkg.scripts) && !s.startsWith("scripts/"));
  check(`${f} 引用的 script 都存在`, bogus.length === 0, bogus.length ? `编造：${bogus.join(",")}` : `${docScripts.length} 个引用`);
  const used = Object.keys(pkg.scripts).filter((s) => s.startsWith("verify:"));
  const missing = used.filter((s) => !text.includes(s));
  check(`${f} 覆盖全部 verify:* 脚本`, missing.length === 0, `漏：${missing.join(",") || "无"}`);
}

// ---- 事实核对：验证脚本确实存在 ----
console.log(`\n=== 验证脚本文件 ===`);
for (const f of ["Develop.md"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const named = [...text.matchAll(/`(verify-[\w-]+\.ts)`/g)].map((m) => m[1]!);
  const missing = [...new Set(named)].filter((s) => !existsSync(join(ROOT, "scripts", s)));
  check(`${f} 引用的脚本都真实存在`, missing.length === 0, `缺失：${missing.join(",") || "无"}`);
}

// ---- 事实核对：部署相关 ----
console.log(`\n=== 部署 ===`);
for (const f of ["README.md", "Develop.md", "README-zh.md", "Develop-zh.md"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  check(`${f} 提到 KANBAN_BIND`, text.includes("KANBAN_BIND"));
  check(`${f} 提到 .env / docker compose`, /docker compose/.test(text));
  check(`${f} 警告了明文 token 风险`, /plaintext|明文/.test(text));
}
check("compose 确实没有 caddy", !/^  caddy:/m.test(readFileSync(join(ROOT, "docker-compose.yml"), "utf8")));
check("compose 确实只有 kanban 一个服务", (readFileSync(join(ROOT, "docker-compose.yml"), "utf8").match(/^  [a-z][\w-]*:$/gm) ?? []).length <= 2);

// ---- 事实核对：开发文档提到的文件路径存在 ----
// 构建产物必须排除：`web/dist` 是 `vite build` 生成的，已在 .gitignore 里，
// 而 test job 从不构建前端（那正是 build job 的职责）。把它算进来会让
// 干净 checkout 上的 verify:docs 必然失败。
const GENERATED_PREFIXES = ["web/dist"];
console.log(`\n=== Develop 文档引用的路径 ===`);
for (const f of ["Develop.md", "Develop-zh.md"]) {
  const text = readFileSync(join(ROOT, f), "utf8");
  const paths = [...new Set([...text.matchAll(/`(src\/[\w./-]+|web\/[\w./-]+|docs\/[\w./-]+|scripts\/[\w./-]+)`/g)].map((m) => m[1]!))];
  const tracked = paths.filter((p) => !GENERATED_PREFIXES.some((g) => p === g || p.startsWith(`${g}/`)));
  const missing = tracked.filter((p) => !existsSync(join(ROOT, p)));
  check(`${f} 引用的路径都存在`, missing.length === 0, `缺失：${missing.join(", ") || "无"}（共 ${tracked.length} 个）`);
}

console.log(`\n${fails === 0 ? "✓ 文档事实核对全部通过" : `✗ ${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
