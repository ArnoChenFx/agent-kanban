// 校验 docker-compose.yml / Caddyfile / bootstrap.sh 的结构与关键约定
// 本机没有 docker 时，至少把能静态查的问题查出来
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 仓库根目录：从本脚本位置推导。
// 不能写死绝对路径 —— CI 上仓库克隆到 /home/runner/work/...，写死的路径必然 ENOENT。
const ROOT = resolve(import.meta.dir, "..");

// ⚠ 读文件一律走这里，归一化换行符。
//   Windows runner 上 git 的 core.autocrlf 默认为 true，checkout 出来是 CRLF。
//   本脚本大量检查是「行结构」正则（/^services:\n/、/^  (\w+):$/gm），
//   CRLF 下它们会整段失配 —— 本机和 Linux CI 全绿，只有 Windows 报红。
//   附带好处：归一化后「无行尾空格」这条才真正生效（CRLF 下 ` +$` 匹配不到）。
const readText = (rel: string) => readFileSync(`${ROOT}/${rel}`, "utf8").replace(/\r\n/g, "\n");

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

console.log("=== docker-compose.yml ===");
const compose = readText("docker-compose.yml");

// 1. 缩进一致性（YAML 最常见的错）
const lines = compose.split("\n");
const badIndent = lines.filter((l) => /^\t/.test(l));
check("无 Tab 缩进（YAML 只认空格）", badIndent.length === 0, badIndent.length ? `${badIndent.length} 行` : "");
check("无行尾空格", !/ +$/m.test(compose));

// 2. 顶层结构
check("顶层 name", /^name:\s+\S+/m.test(compose));
check("services 段", /^services:/m.test(compose));
check("volumes 段", /^volumes:/m.test(compose));

// 只统计 services 段里的服务名（volumes 段也是两空格缩进，会被误算）
const servicesSection = /^services:\n([\s\S]*?)(?=^volumes:|^[a-z])/m.exec(compose)?.[1] ?? "";
const serviceNames = [...servicesSection.matchAll(/^  ([a-z][\w-]*):$/gm)].map((m) => m[1]!);
// 服务名是 `agent-kanban`（与 compose 项目名、镜像名、二进制名一致）。
// ⚠ 这里曾经断言 `kanban`：3387e19 把 compose 服务改名成 agent-kanban 时漏改了这个门禁，
//   于是 verify:deploy 一直报「只保留 kanban 一个服务」，而实际 compose 没问题。
//   volume 仍叫 `kanban-data`（改名时**没**动它，用户的 -v kanban-data:/data 照旧能用）。
check(
  "只保留一个服务，且名为 agent-kanban",
  serviceNames.length === 1 && serviceNames[0] === "agent-kanban",
  serviceNames.join(", "),
);
check("volume 仍叫 kanban-data（改名未波及挂载名）", /kanban-data:/m.test(compose));
check("已移除 caddy", !serviceNames.includes("caddy"));
check("已移除 bootstrap", !serviceNames.includes("bootstrap"));
check("无 tls profile", !/profiles:\s*\["tls"\]/.test(compose));
check("管理员 token 走环境变量", /KANBAN_ADMIN_TOKEN/.test(compose));

// 4. 安全与运维约定
check("kanban 默认只绑回环", /KANBAN_BIND:-127\.0\.0\.1/.test(compose));
check("容器内绑 0.0.0.0", /KANBAN_HOST:\s*"0\.0\.0\.0"/.test(compose));
check("有健康检查", /healthcheck:/.test(compose));
check("有 restart 策略", /restart:\s*unless-stopped/.test(compose));
check("数据卷已声明", /kanban-data:/.test(compose));
check("日志轮转已配置", /max-size/.test(compose));

