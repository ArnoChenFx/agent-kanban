/**
 * rebuild 自证：走遍每条合法状态转移路径，每一步都必须自证一致。
 *
 * ## 为什么要单开一个文件
 *
 * README 把 rebuild 宣传成「写入路径的自证 / 可以放进 CI」。既然是自证，
 * 那它对**最常见的路径**就必须为真。而它曾经不是：
 *
 * `rebuild.ts` 的 `task_review` 处理器把 `assignee_session_id` 与 `lease_expires_at`
 * 清成 null，而 `transition()` 转到 review 时**不清**（只有 isTerminal 与
 * `to === "todo"` 才清）。而 `assignee_session_id` 又在 `TASK_COMPARED_FIELDS` 里，
 * 于是最常见的 `claim → review` 流程就报漂移，`--force --write` 还会把持卡人抹掉。
 *
 * 更麻烦的是 `task_reopened` 处理器用
 * `t.status = t.assignee_session_id ? "doing" : "todo"` 区分「评审打回」与「终态重开」——
 * 而 `assignee_session_id` 恰恰是被 review 处理器错误清空的那个字段。
 * **一个字段错了，连带两个判断都错。**
 *
 * ## 这个守卫的思路
 *
 * 不逐条枚举「哪些路径会漂移」（那是修 bug 的人该做的，不是测试该做的），
 * 而是**把状态机里每条合法转移都走一遍，每步跑一次 rebuild 并断言 `ok`**。
 * 于是任何「重放规则与写入路径不一致」都会在第一次出现时就被抓住，
 * 而不是等某个用户恰好走了那条路。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rebuild, type RebuildReport } from "../src/core/rebuild.ts";
import { TERMINAL_STATUSES, type TaskStatus } from "../src/core/types.ts";
import { addDependency, claimTask, createTask, getTask, transition, releaseTask, updateProgress, addNote } from "../src/core/tasks.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { withTx, type TxContext } from "../src/core/tx.ts";
import { createSession } from "../src/core/sessions.ts";

const PROJECT = "test";
let t: TestDb;
let clock: number;
let sid: string;

beforeEach(() => {
  clock = 1_700_000_000_000;
  sid = "s-rebuild";
  t = createTestDb({ projectKey: PROJECT, now: clock });
  withTx(
    t.db,
    (c) => {
      createSession(c, { agentName: "rebuild-test", id: sid });
    },
    { now: () => clock, projectKey: "system" },
  );
});

afterEach(() => {
  t.cleanup();
});

/** 跑一次 rebuild，把漂移整理成可读的一行行 */
function check(label: string): RebuildReport {
  const report = rebuild(t.db, { projectKey: PROJECT });
  const detail = report.drift
    .map((d) => `${d.table}.${d.id}.${d.field}: db=${JSON.stringify(d.actual)} 重算=${JSON.stringify(d.expected)}`)
    .join(" | ");
  // 用自定义断言消息：失败时直接告诉你是哪条路径、哪几个字段，而不是丢一个对象 diff
  expect(
    detail,
    `rebuild 自证失败（路径：${label}）\n  ${detail || "（无漂移）"}`,
  ).toBe("");
  return report;
}

/** 建一张卡并认领（多数路径的起点） */
function claimed(extra: { checklist?: string[]; blockedBy?: string[] } = {}): string {
  let id = "";
  withTx(
    t.db,
    (c) => {
      id = createTask(c, { title: `卡 ${++seq}`, checklist: extra.checklist, blockedBy: extra.blockedBy }).id;
      claimTask(c, id, { sessionId: sid, now: clock });
    },
    { now: () => clock, projectKey: PROJECT, sessionId: sid },
  );
  return id;
}

let seq = 0;

