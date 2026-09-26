/**
 * 状态机测试：转移表驱动的合法性与守卫。
 *
 * 为什么要表驱动：转移表在 core/tasks.ts 里是数据（TRANSITIONS），
 * 测试也从同一份数据生成期望，避免"测试和实现各写一份规则"导致漏测。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KanbanError } from "../src/core/errors.ts";
import {
  addDependency,
  claimTask,
  createTask,
  legalTransitions,
  listTasks,
  releaseTask,
  requireTask,
  transition,
  updateProgress,
} from "../src/core/tasks.ts";
import { createSession } from "../src/core/sessions.ts";
import type { TaskStatus } from "../src/core/types.ts";
import { actorAt, createTestDb, type TestDb } from "./helpers/db.ts";

let t: TestDb;
let sessionA: string;

beforeEach(() => {
  t = createTestDb();
  t.tx((tx) => {
    sessionA = createSession(tx, { agentName: "agent-a", id: "s-aaaaaa" }).id;
  });
});

afterEach(() => {
  t.cleanup();
});

/** 建一张指定状态的任务（直接走状态机，绕过 add） */
function makeTask(title = "测试任务", priority = 2): string {
  let id = "";
  t.tx((tx) => {
    id = createTask(tx, { title, priority }).id;
  });
  return id;
}

/** 把任务推到指定状态 */
function driveTo(id: string, target: TaskStatus, sessionId: string | null = null): void {
  t.tx((tx) => {
    const actor = actorAt(t.now, sessionId);
    if (target === "doing") {
      claimTask(tx, id, actor);
      return;
    }
    if (target === "todo" && requireTask({ db: tx.db, projectKey: tx.projectKey }, id).status === "blocked") {
      transition(tx, id, "todo", actor);
      return;
    }
    if (target === "done" || target === "cancelled") {
      // 注意：todo → doing 只能走 claim（它需要原子抢占），不走 transition 表
      claimTask(tx, id, actor);
      transition(tx, id, target, actor, {
        force: true,
        reason: target === "cancelled" ? "测试" : undefined,
      });
      return;
    }
    transition(tx, id, target, actor, { reason: target === "blocked" ? "测试阻塞" : undefined });
  });
}

describe("任务状态机：合法转移", () => {
  test("todo → doing 抢占后状态、持有者、租约都正确", () => {
    const id = makeTask();
    t.tx((tx) => {
      const task = claimTask(tx, id, actorAt(t.now, sessionA));
      expect(task.status).toBe("doing");
      expect(task.assigneeSessionId).toBe(sessionA);
      expect(task.leaseExpiresAt).toBe(t.now() + 15 * 60 * 1000);
      expect(task.startedAt).not.toBeNull();
    });
  });

  test("todo → blocked 必须带 reason", () => {
    const id = makeTask();
    expect(() => {
      t.tx((tx) => transition(tx, id, "blocked", actorAt(t.now, sessionA)));
    }).toThrow(KanbanError);
  });

  test("blocked → todo 清除阻塞原因但保留进度", () => {
    const id = makeTask();
    t.tx((tx) => {
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, id, actor);
      updateProgress(tx, id, actor, { pct: 40 });
      transition(tx, id, "blocked", actor, { reason: "等外部 API" });
    });
    t.tx((tx) => transition(tx, id, "todo", actorAt(t.now, sessionA)));

    const task = requireTask(t.scope, id);
    expect(task.status).toBe("todo");
    expect(task.blockReason).toBeNull();
    // 关键：解除阻塞不丢进度
    expect(task.progress).toBe(40);
  });

  test("doing → review → done 正常流程", () => {
    const id = makeTask();
    t.tx((tx) => {
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, id, actor);
      updateProgress(tx, id, actor, { pct: 100 });
      transition(tx, id, "review", actor);
    });
    expect(requireTask(t.scope, id).status).toBe("review");

    // review → done 不需要 force
    t.tx((tx) => transition(tx, id, "done", actorAt(t.now, sessionA)));
    const task = requireTask(t.scope, id);
    expect(task.status).toBe("done");
    expect(task.finishedAt).not.toBeNull();
    // 终态释放租约
    expect(task.leaseExpiresAt).toBeNull();
    expect(task.assigneeSessionId).toBeNull();
  });

  test("doing → done 需要 --force（跳过评审）", () => {
    const id = makeTask();
    t.tx((tx) => claimTask(tx, id, actorAt(t.now, sessionA)));
    expect(() => {
      t.tx((tx) => transition(tx, id, "done", actorAt(t.now, sessionA)));
    }).toThrow(/需要 --force/);
  });

  test("终态可 reopen 回 todo", () => {
    const id = makeTask();
    driveTo(id, "done");
    t.tx((tx) => transition(tx, id, "todo", actorAt(t.now, sessionA), { reason: "回归失败" }));
    expect(requireTask(t.scope, id).status).toBe("todo");
  });

  test("release 回到 todo 且保留进度", () => {
    const id = makeTask();
    t.tx((tx) => {
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, id, actor);
      updateProgress(tx, id, actor, { pct: 75 });
      releaseTask(tx, id, actor, "临时让出");
    });
    const task = requireTask(t.scope, id);
    expect(task.status).toBe("todo");
    expect(task.progress).toBe(75);
    expect(task.assigneeSessionId).toBeNull();
  });
});