// 镜像不再可配置：compose 里直接写死 ghcr.io/arnochenfx/agent-kanban:latest，
// KANBAN_IMAGE 已从 compose 与 .env.example 中移除。下面两条只守住「仍然从
// GHCR 拉取、且没有偷偷退回本地构建」这两个约定。
check("镜像来自 GHCR", /image:\s*ghcr\.io\//.test(compose));
check("不再本地构建", !/^\s{4}build:$/m.test(compose));

console.log("\n=== deploy/ 与 bootstrap ===");
const { existsSync } = await import("node:fs");
check("无 deploy/ 目录（已去掉 bootstrap）", !existsSync(`${ROOT}/deploy`));
check("compose 无 bootstrap 服务", !/\n  bootstrap:/.test(compose));

console.log("\n=== .env.example ===");
const env = readText(".env.example");
check("含 KANBAN_BIND", /KANBAN_BIND=/.test(env));
check("含 KANBAN_PORT", /KANBAN_PORT=/.test(env));
check("含 KANBAN_ADMIN_TOKEN", /^KANBAN_ADMIN_TOKEN=/m.test(env));
check("说明了 token 格式要求", /32 lowercase hex/i.test(env));
check("无 KANBAN_DOMAIN（已移除 TLS 方案）", !/^KANBAN_DOMAIN=/m.test(env));
check("说明了 TLS 需自备", /TLS/.test(env));
check("无行尾空格", !/ +$/m.test(env));

// 部署配置是给部署者读的，不只是给维护者读：这两个文件里不该出现中文，
// 和 verify-workflows.ts 对 workflow 的要求是同一条约定。
for (const [label, text] of [["docker-compose.yml", compose], [".env.example", env]] as const) {
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  check(`${label} 注释为英文（无中文）`, cjk.length === 0, cjk.slice(0, 3).join(" | "));
}

console.log("\n=== Dockerfile ===");
const df = readText("Dockerfile");
check("多阶段（≥2 个 FROM）", (df.match(/^FROM/gm) ?? []).length >= 2);
// 只看非注释行：Dockerfile 头部注释里会解释“为什么不 compile”，会误命中
const dfCode = df
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");
check("用 bun 跑源码而非 compile", /ENTRYPOINT \["bun", "run"/.test(dfCode));
check("无实际 bun build --compile 步骤", !/bun build --compile/.test(dfCode));
check("拷入源码 src", /COPY .*src \.\/src/.test(df));
check("拷入前端产物", /web\/dist/.test(df));
check("设置 KANBAN_WEB_DIR", /KANBAN_WEB_DIR=/.test(df));
check("chown /data（非 root 可写）", /chown -R kanban:kanban \/data/.test(df));
check("HEALTHCHECK", /HEALTHCHECK/.test(df));
check("声明 VOLUME", /VOLUME/.test(df));
check("无 tab 缩进", !/^\t/m.test(df));

console.log("\n=== 前端资源内嵌（发布二进制用）===");
const gen = readText("scripts/gen-assets.ts");
check("gen-assets 存在且扫描 dist", /readdirSync/.test(gen) && /web\/dist/.test(gen));
check("生成 manifest 到 src/server", /assets\.generated\.ts/.test(gen));
const manifest = readText("src/server/assets.generated.ts");
// 必须严格是**空表占位**。只 grep `EMBEDDED_ASSETS` 是不够的 —— 真实清单里
// 也有这个名字，于是检查永远是绿的，直到有人把构建产物提交上去：
// 清单里全是 `import ... from "../../web/dist/assets/xxx.woff2"` 的字面量路径，
// 而干净 checkout 还没有 web/dist，`bun test` 会直接抛
// "Cannot find module '../../web/dist/assets/...'"，tsc 也跟着炸。
//
// ⚠ 本检查断言的是**运行时**文件内容，所以别把会触发 gen:assets 的步骤
//   （`web:build`、直接跑 gen:assets）挪到本脚本之前。build / e2e job 都是在
//   前端产物生成之前调用它的。
const isPlaceholder =
  /EMBEDDED_ASSETS: EmbeddedAssetMap = \{\}/.test(manifest) && /EMBEDDED_COUNT = 0/.test(manifest);
check(
  "manifest 是空表占位（不是构建产物）",
  isPlaceholder,
  isPlaceholder ? "" : "检测到真实清单：它引用了 web/dist 的字面量路径，干净 checkout 上无法解析",
);
check("package.json 有 gen:assets", /"gen:assets"/.test(readText("package.json")));

console.log(`\n${fails === 0 ? "✓ 全部检查通过" : `✗ ${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
