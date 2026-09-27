/**
 * 崩溃恢复测试（M2 / ADR-7）。
 *
 * 覆盖四条主链路：
 *   1. 主动交接：写 → 查 → 消费（标记已读）
 *   2. 崩溃自动合成：失联回收时自动生成 crash 交接，内容包含进度与未完成项
 *   3. 恢复上下文：context 组装现场（失联告警 / 交接 / 我的任务 / 建议）
 *   4. 接管与一致性：resume 保留进度、doctor 能发现并修复问题
 *
 * 时间全部走 TestDb 的可注入逻辑时钟，不使用真实 sleep。
 */

import { describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { createSession, reapZombies, touchSession } from "../src/core/sessions.ts";
import { claimTask, createTask, getTask, updateProgress, type Actor } from "../src/core/tasks.ts";
import { writeHandoff, pendingHandoffs, taskHandoffs, consumeHandoff } from "../src/core/handoff.ts";
import { buildContext, renderNextAction, runResume } from "../src/core/context.ts";
import { runDoctor } from "../src/core/doctor.ts";
import { withTx } from "../src/core/tx.ts";
import { DEFAULT_GRACE_MS, DEFAULT_TTL_MS } from "../src/core/db.ts";

/** 建一个活跃会话（崩溃模拟从这一步开始） */
function startAgent(t: TestDb, agentName: string): string {
  return withTx(
    t.db,
    (tx) => createSession(tx, { agentName, harness: "pi", cwd: t.path }),
    { now: () => t.now(), sessionId: null, projectKey: t.scope.projectKey },
  ).id;
}

function actor(t: TestDb, sessionId: string, ttlMs = DEFAULT_TTL_MS): Actor {
  return { sessionId, now: t.now(), ttlMs } as Actor;
}

/** 会话/租约的固定事务参数 */
function opts(t: TestDb, sessionId: string) {
  return { now: () => t.now(), sessionId, projectKey: t.scope.projectKey };
}

const TITLE = "实现崩溃恢复";

/** 让时间快进到"租约+宽限"都已过期（足以触发回收） */
function expireLease(t: TestDb): void {
  t.advance(DEFAULT_TTL_MS + DEFAULT_GRACE_MS + 1000);
}

// =============================================================================
describe("handoff —— 主动交接", () => {
  test("写入后能被查到，内容完整保留", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), opts(t, sid)).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sid)), opts(t, sid));

      const handoff = withTx(
        t.db,
        (tx) =>
          writeHandoff(tx, {
            taskId: tid,
            sessionId: sid,
            summary: "完成 WAL 事务层",
            nextStep: "实现崩溃自动合成",
            blockers: ["WAL 文件要不要纳入 git"],
            openQuestions: ["租约时长是否按任务类型区分？"],
          }),
        opts(t, sid),
      );

      const stored = taskHandoffs(t.scope, tid)[0]!;
      expect(stored.id).toBe(handoff.id);
      expect(stored.kind).toBe("voluntary");
      expect(stored.summary).toBe("完成 WAL 事务层");
      expect(stored.nextStep).toBe("实现崩溃自动合成");
      expect(stored.blockers).toEqual(["WAL 文件要不要纳入 git"]);
      expect(stored.openQuestions).toEqual(["租约时长是否按任务类型区分？"]);
      // 未消费
      expect(stored.consumedBy).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("消费后不再出现在待接手里，但历史保留", () => {
    const t = createTestDb();
    try {
      const sidA = startAgent(t, "agent-a");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), opts(t, sidA)).id;
      const sidB = startAgent(t, "agent-b");
      const hid = withTx(
        t.db,
        (tx) => writeHandoff(tx, { taskId: tid, sessionId: sidA, summary: "做完了" }),
        opts(t, sidA),
      ).id;

      expect(pendingHandoffs(t.scope, { sessionId: sidB })).toHaveLength(1);

      withTx(t.db, (tx) => consumeHandoff(tx, hid, sidB), opts(t, sidB));

      expect(pendingHandoffs(t.scope, { sessionId: sidB })).toHaveLength(0);
      expect(taskHandoffs(t.scope, tid)[0]!.consumedBy).toBe(sidB);
    } finally {
      t.cleanup();
    }
  });

  test("自己写的交接不推给自己（避免自己提醒自己）", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), opts(t, sid)).id;
      withTx(
        t.db,
        (tx) => writeHandoff(tx, { taskId: tid, sessionId: sid, summary: "阶段成果" }),
        opts(t, sid),
      );
      expect(pendingHandoffs(t.scope, { sessionId: sid })).toHaveLength(0);
      expect(pendingHandoffs(t.scope, { sessionId: "s-other" })).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  test("交接按 project 隔离", () => {
    const t = createTestDb({ projectKey: "p1" });
    try {
      const sid = startAgent(t, "agent-a");
      const tid = withTx(
        t.db,
        (tx) => createTask(tx, { title: TITLE }),
        { now: () => t.now(), sessionId: sid, projectKey: "p1" },
      ).id;
      withTx(
        t.db,
        (tx) => writeHandoff(tx, { taskId: tid, sessionId: sid, summary: "p1 的交接" }),
        { now: () => t.now(), sessionId: sid, projectKey: "p1" },
      );

      expect(pendingHandoffs(t.scopeOf("p1"), { sessionId: "s-other" })).toHaveLength(1);
      // 另一个 project 看不到
      expect(pendingHandoffs(t.scopeOf("p2"), { sessionId: "s-other" })).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});

// =============================================================================
describe("崩溃自动合成 handoff", () => {
  test("失联回收时自动生成 crash 交接，含进度与未完成项", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(
        t.db,
        (tx) => createTask(tx, { title: TITLE, checklist: ["第一步", "第二步", "第三步"] }),
        o,
      ).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sid)), o);
      withTx(
        t.db,
        (tx) =>
          updateProgress(tx, tid, actor(t, sid), {
            pct: 40,
            check: ["第一步"],
            note: "第一步做完了",
          }),
        o,
      );

      // 推进时间直到超过宽限期，触发回收
      expireLease(t);
      reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: t.now() });

      // 任务被回收，进度保留
      const task = getTask(t.scope, tid)!;
      expect(task.status).toBe("todo");
      expect(task.progress).toBe(40);
      expect(task.assigneeSessionId).toBeNull();

      // 自动合成的交接写清了"做到哪"
      const crash = taskHandoffs(t.scope, tid).find((h) => h.kind === "crash");
      expect(crash).toBeDefined();
      expect(crash!.sessionId).toBe(sid);
      expect(crash!.summary).toContain("40%");
      expect(crash!.summary).toContain("went silent");
      // 「最后动作」里不能出现心跳与回收本身（对接手方是废话）。
      // 断言必须**只针对最后动作那一段**：正文里的 "without a heartbeat" 是
      // 对「失联」的正常描述，笼统地断言整段不含 "heartbeat" 会在文案英文化后误伤。
      const lastActions = crash!.summary.split("Last actions:")[1] ?? "";
      expect(lastActions).not.toContain("heartbeat");
      expect(lastActions).not.toContain("reclaimed");
      // 下一步要指出从哪继续 + 剩余项
      expect(crash!.nextStep).toContain("40%");
      expect(crash!.nextStep).toContain("第二步");
      expect(crash!.nextStep).toContain("第三步");
      // 阻塞原因也带过来
      expect(crash!.blockers.join(" ")).toContain("went silent");
    } finally {
      t.cleanup();
    }
  });

  test("重复回收不会刷出多条 crash 交接", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), o).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sid)), o);

      expireLease(t);
      reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: t.now() });
      // 第二次回收：已经没人持有，不应再合成
      t.advance(60_000);
      reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: t.now() });

      expect(taskHandoffs(t.scope, tid).filter((h) => h.kind === "crash")).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });
});