describe("任务状态机：非法转移", () => {
  test("todo → review 被拒绝，且错误里列出合法后继", () => {
    const id = makeTask();
    let caught: KanbanError | null = null;
    try {
      t.tx((tx) => transition(tx, id, "review", actorAt(t.now, sessionA)));
    } catch (e) {
      caught = e as KanbanError;
    }
    expect(caught).toBeInstanceOf(KanbanError);
    expect(caught!.code).toBe(2);
    expect(caught!.details.legal_transitions).toBeDefined();
    expect(caught!.details.legal_transitions as string[]).toContain("blocked");
  });

  test("done → doing 不能直接回到进行中（需 reopen）", () => {
    const id = makeTask();
    driveTo(id, "done");
    let caught: KanbanError | null = null;
    try {
      t.tx((tx) => transition(tx, id, "doing", actorAt(t.now, sessionA)));
    } catch (e) {
      caught = e as KanbanError;
    }
    expect(caught!.code).toBe(2);
    // 错误里应提示走 reopen
    expect(String(caught!.message)).toContain("todo");
  });

  test("blocked 状态不能被 claim（需先 unblock）", () => {
    const id = makeTask();
    t.tx((tx) => transition(tx, id, "blocked", actorAt(t.now, sessionA), { reason: "等" }));
    expect(() => {
      t.tx((tx) => claimTask(tx, id, actorAt(t.now, sessionA)));
    }).toThrow(KanbanError);
  });

  test("事务回滚干净：非法转移不留下事件", () => {
    const id = makeTask();
    const before = t.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get()!.c;
    expect(() => {
      t.tx((tx) => transition(tx, id, "review", actorAt(t.now, sessionA)));
    }).toThrow();
    const after = t.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get()!.c;
    expect(after).toBe(before);
  });
});