describe("rebuild 自证：每条合法转移之后都必须一致", () => {
  test("doing → review：持卡人保留，rebuild 不许报错", () => {
    const id = claimed();
    expect(getTask({ db: t.db, projectKey: PROJECT }, id)!.assigneeSessionId).toBe(sid);

    withTx(t.db, (c) => { transition(c, id, "review", { sessionId: sid, now: clock }, { note: "请评审" }); },
      { now: () => clock, projectKey: PROJECT });
    // 库里确实保留了持卡人
    const after = getTask({ db: t.db, projectKey: PROJECT }, id)!;
    expect(after.status).toBe("review");
    expect(after.assigneeSessionId).toBe(sid);

    check("claim → review");
  });

  test("review → doing（打回）：rebuild 必须算成 doing 而不是 todo", () => {
    const id = claimed();
    withTx(t.db, (c) => { transition(c, id, "review", { sessionId: sid, now: clock }, {}); },
      { now: () => clock, projectKey: PROJECT });
    withTx(t.db, (c) => { transition(c, id, "doing", { sessionId: sid, now: clock }, { reason: "要改" }); },
      { now: () => clock, projectKey: PROJECT });
    expect(getTask({ db: t.db, projectKey: PROJECT }, id)!.status).toBe("doing");
    check("claim → review → doing");
  });

  test("review → done：正常闭环", () => {
    const id = claimed();
    withTx(t.db, (c) => { transition(c, id, "review", { sessionId: sid, now: clock }, {}); },
      { now: () => clock, projectKey: PROJECT });
    withTx(t.db, (c) => { transition(c, id, "done", { sessionId: sid, now: clock }, {}); },
      { now: () => clock, projectKey: PROJECT });
    check("claim → review → done");
  });

  test("done → todo（重开）：必须算成 todo 且不残留持卡人", () => {
    const id = claimed();
    withTx(t.db, (c) => { transition(c, id, "done", { sessionId: sid, now: clock }, { force: true }); },
      { now: () => clock, projectKey: PROJECT });
    withTx(t.db, (c) => { transition(c, id, "todo", { sessionId: sid, now: clock }, { reason: "重开" }); },
      { now: () => clock, projectKey: PROJECT });
    const after = getTask({ db: t.db, projectKey: PROJECT }, id)!;
    expect(after.status).toBe("todo");
    expect(after.assigneeSessionId).toBeNull();
    check("claim → done → todo");
  });

  test("cancelled → todo（重开）", () => {
    const id = claimed();
    withTx(t.db, (c) => { transition(c, id, "cancelled", { sessionId: sid, now: clock }, { reason: "不做了" }); },
      { now: () => clock, projectKey: PROJECT });
    withTx(t.db, (c) => { transition(c, id, "todo", { sessionId: sid, now: clock }, { reason: "复活" }); },
      { now: () => clock, projectKey: PROJECT });
    check("claim → cancelled → todo");
  });

  test("doing → blocked → todo（手动解除阻塞）", () => {
    const id = claimed();
    withTx(t.db, (c) => { transition(c, id, "blocked", { sessionId: sid, now: clock }, { reason: "等外部" }); },
      { now: () => clock, projectKey: PROJECT });
    check("claim → blocked");
    withTx(t.db, (c) => { transition(c, id, "todo", { sessionId: sid, now: clock }, {}); },
      { now: () => clock, projectKey: PROJECT });
    check("claim → blocked → todo");
  });

  test("blocked → cancelled", () => {
    const id = claimed();
    withTx(t.db, (c) => { transition(c, id, "blocked", { sessionId: sid, now: clock }, { reason: "等外部" }); },
      { now: () => clock, projectKey: PROJECT });
    withTx(t.db, (c) => { transition(c, id, "cancelled", { sessionId: sid, now: clock }, { reason: "不等了" }); },
      { now: () => clock, projectKey: PROJECT });
    check("claim → blocked → cancelled");
  });

  test("todo → done（--force 快捷通道）", () => {
    let id = "";
    withTx(t.db, (c) => { id = createTask(c, { title: "直接完" }).id; }, { now: () => clock, projectKey: PROJECT });
    withTx(t.db, (c) => { transition(c, id, "done", { sessionId: sid, now: clock }, { force: true }); },
      { now: () => clock, projectKey: PROJECT });
    check("todo → done (force)");
  });

  test("release：doing → todo 保留进度", () => {
    const id = claimed();
    withTx(t.db, (c) => { updateProgress(c, id, { sessionId: sid, now: clock }, { pct: 60, note: "做了一半" }); },
      { now: () => clock, projectKey: PROJECT });
    check("claim → progress 60");
    withTx(t.db, (c) => { releaseTask(c, id, { sessionId: sid, now: clock }, "先放一放"); },
      { now: () => clock, projectKey: PROJECT, sessionId: sid });
    const after = getTask({ db: t.db, projectKey: PROJECT }, id)!;
    expect(after.status).toBe("todo");
    expect(after.progress).toBe(60); // 进度保留是设计要求
    check("claim → progress → release");
    // 重新认领仍能续上
    withTx(t.db, (c) => { claimTask(c, id, { sessionId: sid, now: clock }); }, { now: () => clock, projectKey: PROJECT });
    check("release → 重新 claim");
  });

  test("checklist 勾选 / 取消勾选 / 追加", () => {
    let id = "";
    withTx(
      t.db,
      (c) => {
        id = createTask(c, { title: "带清单", checklist: ["第一步", "第二步"] }).id;
        claimTask(c, id, { sessionId: sid, now: clock });
        updateProgress(c, id, { sessionId: sid, now: clock }, { check: ["第一步"] });
      },
      { now: () => clock, projectKey: PROJECT, sessionId: sid },
    );
    check("claim → 勾一项（进度应自动跟到 50%）");
    expect(getTask({ db: t.db, projectKey: PROJECT }, id)!.progress).toBe(50);

    withTx(t.db, (c) => { updateProgress(c, id, { sessionId: sid, now: clock }, { uncheck: ["第一步"] }); },
      { now: () => clock, projectKey: PROJECT });
    check("取消勾选");

    withTx(t.db, (c) => { updateProgress(c, id, { sessionId: sid, now: clock }, { addCheck: ["第三步"] }); },
      { now: () => clock, projectKey: PROJECT });
    check("追加一项");
  });

  test("note 不改状态但要能重放", () => {
    const id = claimed();
    withTx(t.db, (c) => { addNote(c, id, { sessionId: sid, now: clock }, "随手记一句"); },
      { now: () => clock, projectKey: PROJECT });
    check("note");
  });

  test("backlog → todo", () => {
    let id = "";
    withTx(t.db, (c) => {
      id = createTask(c, { title: "想法", status: "backlog" }).id;
      transition(c, id, "todo", { sessionId: sid, now: clock }, {});
    }, { now: () => clock, projectKey: PROJECT });
    check("backlog → todo");
  });

  test("backlog → cancelled", () => {
    let id = "";
    withTx(t.db, (c) => {
      id = createTask(c, { title: "想法", status: "backlog" }).id;
      transition(c, id, "cancelled", { sessionId: sid, now: clock }, { reason: "不做了" });
    }, { now: () => clock, projectKey: PROJECT });
    check("backlog → cancelled");
  });

  test("走遍所有状态：每张终态卡各自自证", () => {
    // 兜底：不管前面怎么变，这里对每个终态都断言一次
    for (const target of TERMINAL_STATUSES as readonly TaskStatus[]) {
      const id = claimed();
      withTx(
        t.db,
        (c) => {
          transition(c, id, "review", { sessionId: sid, now: clock }, {});
          transition(c, id, target, { sessionId: sid, now: clock }, { reason: "r" });
        },
        { now: () => clock, projectKey: PROJECT, sessionId: sid },
      );
      check(`→ ${target}`);
    }
  });
});