// =============================================================================
describe("context —— 恢复现场", () => {
  test("组装看板 + 交接 + 我的任务 + 建议动作", () => {
    const t = createTestDb();
    try {
      const sidA = startAgent(t, "agent-a");
      const sidB = startAgent(t, "agent-b");

      // A 留了一张 60% 的卡并交接
      const t1 = withTx(
        t.db,
        (tx) => createTask(tx, { title: "A 的活", checklist: ["x", "y"] }),
        opts(t, sidA),
      ).id;
      withTx(t.db, (tx) => claimTask(tx, t1, actor(t, sidA)), opts(t, sidA));
      withTx(
        t.db,
        (tx) => updateProgress(tx, t1, actor(t, sidA), { pct: 60, check: ["x"] }),
        opts(t, sidA),
      );
      withTx(
        t.db,
        (tx) => writeHandoff(tx, { taskId: t1, sessionId: sidA, summary: "A 的总结" }),
        opts(t, sidA),
      );

      // B 有一张自己正在做的
      const t3 = withTx(t.db, (tx) => createTask(tx, { title: "B 的活" }), opts(t, sidB)).id;
      withTx(t.db, (tx) => claimTask(tx, t3, actor(t, sidB)), opts(t, sidB));

      const ctx = buildContext({
        scope: t.scope,
        now: t.now(),
        graceMs: DEFAULT_GRACE_MS,
        sessionId: sidB,
      });

      // 交接可见，并带上"还剩什么"
      expect(ctx.pending_handoffs).toHaveLength(1);
      expect(ctx.pending_handoffs[0]!.task_id).toBe(t1);
      expect(ctx.pending_handoffs[0]!.summary).toBe("A 的总结");
      expect(ctx.pending_handoffs[0]!.task_progress).toBe(60);

      // 我正在做的 = B 的卡；全部进行中含 A 的
      expect(ctx.my_tasks.map((m) => m.id)).toEqual([t3]);
      expect(ctx.in_progress.map((i) => i.id).sort()).toEqual([t1, t3].sort());

      // 建议里必须有可执行动作
      expect(ctx.next_actions.length).toBeGreaterThan(0);
      expect(ctx.next_actions.some((a) => a.includes(t1))).toBe(true);

      // 每条建议都有结构化形态，且与中文串一一对应（前端靠它本地化，见 web/src/lib/next-actions.ts）
      expect(ctx.next_action_items).toHaveLength(ctx.next_actions.length);
      expect(ctx.next_action_items.map(renderNextAction)).toEqual(ctx.next_actions);
      expect(new Set(ctx.next_action_items.map((i) => i.code))).toContain("read_handoff");
    } finally {
      t.cleanup();
    }
  });

  test("consume=false 只读，不标记已读", () => {
    const t = createTestDb();
    try {
      const sidA = startAgent(t, "agent-a");
      const sidB = startAgent(t, "agent-b");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), opts(t, sidA)).id;
      withTx(
        t.db,
        (tx) => writeHandoff(tx, { taskId: tid, sessionId: sidA, summary: "看看我" }),
        opts(t, sidA),
      );

      const preview = buildContext({
        scope: t.scope,
        now: t.now(),
        graceMs: DEFAULT_GRACE_MS,
        sessionId: sidB,
      });
      expect(preview.pending_handoffs).toHaveLength(1);
      expect(taskHandoffs(t.scope, tid)[0]!.consumedBy).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("失联会话的卡标为 stale_holder 并给出接管建议", () => {
    const t = createTestDb();
    try {
      const sidA = startAgent(t, "agent-a");
      const sidB = startAgent(t, "agent-b");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), opts(t, sidA)).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sidA)), opts(t, sidA));

      // 只把心跳推远（不回收），模拟"租约还在但人没了"
      t.db
        .query<{ last_seen_at: number }, [number, string]>("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
        .run(t.now() - (DEFAULT_TTL_MS + DEFAULT_GRACE_MS + 1000), sidA);

      const ctx = buildContext({
        scope: t.scope,
        now: t.now(),
        graceMs: DEFAULT_GRACE_MS,
        sessionId: sidB,
      });
      expect(ctx.in_progress.find((i) => i.id === tid)?.stale_holder).toBe(true);
      expect(ctx.next_actions.some((a) => a.includes("resume"))).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});

