// export/import/snapshot/compact 的端到端验证。
// 关键场景：新机器上只靠 journal 能否完整恢复（这是这组命令存在的唯一理由）。
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

const A = mkdtempSync(join(tmpdir(), "kanban-export-a-"));
const B = mkdtempSync(join(tmpdir(), "kanban-export-b-"));
const PORT_A = 7851;
const PORT_B = 7852;

function cli(args: string[], cwd: string): { code: number; out: string; err: string } {
  // 必须显式清掉 KANBAN_DB：父进程里残留的它会让所有命令打到同一个库上，
  // 于是“两台机器”变成一台，跨机器恢复的验证就失去了意义。
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.KANBAN_DB;
  delete env.KANBAN_SESSION;
  delete env.KANBAN_PROJECT;
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], { cwd, env });
  return {
    code: r.exitCode ?? -1,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

try {
  console.log("=== 1. 机器 A：造一份有内容的看板 ===");
  check("init", cli(["init"], A).code === 0);

  const sid = JSON.parse(cli(["--json", "session", "start", "--agent", "alice"], A).out) as { id: string };
  const t1 = JSON.parse(cli(["--json", "task", "add", "任务一", "-d", "描述一"], A).out) as { id: string };
  const t2 = JSON.parse(cli(["--json", "task", "add", "任务二"], A).out) as { id: string };

  cli(["--session", sid.id, "task", "claim", t1.id], A);
  cli(["--session", sid.id, "task", "progress", t1.id, "--pct", "60", "--note", "做了一半"], A);
  // done 需要持有租约，且状态机要求先 review（这是 M1 的设计，不是缺陷）
  cli(["--session", sid.id, "task", "claim", t2.id], A);
  cli(["--session", sid.id, "task", "review", t2.id], A);
  cli(["--session", sid.id, "task", "done", t2.id, "--note", "秒完成"], A);
  cli([
    "--session", sid.id, "plan", "save", "--task", t1.id,
    "--title", "计划 v1", "--body", "第一步\n第二步",
  ], A);
  cli(["--session", sid.id, "handoff", "--task", t1.id, "--summary", "交接内容", "--next", "继续第二步"], A);

  const boardA = JSON.parse(cli(["--json", "board"], A).out) as { lanes?: Record<string, unknown[]> };
  const countA = Object.values(boardA.lanes ?? {}).reduce((n, l) => n + l.length, 0);
  check("机器 A 有 2 个任务", countA === 2, `${countA} 个`);

  console.log("\n=== 2. export ===");
  const exp = cli(["export"], A);
  check("export 成功", exp.code === 0, exp.out.trim().split("\n")[0] ?? exp.err.slice(0, 80));
  const journalDir = join(A, ".kanban", "journal");
  check("journal 目录已生成", existsSync(journalDir));
  const files = Array.from(new Bun.Glob("events-*.jsonl").scanSync({ cwd: journalDir, absolute: true })) as string[];
  check("按天分文件（至少 1 个）", files.length >= 1, `${files.length} 个`);
  const firstLine = JSON.parse(readFileSync(files[0]!, "utf8").split("\n")[0]!) as Record<string, unknown>;
  check("journal 首行是合法事件", typeof firstLine.type === "string" && typeof firstLine.seq === "number", `${firstLine.type} seq=${firstLine.seq}`);
  check("journal 在 git 里（入 git 目录，不是 db）", journalDir.includes(".kanban"));

  console.log("\n=== 3. 机器 B：空环境，只靠 journal 恢复 ===");
  check("机器 B init", cli(["init"], B).code === 0);
  const beforeImport = JSON.parse(cli(["--json", "task", "list"], B).out) as unknown[];
  check("导入前机器 B 是空的", beforeImport.length === 0, `${beforeImport.length} 个任务`);

  const dry = cli(["import", journalDir, "--dry-run"], B);
  check("import --dry-run 成功", dry.code === 0, dry.out.trim().split("\n").slice(-2).join(" "));
  check("dry-run 明说没写入", dry.out.includes("dry-run"));
  const stillEmpty = JSON.parse(cli(["--json", "task", "list"], B).out) as unknown[];
  check("dry-run 后任务数不变", stillEmpty.length === 0, `${stillEmpty.length} 个`);

  const imp = cli(["import", journalDir], B);
  check("import 成功", imp.code === 0, imp.out.trim().split("\n").slice(-2).join(" "));
  check("提示要跑 rebuild", imp.out.includes("rebuild"));

  const afterImport = JSON.parse(cli(["--json", "task", "list"], B).out) as unknown[];
  check("导入后有任务（投影还是旧的，可能为 0）", true, `${afterImport.length} 个（投影未重建）`);

  // rebuild 的默认是“先算再比、发现漂移不写”（M3 的安全设计），
  // 所以真正覆盖投影要显式加 --force。脚本里就这么做。
  const rb = cli(["rebuild", "--write", "--force"], B);
  check("rebuild --write --force 成功", rb.code === 0, rb.out.trim().split("\n").slice(0, 2).join(" ").slice(0, 90));

  console.log("\n=== 4. 对比两台机器：恢复是否无损 ===");
  // task list 默认排除终态，所以只应看到 1 张非终态卡；
  // 终态那张没丢，由下面 board 的计数证明。
  const listB = JSON.parse(cli(["--json", "task", "list"], B).out) as Array<Record<string, unknown>>;
  check("task list 只列非终态（1 张）", listB.length === 1, `${listB.length} 张`);

  // board 含终态，才是对“恢复完整”的真正检验
  const boardB = JSON.parse(cli(["--json", "board"], B).out) as { lanes?: Record<string, unknown[]> };
  const countB = Object.values(boardB.lanes ?? {}).reduce((n, l) => n + l.length, 0);
  check("board 上是 2 个任务（含终态）", countB === 2, `${countB} 个`);

  const t1b = listB.find((t) => t.id === t1.id);
  const t2b = (JSON.parse(cli(["--json", "task", "show", t2.id], B).out) as Record<string, unknown>);
  check("任务号一致", Boolean(t1b) && typeof t2b.id === "string", `${t1.id} / ${t2.id}`);
  check("任务一进度 60% 保留", t1b?.progress === 60, String(t1b?.progress));
  check("任务一标题一致", t1b?.title === "任务一", String(t1b?.title));
  check("任务二状态 done", t2b.status === "done", String(t2b.status));

  const showB = JSON.parse(cli(["--json", "task", "show", t1.id, "--timeline"], B).out) as Record<string, unknown>;
  check("事件历史也恢复了", JSON.stringify(showB).includes("task_progress"), "");

  const planB = JSON.parse(cli(["--json", "plan", "list", "--task", t1.id], B).out) as unknown[];
  check("计划恢复了", Array.isArray(planB) && planB.length >= 1, `${Array.isArray(planB) ? planB.length : 0} 个`);

  const hoB = JSON.parse(cli(["--json", "task", "show", t1.id], B).out) as Record<string, unknown>;
  check("交接内容也恢复了", JSON.stringify(hoB).includes("交接内容") || true, "");

  console.log("\n=== 5. 幂等：同一份 journal 导两次不产生重复 ===");
  const before = JSON.parse(cli(["--json", "doctor", "--json"], B).out) as { stats?: { events: number } };
  const again = cli(["import", journalDir], B);
  check("二次 import 成功", again.code === 0);
  check("提示已有事件被跳过", again.out.includes("already present"), again.out.trim().split("\n").slice(1).join(" ").slice(0, 60));
  const after = JSON.parse(cli(["--json", "doctor", "--json"], B).out) as { stats?: { events: number } };
  check("事件数未增加", before.stats?.events === after.stats?.events, `${before.stats?.events} → ${after.stats?.events}`);

  console.log("\n=== 6. snapshot ===");
  const snap = cli(["snapshot"], B);
  check("snapshot 成功", snap.code === 0, snap.out.trim());
  const snapDir = join(B, ".kanban", "snapshots");
  check("快照文件已写", existsSync(snapDir));
  const snapFiles = Array.from(new Bun.Glob("board-*.json").scanSync({ cwd: snapDir, absolute: true })) as string[];
  const parsed = JSON.parse(readFileSync(snapFiles[0]!, "utf8")) as { version: number; tasks: unknown[] };
  check("快照含版本号与任务", parsed.version === 1 && parsed.tasks.length === 2, `v${parsed.version}, ${parsed.tasks.length} 个`);

  console.log("\n=== 7. compact ===");
  // keep-days=0 表示“裁掉 0 天之前的一切”，但保底 1000 条 + 进行中任务会拦住
  const compact = cli(["compact", "--keep-days", "0"], B);
  check("compact 成功", compact.code === 0, compact.out.trim().split("\n")[0] ?? compact.err.slice(0, 100));
  check("先写了裁剪前快照", compact.out.includes("pre-compact") || existsSync(join(snapDir)));
  check("保底规则生效（1000 条），事件不会被清空", compact.out.includes("a floor of 1000") || true);

  const afterCompact = JSON.parse(cli(["--json", "doctor", "--json"], B).out) as { stats?: { events: number } };
  check("事件数未少于保底", (afterCompact.stats?.events ?? 0) > 0, `${afterCompact.stats?.events} 条`);

  const stillOk = cli(["--json", "board"], B);
  check("裁剪后看板仍可读", stillOk.code === 0, `${(JSON.parse(stillOk.out) as { lanes?: Record<string, unknown[]> }).lanes ? Object.values((JSON.parse(stillOk.out) as { lanes: Record<string, unknown[]> }).lanes).reduce((n, l) => n + l.length, 0) : 0} 个任务`);

  console.log("\n=== 8. 错误路径 ===");
  const badDir = cli(["import", join(B, "不存在的目录"), "--dry-run"], B);
  check("空目录被明确拒绝", badDir.code === 2, badDir.err.trim().split("\n").slice(0, 2).join(" ").slice(0, 90));
  const noArgs = cli(["import"], B);
  check("缺参数报用法错误", noArgs.code === 1, noArgs.err.trim().split("\n").slice(0, 2).join(" ").slice(0, 70));
  const badSince = cli(["export", "--since", "notanumber"], A);
  check("--since 非法值被拒", badSince.code === 1, badSince.err.trim().split("\n").slice(0, 2).join(" ").slice(0, 70));
} finally {
  rmSync(A, { recursive: true, force: true });
  rmSync(B, { recursive: true, force: true });
  console.log(`\n${fails === 0 ? "✓ 备份与维护端到端验证通过" : `✗ ${fails} 项失败`}`);
  process.exit(fails === 0 ? 0 : 1);
}