describe("legalTransitions 覆盖每个状态", () => {
  const all: TaskStatus[] = ["backlog", "todo", "doing", "blocked", "review", "done", "cancelled"];
  test("每个状态都有可读的后继说明", () => {
    for (const status of all) {
      const legal = legalTransitions(status);
      expect(Array.isArray(legal)).toBe(true);
      // 终态至少有 reopen 路径，非终态至少有一条路
      if (status === "done" || status === "cancelled") {
        expect(legal).toContain("todo");
      } else {
        expect(legal.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("依赖与自动解除阻塞", () => {
  test("依赖全部完成后，下游自动可认领并收到通知", () => {
    let upstream = "";
    let downstream = "";
    t.tx((tx) => {
      upstream = createTask(tx, { title: "上游" }).id;
      downstream = createTask(tx, { title: "下游" }).id;
    });

    // 下游依赖上游
    t.tx((tx) => addDependency(tx, downstream, upstream));

    // 完成上游
    let unblocked: string[] = [];
    t.tx((tx) => {
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, upstream, actor);
      unblocked = transition(tx, upstream, "done", actor, { force: true }).unblocked;
    });

    expect(unblocked).toContain(downstream);
    expect(requireTask(t.scope, downstream).status).toBe("todo");

    // 且应写出 task_unblocked 事件供 agent 感知
    const evt = t.db
      .query<{ type: string; data: string }, [string]>(
        "SELECT type, data FROM events WHERE task_id = ? AND type = 'task_unblocked'",
      )
      .get(downstream);
    expect(evt).toBeDefined();
  });

  test("blocked 的下游在依赖完成后回到 todo", () => {
    let upstream = "";
    let downstream = "";
    t.tx((tx) => {
      upstream = createTask(tx, { title: "上游" }).id;
      downstream = createTask(tx, { title: "下游" }).id;
    });
    t.tx((tx) => addDependency(tx, downstream, upstream));
    // 下游被阻塞
    t.tx((tx) => transition(tx, downstream, "blocked", actorAt(t.now, sessionA), { reason: "等上游" }));
    expect(requireTask(t.scope, downstream).status).toBe("blocked");

    // 完成上游
    t.tx((tx) => {
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, upstream, actor);
      transition(tx, upstream, "done", actor, { force: true });
    });

    // 应自动解除阻塞回 todo
    const task = requireTask(t.scope, downstream);
    expect(task.status).toBe("todo");
    expect(task.blockReason).toBeNull();
  });

  test("形成环时报错并给出环路径", () => {
    let a = "";
    let b = "";
    t.tx((tx) => {
      a = createTask(tx, { title: "A" }).id;
      b = createTask(tx, { title: "B" }).id;
    });
    t.tx((tx) => addDependency(tx, a, b)); // A 依赖 B
    // B 再依赖 A → 成环
    expect(() => {
      t.tx((tx) => addDependency(tx, b, a));
    }).toThrow(/环/);
  });

  test("自依赖被拒绝", () => {
    const a = makeTask("A");
    expect(() => {
      t.tx((tx) => addDependency(tx, a, a));
    }).toThrow(/不能依赖自己/);
  });

  test("依赖不存在的任务报错", () => {
    const a = makeTask("A");
    expect(() => {
      t.tx((tx) => addDependency(tx, a, "T-9999"));
    }).toThrow(KanbanError);
  });
});

describe("进度与 checklist（ADR-8 双表示）", () => {
  test("checklist 勾选自动折算进度", () => {
    let cid = "";
    t.tx((tx) => {
      cid = createTask(tx, { title: "带清单", checklist: ["a", "b", "c", "d"] }).id;
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, cid, actor);
      updateProgress(tx, cid, actor, { check: ["a", "b"] });
    });
    const task = requireTask(t.scope, cid);
    expect(task.progress).toBe(50); // 2/4
  });

  test("显式 --pct 优先于 checklist 折算", () => {
    let cid = "";
    t.tx((tx) => {
      cid = createTask(tx, { title: "带清单", checklist: ["a", "b"] }).id;
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, cid, actor);
      updateProgress(tx, cid, actor, { check: ["a"], pct: 80 });
    });
    expect(requireTask(t.scope, cid).progress).toBe(80);
  });

  test("勾选不存在的检查项报错并列出可选项", () => {
    let cid = "";
    t.tx((tx) => {
      cid = createTask(tx, { title: "带清单", checklist: ["真项"] }).id;
    });
    let caught: KanbanError | null = null;
    try {
      t.tx((tx) => updateProgress(tx, cid, actorAt(t.now, sessionA), { check: ["假项"] }));
    } catch (e) {
      caught = e as KanbanError;
    }
    expect(caught).toBeInstanceOf(KanbanError);
    expect(caught!.details.available).toEqual(["真项"]);
  });

  test("进度被隐式限制在 0-100", () => {
    const id = makeTask();
    t.tx((tx) => {
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, id, actor);
      updateProgress(tx, id, actor, { pct: 150 });
    });
    expect(requireTask(t.scope, id).progress).toBe(100);
  });
});

describe("列表查询", () => {
  test("默认不含终态，includeTerminal 才包含", () => {
    const done = makeTask("已完成的");
    driveTo(done, "done");
    const openTask = makeTask("进行中的");

    const openList = listTasks(t.scope, {});
    expect(openList.map((x) => x.id)).toContain(openTask);
    expect(openList.map((x) => x.id)).not.toContain(done);

    const allList = listTasks(t.scope, { includeTerminal: true });
    expect(allList.map((x) => x.id)).toContain(done);
  });

  test("ready 过滤：依赖未满足的不算可认领", () => {
    let upstream = "";
    let downstream = "";
    t.tx((tx) => {
      upstream = createTask(tx, { title: "上游" }).id;
      downstream = createTask(tx, { title: "下游" }).id;
    });
    t.tx((tx) => addDependency(tx, downstream, upstream));

    const readyBefore = listTasks(t.scope, { ready: true, status: ["todo"] });
    expect(readyBefore.map((x) => x.id)).toContain(upstream);
    expect(readyBefore.map((x) => x.id)).not.toContain(downstream);

    // 完成上游后下游变为可认领
    t.tx((tx) => {
      const actor = actorAt(t.now, sessionA);
      claimTask(tx, upstream, actor);
      transition(tx, upstream, "done", actor, { force: true });
    });
    const readyAfter = listTasks(t.scope, { ready: true, status: ["todo"] });
    expect(readyAfter.map((x) => x.id)).toContain(downstream);
  });
});