// =============================================================================
describe("resume —— 接管并注入现场", () => {
  test("接管后进度保留、交接注入、剩余 checklist 可见", () => {
    const t = createTestDb();
    try {
      const sidA = startAgent(t, "agent-a");
      const o = opts(t, sidA);
      const tid = withTx(
        t.db,
        (tx) => createTask(tx, { title: TITLE, checklist: ["步骤1", "步骤2", "步骤3"] }),
        o,
      ).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sidA)), o);
      withTx(
        t.db,
        (tx) => updateProgress(tx, tid, actor(t, sidA), { pct: 50, check: ["步骤1"] }),
        o,
      );
      withTx(
        t.db,
        (tx) =>
          writeHandoff(tx, {
            taskId: tid,
            sessionId: sidA,
            summary: "步骤1 完成了",
            nextStep: "接着做步骤2",
            blockers: ["依赖还没装"],
            openQuestions: ["步骤2 要不要先问人？"],
          }),
        o,
      );

      const sidB = startAgent(t, "agent-b");
      const result = runResume(t.db, actor(t, sidB), t.scope.projectKey, tid);

      // 进度与 checklist 保留
      expect(result.task.progress).toBe(50);
      expect(result.task.remaining_checklist).toEqual(["步骤2", "步骤3"]);
      // 交接内容注入
      expect(result.handoff?.summary).toBe("步骤1 完成了");
      expect(result.handoff?.next_step).toBe("接着做步骤2");
      expect(result.handoff?.blockers).toEqual(["依赖还没装"]);
      expect(result.handoff?.open_questions).toEqual(["步骤2 要不要先问人？"]);
      // 持有者换成 B
      expect(getTask(t.scope, tid)!.assigneeSessionId).toBe(sidB);
      expect(result.previous_holder?.session_id).toBe(sidA);
      // 交接被标记为已消费
      expect(taskHandoffs(t.scope, tid)[0]!.consumedBy).toBe(sidB);
    } finally {
      t.cleanup();
    }
  });

  test("租约仍有效时接管被拒，force 才能抢", () => {
    const t = createTestDb();
    try {
      const sidA = startAgent(t, "agent-a");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), opts(t, sidA)).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sidA)), opts(t, sidA));

      const sidB = startAgent(t, "agent-b");
      // A 刚 claim，租约有效 → 拒绝
      expect(() => runResume(t.db, actor(t, sidB), t.scope.projectKey, tid)).toThrow();
      expect(getTask(t.scope, tid)!.assigneeSessionId).toBe(sidA);

      // force 允许抢占
      const forced = runResume(t.db, actor(t, sidB), t.scope.projectKey, tid, { force: true });
      expect(getTask(t.scope, tid)!.assigneeSessionId).toBe(sidB);
      // 抢占必须留痕（审计要求）
      expect(forced.reclaimed || forced.previous_holder?.session_id === sidA).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("已完成的卡不能被接管", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), opts(t, sid)).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sid)), opts(t, sid));
      t.db.query<{ id: string }, [string]>("UPDATE tasks SET status = 'done' WHERE id = ?").run(tid);

      const sidB = startAgent(t, "agent-b");
      expect(() =>
        runResume(t.db, actor(t, sidB), t.scope.projectKey, tid, { force: true }),
      ).toThrow();
    } finally {
      t.cleanup();
    }
  });

  test("崩溃后的接管能识别出发生过回收，并保留进度", () => {
    const t = createTestDb();
    try {
      const sidA = startAgent(t, "agent-a");
      const o = opts(t, sidA);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE, checklist: ["a", "b"] }), o).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sidA)), o);
      withTx(
        t.db,
        (tx) => updateProgress(tx, tid, actor(t, sidA), { pct: 70, check: ["a"] }),
        o,
      );

      // A 崩溃 → 回收
      expireLease(t);
      reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: t.now() });

      const sidB = startAgent(t, "agent-b");
      const result = runResume(t.db, actor(t, sidB), t.scope.projectKey, tid);
      // 识别出"原持有者崩过"
      expect(result.reclaimed).toBe(true);
      // 进度 70% 完整保留
      expect(result.task.progress).toBe(70);
      // 主动交接优先，没有则给自动合成的
      expect(result.handoff?.kind).toBe("crash");
      expect(result.handoff?.summary).toContain("70%");
      expect(result.next_actions.length).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });
});

