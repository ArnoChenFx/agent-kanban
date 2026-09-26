// 校验 docker-compose.yml / Caddyfile / bootstrap.sh 的结构与关键约定
// 本机没有 docker 时，至少把能静态查的问题查出来
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 仓库根目录：从本脚本位置推导。
// 不能写死绝对路径 —— CI 上仓库克隆到 /home/runner/work/...，写死的路径必然 ENOENT。
const ROOT = resolve(import.meta.dir, "..");
let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

console.log("=== docker-compose.yml ===");
const compose = readFileSync(`${ROOT}/docker-compose.yml`, "utf8");

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
check("只保留 kanban 一个服务", serviceNames.length === 1 && serviceNames[0] === "kanban", serviceNames.join(", "));
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
check("镜像名可覆盖", /KANBAN_IMAGE:-agent-kanban:local/.test(compose));
check("注释说明了为何不带代理", /既有基础设施/.test(compose));

console.log("\n=== deploy/ 与 bootstrap ===");
const { existsSync } = await import("node:fs");
check("无 deploy/ 目录（已去掉 bootstrap）", !existsSync(`${ROOT}/deploy`));
check("compose 无 bootstrap 服务", !/\n  bootstrap:/.test(compose));
check(
  "Dockerfile 说明不编译二进制",
  /不编译二进制/.test(readFileSync(`${ROOT}/Dockerfile`, "utf8")),
);

console.log("\n=== .env.example ===");
const env = readFileSync(`${ROOT}/.env.example`, "utf8");
check("含 KANBAN_BIND", /KANBAN_BIND=/.test(env));
check("含 KANBAN_PORT", /KANBAN_PORT=/.test(env));
check("含 KANBAN_IMAGE 说明", /KANBAN_IMAGE/.test(env));
check("含 KANBAN_ADMIN_TOKEN", /^KANBAN_ADMIN_TOKEN=/m.test(env));
check("说明了 token 格式要求", /32 位十六进制/.test(env));
check("无 KANBAN_DOMAIN（已移除 TLS 方案）", !/^KANBAN_DOMAIN=/m.test(env));
check("说明了 TLS 需自备", /TLS/.test(env));
check("无行尾空格", !/ +$/m.test(env));

console.log("\n=== Dockerfile ===");
const df = readFileSync(`${ROOT}/Dockerfile`, "utf8");
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
const gen = readFileSync(`${ROOT}/scripts/gen-assets.ts`, "utf8");
check("gen-assets 存在且扫描 dist", /readdirSync/.test(gen) && /web\/dist/.test(gen));
check("生成 manifest 到 src/server", /assets\.generated\.ts/.test(gen));
const manifest = readFileSync(`${ROOT}/src/server/assets.generated.ts`, "utf8");
check("manifest 已入库（含占位）", /EMBEDDED_ASSETS/.test(manifest));
check("package.json 有 gen:assets", /"gen:assets"/.test(readFileSync(`${ROOT}/package.json`, "utf8")));

console.log(`\n${fails === 0 ? "✓ 全部检查通过" : `✗ ${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