/**
 * 接线守卫：`task_reopened` 重放时**优先用事件里的 to**，而不是推断。
 *
 * `task_reopened` 同时表示「review 打回 doing」与「终态重开 todo」。
 * 以前只能靠 `assignee_session_id` 有没有值来猜——而那个字段曾被 `task_review`
 * 处理器错误清空，于是两个判断一起错（一个字段错了，连带两处）。
 *
 * 现在 `transition` 把目标状态写进事件（它本来就知道），rebuild 直接用。
 *
 * 下面的用例是**人工构造**的事件：当前两条路径下启发式恰好也对（所以
 * 「不读 to」并不会让现有用例变红），但那依赖一个住在**另一个文件**里的不变量
 * （「进入终态必清 assignee」）。用合成事件把优先级规则本身钉住，
 * 免得那个不变量以后一改就静默出错。
 */
describe("接线守卫：task_reopened 优先用事件里的 to", () => {
  test("真实转移发出的事件里带 to（否则上面两条都变成空测）", () => {
    // done → todo
    const a = claimed();
    withTx(
      t.db,
      (c) => {
        transition(c, a, "done", { sessionId: sid, now: clock }, { force: true });
        transition(c, a, "todo", { sessionId: sid, now: clock }, { reason: "重开" });
      },
      { now: () => clock, projectKey: PROJECT, sessionId: sid },
    );
    // review → doing（打回）
    const b = claimed();
    withTx(
      t.db,
      (c) => {
        transition(c, b, "review", { sessionId: sid, now: clock }, {});
        transition(c, b, "doing", { sessionId: sid, now: clock }, { reason: "改" });
      },
      { now: () => clock, projectKey: PROJECT, sessionId: sid },
    );

    const reopenedTo = (taskId: string): string | undefined => {
      const row = t.db
        .query<{ data: string }, [string, string]>(
          "SELECT data FROM events WHERE project_key = ? AND task_id = ? AND type = 'task_reopened'",
        )
        .get(PROJECT, taskId);
      return row ? (JSON.parse(row.data) as { to?: string }).to : undefined;
    };
    expect(reopenedTo(a)).toBe("todo");
    expect(reopenedTo(b)).toBe("doing");
  });

  test("事件带 to 时按 to 算，不看持卡人", () => {
    const id = claimed();
    // 先让这张卡处于「review + 仍有持卡人」：启发式此时会说 doing
    withTx(
      t.db,
      (c) => { transition(c, id, "review", { sessionId: sid, now: clock }, {}); },
      { now: () => clock, projectKey: PROJECT, sessionId: sid },
    );
    expect(getTask({ db: t.db, projectKey: PROJECT }, id)!.assigneeSessionId).toBe(sid);

    // 人工插一条带 to=todo 的 task_reopened（库里也改成 todo，保证「不一致」是真实的）
    t.db
      .query(
        `INSERT INTO events (ts, session_id, type, task_id, plan_id, project_key, data)
         VALUES (?, ?, 'task_reopened', ?, NULL, ?, ?)`,
      )
      .run(clock, sid, id, PROJECT, JSON.stringify({ to: "todo", reason: "合成" }));
    t.db
      .query("UPDATE tasks SET status = 'todo' WHERE project_key = ? AND id = ?")
      .run(PROJECT, id);

    // rebuild 必须采信 to=todo；用启发式的话会算成 doing（因为持卡人还在）
    const report = rebuild(t.db, { projectKey: PROJECT });
    expect({ drift: report.drift.map((d) => `${d.id}.${d.field}`) }).toEqual({ drift: [] });
  });

  test("旧事件（没有 to）仍能重放：终态重开靠启发式", () => {
    const id = claimed();
    withTx(
      t.db,
      (c) => {
        transition(c, id, "done", { sessionId: sid, now: clock }, { force: true });
        transition(c, id, "todo", { sessionId: sid, now: clock }, { reason: "重开" });
      },
      { now: () => clock, projectKey: PROJECT, sessionId: sid },
    );
    // 手工把 to 抹掉，模拟旧版事件
    t.db
      .query(
        `UPDATE events SET data = replace(data, ',"to":"todo"', '')
          WHERE project_key = ? AND task_id = ? AND type = 'task_reopened'`,
      )
      .run(PROJECT, id);
    const row = t.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM events WHERE project_key = ? AND task_id = ? AND type = 'task_reopened'",
      )
      .get(PROJECT, id)!;
    expect(JSON.parse(row.data).to).toBeUndefined();

    // 回放仍然要自证一致（启发式在终态重开这个场景下等价）
    const report = rebuild(t.db, { projectKey: PROJECT });
    expect({ drift: report.drift.map((d) => `${d.id}.${d.field}`) }).toEqual({ drift: [] });
  });
});