// =============================================================================
describe("交接即让位 —— 租约未过期时的接管", () => {
  /**
   * 回归：曾经出现“JS 判定放行、UPDATE 拒绝”的不一致。
   *
   * 表现是前置判定说有资格接管，紧接着就抛 CONFLICT：
   * 因为 hasHandoverConsumedBy 放行了，而条件 UPDATE 的 WHERE 里
   * 没有对应谓词，changes=0 后又抛冲突。两个地方必须同步。
   */
  test("交接已被本会话消费 → 租约未过期也能接管（MCP bootstrap→resume 流程）", () => {
    const t = createTestDb();
    let A!: ReturnType<typeof createSession>;
    let B!: ReturnType<typeof createSession>;
    let task!: ReturnType<typeof createTask>;
    t.tx((tx) => {
      A = createSession(tx, { agentName: "a" });
      B = createSession(tx, { agentName: "b" });
      task = createTask(tx, { title: "让位" });
    });
    t.tx((tx) => claimTask(tx, task.id, { sessionId: A.id, now: t.now() }, { ttlMs: 15 * 60_000 }));
    t.tx((tx) => writeHandoff(tx, { taskId: task.id, sessionId: A.id, summary: "做了一半" }));

    // B 读走交接（bootstrap 的默认行为）
    t.tx((tx) => {
      for (const h of pendingHandoffs(t.scope, {})) consumeHandoff(tx, h.id, B.id);
    });
    expect(pendingHandoffs(t.scope, {})).toHaveLength(0);

    // 租约还剩 14 分钟，但 B 已读到交接 → 应当可以接管
    let claimed!: ReturnType<typeof claimTask>;
    t.tx((tx) => {
      claimed = claimTask(tx, task.id, { sessionId: B.id, now: t.now() + 1000 }, {});
    });
    expect(claimed.assigneeSessionId).toBe(B.id);
    t.cleanup();
  });

  test("交接未消费 → 直接接管（不需先 bootstrap）", () => {
    const t = createTestDb();
    let A!: ReturnType<typeof createSession>;
    let B!: ReturnType<typeof createSession>;
    let task!: ReturnType<typeof createTask>;
    t.tx((tx) => {
      A = createSession(tx, { agentName: "a" });
      B = createSession(tx, { agentName: "b" });
      task = createTask(tx, { title: "让位2" });
    });
    t.tx((tx) => claimTask(tx, task.id, { sessionId: A.id, now: t.now() }, { ttlMs: 15 * 60_000 }));
    t.tx((tx) => writeHandoff(tx, { taskId: task.id, sessionId: A.id, summary: "做了一半" }));

    let claimed!: ReturnType<typeof claimTask>;
    t.tx((tx) => {
      claimed = claimTask(tx, task.id, { sessionId: B.id, now: t.now() + 1000 }, {});
    });
    expect(claimed.assigneeSessionId).toBe(B.id);
    t.cleanup();
  });

  test("租约有效且无人交接 → 仍然 CONFLICT（不能被上面两条放宽成水）", () => {
    const t = createTestDb();
    let A!: ReturnType<typeof createSession>;
    let B!: ReturnType<typeof createSession>;
    let task!: ReturnType<typeof createTask>;
    t.tx((tx) => {
      A = createSession(tx, { agentName: "a" });
      B = createSession(tx, { agentName: "b" });
      task = createTask(tx, { title: "不让位" });
    });
    t.tx((tx) => claimTask(tx, task.id, { sessionId: A.id, now: t.now() }, { ttlMs: 15 * 60_000 }));

    expect(() =>
      t.tx((tx) => {
        claimTask(tx, task.id, { sessionId: B.id, now: t.now() + 1000 }, {});
      }),
    ).toThrow();
    t.cleanup();
  });
});

