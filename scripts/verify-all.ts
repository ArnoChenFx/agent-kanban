// 一次跑完所有门禁，输出汇总。
// 用途：本地提交前与“还有哪里没绿”的快速答案；CI 里仍然逐步跑（失败要能定位）。
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

interface Gate {
  name: string;
  cmd: string[];
  /** 只关心退出码（长输出会淹没汇总） */
  quiet?: boolean;
}

const GATES: Gate[] = [
  { name: "类型检查", cmd: ["bunx", "tsc", "--noEmit"] },
  { name: "单元测试", cmd: ["bun", "test"] },
  { name: "依赖声明", cmd: ["bun", "run", "verify:deps"] },
  { name: "Workflow 校验", cmd: ["bun", "run", "verify:workflows"] },
  { name: "文档事实", cmd: ["bun", "run", "verify:docs"] },
  { name: "部署配置", cmd: ["bun", "run", "verify:deploy"] },
  { name: "崩溃恢复", cmd: ["bun", "run", "scripts/verify-recovery.ts"], quiet: true },
  { name: "事件重放", cmd: ["bun", "run", "scripts/verify-rebuild.ts"], quiet: true },
  { name: "鉴权与 project 隔离", cmd: ["bun", "run", "scripts/verify-auth.ts"], quiet: true },
  { name: "远程双模式", cmd: ["bun", "run", "scripts/verify-remote.ts"], quiet: true },
  { name: "Web 看板", cmd: ["bun", "run", "verify:web"] },
  { name: "MCP 端到端", cmd: ["bun", "run", "verify:mcp"] },
  { name: "备份与维护", cmd: ["bun", "run", "verify:backup"] },
];

console.log("agent-kanban · 全量门禁\n");
const failed: string[] = [];
const started = Date.now();

for (const gate of GATES) {
  const t0 = Date.now();
  const r = spawnSync(gate.cmd[0]!, gate.cmd.slice(1), {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
  });
  const ok = r.status === 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${ok ? "✓" : "✗"} ${gate.name.padEnd(22)} ${secs.padStart(5)}s`);
  if (!ok) {
    failed.push(gate.name);
    if (!gate.quiet) {
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      for (const line of out.split("\n").filter((l) => l.trim()).slice(-8)) {
        console.log(`    ${line.slice(0, 110)}`);
      }
    }
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${failed.length === 0 ? `✓ ${GATES.length} 道门禁全绿（${total}s）` : `✗ ${failed.length} 道失败：${failed.join("、")}`}`);
process.exit(failed.length === 0 ? 0 : 1);