/**
 * 自动解阻路径（`notifyDependentsReady`）。
 *
 * 之前没有任何用例走这条路：它只在「完成一个任务 → 下游的 blocked 卡被自动推回 todo」
 * 时触发。而这条路径与**手动** `task unblock`（`transition` 的 blocked→todo）
 * 发的是同一个事件类型 `task_unblocked`，对库的改动却曾经不同
 * （自动那条不清 assignee/lease），于是 rebuild 算不对。
 *
 * 现在两条路径对库的改动一致，所以补一条走自动路径的用例。
 *
 * 注：这里不预设「阻塞后仍有持卡人」——阻塞本身就会清掉持卡人（见 #8），
 * 所以自动解阻时已经没有持卡人可清了。用例要钉的是**状态与投影一致**。
 */
describe("自动解阻路径也要自证一致", () => {
  test("完成上游 → 下游 blocked 卡自动回 todo → rebuild 一致", () => {
    let upstream = "";
    let downstream = "";
    withTx(
      t.db,
      (c) => {
        downstream = createTask(c, { title: "下游（被阻塞）" }).id;
        upstream = createTask(c, { title: "上游" }).id;
        addDependency(c, downstream, upstream);
        claimTask(c, downstream, { sessionId: sid, now: clock });
        transition(c, downstream, "blocked", { sessionId: sid, now: clock }, { reason: "等上游" });
      },
      { now: () => clock, projectKey: PROJECT, sessionId: sid },
    );
    // 阻塞已把持卡人清掉
    expect(getTask({ db: t.db, projectKey: PROJECT }, downstream)!.assigneeSessionId).toBeNull();
    check("建卡 + 依赖 + 认领 + 阻塞");

    // 完成上游 → 自动解阻
    withTx(
      t.db,
      (c) => {
        claimTask(c, upstream, { sessionId: sid, now: clock });
        transition(c, upstream, "done", { sessionId: sid, now: clock }, { force: true });
      },
      { now: () => clock, projectKey: PROJECT, sessionId: sid },
    );

    const after = getTask({ db: t.db, projectKey: PROJECT }, downstream)!;
    expect(after.status).toBe("todo");
    expect(after.assigneeSessionId).toBeNull();
    expect(after.leaseExpiresAt).toBeNull();
    expect(after.blockReason ?? null).toBeNull();
    // 进度保留（重开/自动解阻都不应该从头再来）
    check("完成上游 → 自动解阻");
  });
});

void ({} as TxContext);