// =============================================================================
describe("doctor —— 一致性自检", () => {
  test("健康库无告警", () => {
    const t = createTestDb();
    try {
      const report = runDoctor(t.db, { projectKey: t.scope.projectKey, now: t.now(), deep: true });
      expect(report.ok).toBe(true);
      expect(report.issues).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test("发现失联租约，fix 后清干净", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: TITLE }), opts(t, sid)).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sid)), opts(t, sid));
      expireLease(t);

      // 修之前：能发现
      const before = runDoctor(t.db, { projectKey: t.scope.projectKey, now: t.now(), deep: false });
      const stale = before.issues.find((i) => i.code === "stale_lease");
      expect(stale).toBeDefined();
      expect(stale!.subjects).toContain(tid);

      // 修之后：干净
      const after = runDoctor(t.db, { projectKey: t.scope.projectKey, now: t.now(), deep: false, fix: true });
      expect(after.issues.find((i) => i.code === "stale_lease")?.fixed).toBe(true);
      expect(after.ok).toBe(true);
      expect(getTask(t.scope, tid)!.assigneeSessionId).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("发现 progress 与 checklist 不一致", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const tid = withTx(
        t.db,
        (tx) => createTask(tx, { title: TITLE, checklist: ["a", "b"] }),
        opts(t, sid),
      ).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sid)), opts(t, sid));
      // 先把一个检查项勾上（比例 1/2 = 50%），再人为把 progress 改成 0 → 不一致
      withTx(
        t.db,
        (tx) => updateProgress(tx, tid, actor(t, sid), { pct: 50, check: ["a"] }),
        opts(t, sid),
      );
      t.db.query<{ id: string }, [number, string]>("UPDATE tasks SET progress = ? WHERE id = ?").run(0, tid);

      const report = runDoctor(t.db, { projectKey: t.scope.projectKey, now: t.now(), deep: false });
      const mismatch = report.issues.find((i) => i.code === "progress_mismatch");
      expect(mismatch).toBeDefined();
      expect(mismatch!.subjects).toContain(tid);
    } finally {
      t.cleanup();
    }
  });

  test("心跳会刷新 last_seen_at（防误判失联）", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const before = t.db
        .query<{ last_seen_at: number }, [string]>("SELECT last_seen_at FROM sessions WHERE id = ?")
        .get(sid)!.last_seen_at;
      t.advance(60_000);
      touchSession(t.db, sid, t.now());
      const after = t.db
        .query<{ last_seen_at: number }, [string]>("SELECT last_seen_at FROM sessions WHERE id = ?")
        .get(sid)!.last_seen_at;
      expect(after).toBeGreaterThan(before);
      expect(after).toBe(t.now());
    } finally {
      t.cleanup();
    }
  });
});
