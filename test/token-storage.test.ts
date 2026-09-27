/**
 * 凭据存储：库里**不得**出现 token 明文。
 *
 * ## 曾经的 bug
 *
 * `issueToken` 里有一行：
 *
 * ```ts
 * const id = plaintext; // token 的 id 就是 key 本身（便于用 key 直接查）
 * ```
 *
 * 而文件头注释与 `schema.sql` 都写着「**库里只存 key_hash（SHA-256）**，
 * 明文只在创建/轮换时显示一次」。于是设计完全落空：任何能读到 `kanban.db` 的人
 * ——备份、`export` 产物、误提交、只读挂载的运维脚本——都拿到**全部在用**的 token。
 * `key_hash` 列沦为摆设，鉴权走的是 `WHERE id = ?` 的明文直查。
 *
 * ## 现在的形状
 *
 * - `id` = `t_` + 32 hex 的**引用**，与密钥无关，可以安全显示（admin API 靠它寻址）
 * - `key_hash` = sha256(明文)，鉴权唯一依据
 * - 明文只在两个地方出现：签发时的响应体、`.kanban/config.toml`（运维可读，这是刻意的）
 *
 * ## 为什么**不需要迁移**
 *
 * `key_hash` 这一列一直算得是对的，只是 `id` 列多余地存了明文。
 * 把鉴权改成按 `key_hash` 查之后，**存量 token 自动继续可用**——
 * 它们的哈希本来就在那儿。下面「老格式的行仍然可用」那条就是证明。
 *
 * ## 零迁移的代价：老行的 `id` 里仍然是明文
 *
 * 于是「库里不出现明文」这条不变量对**新写进去的数据**成立，对存量行不成立。
 * 这不是靠迁移解决的（迁移会把所有在用 token 一次性作废），而是靠**出口过滤**：
 * 凡是可能把 `tokens.id` 送到别人眼前的地方都要过 `describeTokenRef`——
 * `tokenToJson`（HTTP / admin 列表 / CLI）、四个 `token_*` 事件的 `token_ref`、
 * 以及渲染侧（`describeEvent`）。事件流这条尤其要紧：事件表会被 export / 备份 /
 * rebuild，明文一旦写进去就会跟着库走很久，而 `token_revoked` 收的是**调用方传入的**
 * id，`admin token revoke k_xxx` 会把在用密钥直接送进去。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  getSchemaVersion,
  openDb,
  migrate,
  setInitialConfig,
  setMeta,
  type Db,
} from "../src/core/db.ts";
import { queryEvents, describeEvent } from "../src/core/events.ts";
import { toEvent } from "../src/core/rows.ts";
import { ensureAdminToken, readConfigFile } from "../src/core/config.ts";
import { createProject } from "../src/core/projects.ts";
import { generateApiKey } from "../src/core/projects.ts";
import {
  TOKEN_PREFIX,
  TOKEN_REF_PREFIX,
  authenticate,
  describeTokenRef,
  getToken,
  hashToken,
  issueToken,
  listTokens,
  revokeToken,
  tokenToJson,
  updateTokenMeta,
  updateTokenProjects,
} from "../src/core/tokens.ts";

const NOW = 1_700_000_000_000;

let dir: string;
let handle: Db;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-token-"));
  handle = openDb(join(dir, "t.db"));
  migrate(handle);
  db = handle.raw;
  setInitialConfig(db, { projectName: "token-test", now: NOW });
  createProject(db, { key: "p1", name: "p1", rootPath: dir, apiKeyHash: null, now: NOW });
  createProject(db, { key: "p2", name: "p2", rootPath: dir, apiKeyHash: null, now: NOW + 1 });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // 已关闭
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 把 tokens 表的每一列都拼成一个大字符串，用来搜明文 */
function wholeTableDump(): string {
  const rows = db.query<Record<string, string | null>, []>("SELECT * FROM tokens").all();
  return JSON.stringify(rows);
}

describe("签发：库里不出现明文", () => {
  test("tokens 表任何一列都不含明文，且 id 是 t_ 开头的引用", () => {
    const issued = issueToken(db, { role: "project", projects: ["p1"], name: "CI" }, NOW);

    expect(issued.plaintext).toMatch(/^k_[0-9a-f]{32}$/);
    expect(issued.token.id).toMatch(/^t_[0-9a-f]{32}$/);
    expect(issued.token.id).not.toBe(issued.plaintext);
    // 核心断言：整个表里搜不到明文
    expect(wholeTableDump()).not.toContain(issued.plaintext);
    // 只存哈希，且哈希确实对得上
    const row = db
      .query<{ key_hash: string }, [string]>("SELECT key_hash FROM tokens WHERE id = ?")
      .get(issued.token.id)!;
    expect(row.key_hash).toBe(hashToken(issued.plaintext));
  });

  test("server 自动生成的 admin token 也不进库（只留在 config.toml）", () => {
    const ensured = ensureAdminToken(dir, { db, now: NOW, generate: generateApiKey });
    expect(ensured.isNew).toBe(true);
    // 库里搜不到
    expect(wholeTableDump()).not.toContain(ensured.token);
    // 但鉴权能用（说明注册成功且哈希对得上）
    const auth = authenticate(db, ensured.token, "p1", NOW);
    expect(auth.ok).toBe(true);
    // config.toml 里确实有（运维可读，这是刻意的——它不在数据库里）。
    // 直接读文件内容断言：字段名是 admin_token，但断言结构会随配置形状变化而碎。
    expect(readConfigFile(dir)).not.toBeNull();
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain(ensured.token);
  });

  test("重复 ensureAdminToken 幂等（不会因为 id 变了而插第二行）", () => {
    const first = ensureAdminToken(dir, { db, now: NOW, generate: generateApiKey });
    const second = ensureAdminToken(dir, { db, now: NOW + 10, generate: generateApiKey });
    expect(second.isNew).toBe(false);
    expect(second.token).toBe(first.token);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()!.n).toBe(1);
  });
});

describe("鉴权：按 key_hash 查，明文仍然可用", () => {
  test("新签发的 token 能鉴权", () => {
    const issued = issueToken(db, { role: "project", projects: ["p1"] }, NOW);
    expect(authenticate(db, issued.plaintext, "p1", NOW).ok).toBe(true);
    // 越权仍然被拒
    expect(authenticate(db, issued.plaintext, "p2", NOW)).toMatchObject({ ok: false, reason: "forbidden" });
    // 拿引用去鉴权是不行的（引用不是凭据）
    expect(authenticate(db, issued.token.id, "p1", NOW)).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("老格式的行（id 就是明文）仍然可用 —— 这就是不需要迁移的原因", () => {
    // 手工插一条「旧版」行：id = 明文，key_hash 正确
    const legacyPlain = TOKEN_PREFIX + "a".repeat(32);
    db.query(
      `INSERT INTO tokens (id, name, role, projects, key_hash, created_at, last_used_at, revoked_at, expires_at)
       VALUES (?, 'legacy', 'project', ?, ?, ?, NULL, NULL, NULL)`,
    ).run(legacyPlain, JSON.stringify(["p1"]), hashToken(legacyPlain), NOW);

    // 旧 token 照常鉴权（哈希本来就在那儿）
    const auth = authenticate(db, legacyPlain, "p1", NOW);
    expect(auth.ok).toBe(true);
    // 库里确实有明文——这是旧行的既成事实，迁移不做清理
    expect(wholeTableDump()).toContain(legacyPlain);
  });

  test("吊销后立即失效（按引用寻址）", () => {
    const issued = issueToken(db, { role: "project", projects: ["p1"] }, NOW);
    expect(authenticate(db, issued.plaintext, "p1", NOW).ok).toBe(true);
    revokeToken(db, issued.token.id, NOW + 1);
    expect(authenticate(db, issued.plaintext, "p1", NOW + 2)).toMatchObject({ ok: false, reason: "revoked" });
  });
});

describe("admin 界面链路：列表里的 id 要能直接用来操作", () => {
  test("tokenToJson 给完整引用，拿它能吊销、能改白名单", () => {
    const issued = issueToken(db, { role: "project", projects: ["p1"] }, NOW);
    const json = tokenToJson(issued.token, NOW);

    // 必须是完整引用，不能是掩码 —— 掩码发回 admin API 必然 404
    expect(json.id).toBe(issued.token.id);
    expect(String(json.id)).not.toContain("…");
    // 也不能是明文
    expect(String(json.id)).not.toBe(issued.plaintext);

    // 拿着它就能查到、吊销、改白名单
    expect(getToken(db, String(json.id))?.id).toBe(issued.token.id);
    updateTokenProjects(db, String(json.id), ["p1", "p2"], NOW + 1);
    expect(getToken(db, String(json.id))!.projects).toEqual(["p1", "p2"]);
    revokeToken(db, String(json.id), NOW + 2);
    expect(getToken(db, String(json.id))!.revokedAt).not.toBeNull();
  });

  test("describeTokenRef：引用原样显示，密钥掩码", () => {
    // 误把密钥塞进 :id 段时不能原样回显（会进日志与浏览器控制台）
    const key = TOKEN_PREFIX + "b".repeat(32);
    expect(describeTokenRef(key)).toContain("…");
    expect(describeTokenRef(key)).not.toContain(key);
    // 引用不是密钥，显示全
    const ref = TOKEN_REF_PREFIX + "c".repeat(32);
    expect(describeTokenRef(ref)).toBe(ref);
  });

  test("存量行的 id 仍是明文密钥：对外一律掩码，鉴权不受影响", () => {
    // 造一行 #4 之前的老库数据——tokens.id 里存的是明文密钥。零迁移意味着
    // 这些行原样留在库里，所以 tokenToJson 不能无条件回显 id：那等于把在用的
    // 密钥原样吐进 admin 列表 / CLI `admin token list` / admin 页。
    const legacyPlain = TOKEN_PREFIX + "e".repeat(32);
    db.query(
      `INSERT INTO tokens (id, name, role, projects, key_hash, created_at, last_used_at, revoked_at, expires_at)
       VALUES (?, 'legacy', 'project', ?, ?, ?, NULL, NULL, NULL)`,
    ).run(legacyPlain, JSON.stringify(["p1"]), hashToken(legacyPlain), NOW);

    // 库里确实还是明文（既有事实，本次不做数据清理）
    expect(wholeTableDump()).toContain(legacyPlain);
    // 鉴权照常——掩码只发生在显示层，不影响零迁移的结论
    expect(authenticate(db, legacyPlain, "p1", NOW).ok).toBe(true);

    // 两个出口（详情 / 列表）都不外泄
    const one = tokenToJson(getToken(db, legacyPlain)!, NOW);
    expect(String(one.id)).not.toBe(legacyPlain);
    expect(String(one.id)).toContain("…");
    expect(JSON.stringify(listTokens(db).map((t) => tokenToJson(t, NOW)))).not.toContain(legacyPlain);

    // 代价：legacy 行无法再用列表里的 id 反查（掩码值回传必然查不到）
    expect(getToken(db, String(one.id))).toBeNull();
    // 正确处置是吊销后重新签发：那条路径是通的
    revokeToken(db, legacyPlain, NOW + 1);
    expect(authenticate(db, legacyPlain, "p1", NOW + 2)).toMatchObject({ ok: false, reason: "revoked" });
  });

  test("新行仍然给全引用——存量行掩码不能连累新行", () => {
    const fresh = issueToken(db, { role: "project", projects: ["p1"] }, NOW);
    expect(tokenToJson(fresh.token, NOW).id).toBe(fresh.token.id);
    expect(getToken(db, String(tokenToJson(fresh.token, NOW).id))).not.toBeNull();
  });

  test("事件流里也没有明文：拿密钥当 id 吊销不会把它写进事件", () => {
    // tokenToJson 只堵住了 HTTP / 列表那一层出口，而 token_revoked 拿的是
    // **调用方传入的** id。CLI 上手敲 `admin token revoke k_xxx` 完全合法，
    // 密钥就顺着 token_ref 进了事件表——而事件表会被 export / 备份 / rebuild。
    const legacyPlain = TOKEN_PREFIX + "b".repeat(32);
    db.query(
      `INSERT INTO tokens (id, name, role, projects, key_hash, created_at, last_used_at, revoked_at, expires_at)
       VALUES (?, 'legacy2', 'project', ?, ?, ?, NULL, NULL, NULL)`,
    ).run(legacyPlain, JSON.stringify(["p1"]), hashToken(legacyPlain), NOW);

    revokeToken(db, legacyPlain, NOW + 1);
    updateTokenProjects(db, legacyPlain, ["p1", "other"], NOW + 2);

    // 整条事件流里都不该出现明文
    const dump = JSON.stringify(queryEvents(db, { projectKey: "system" }));
    expect(dump).not.toContain(legacyPlain);
    // 但审计事实还在：掩码后的 ref 仍然指向那一行
    const revoked = queryEvents(db, { projectKey: "system" })
      .filter((e) => e.type === "token_revoked")
      .at(-1)!;
    const ref = (JSON.parse(revoked.data ?? "{}") as { token_ref: string }).token_ref;
    expect(ref).not.toBe(legacyPlain);
    expect(ref).toContain("…");
    // 渲染面（describeEvent）同样不念明文
    expect(describeEvent(toEvent(revoked))).not.toContain(legacyPlain);
  });

  test("updateTokenMeta：改的字段与审计事件记的字段严格一致", () => {
    const issued = issueToken(db, { role: "admin" }, NOW);
    const tokenUpdates = () =>
      queryEvents(db, { projectKey: "system" })
        .filter((e) => e.type === "token_updated")
        .map((e) => JSON.parse(e.data ?? "{}") as { field: string });

    // 曾经那三条 UPDATE 是裸 db.query、写在 auditWrite 之外（注释还自称同事务），
    // 崩在中间就会留下「改了但没记」。现在两者同事务。
    const updated = updateTokenMeta(db, issued.token.id, { name: "n1", note: "note1", expiresAtMs: 1000 }, NOW + 1);
    expect(updated.name).toBe("n1");
    expect(updated.note).toBe("note1");
    expect(updated.expiresAt).toBe(NOW + 1 + 1000);
    expect(tokenUpdates().at(-1)!.field).toBe("name,note,expires_at");

    // 只改一个字段时，事件只记那一个：防的是「changed」与实际 UPDATE 各数一遍
    updateTokenMeta(db, issued.token.id, { name: "n2" }, NOW + 2);
    expect(tokenUpdates().at(-1)!.field).toBe("name");
    // 未传的字段不受影响
    expect(getToken(db, issued.token.id)!.note).toBe("note1");
    // 空 patch 不写事件（也无 UPDATE 可写）
    const before = tokenUpdates().length;
    updateTokenMeta(db, issued.token.id, {}, NOW + 3);
    expect(tokenUpdates().length).toBe(before);
  });
});

describe("key_hash 的 UNIQUE 索引（v6）", () => {
  /** 把库退回「v5」：删掉索引、把版本号改回去 */
  function downgradeToV5(h: Db): void {
    h.raw.exec("DROP INDEX IF EXISTS idx_tokens_key_hash");
    setMeta(h.raw, "schema_version", "5");
  }

  /** 读回这条索引；[unique] 是 SQLite 的保留字，必须打方括号。
   *  注意 bun:sqlite 的 .get() 查不到行时返回 null（不是 undefined）。 */
  function keyHashIndex(): { name: string; unique: number } | null {
    return db
      .query<{ name: string; unique: number }, []>(
        "SELECT name, [unique] FROM pragma_index_list('tokens') WHERE name = 'idx_tokens_key_hash'",
      )
      .get();
  }

  test("新库直接就有（applySchema 建的，不是迁移补的）", () => {
    expect(getSchemaVersion(handle)).toBe(SCHEMA_VERSION);
    expect(keyHashIndex()?.unique).toBe(1);
  });

  test("v5 老库升级时补建——存量库不能一直全表扫描", () => {
    downgradeToV5(handle);
    expect(keyHashIndex()).toBeNull();
    expect(getSchemaVersion(handle)).toBe(5);

    migrate(handle);

    expect(getSchemaVersion(handle)).toBe(SCHEMA_VERSION);
    expect(keyHashIndex()?.unique).toBe(1);
  });

  test("索引建上后，重复 key_hash 由数据库直接拒绝", () => {
    const issued = issueToken(db, { role: "project", projects: ["p1"] }, NOW);
    // 应用层「先查再插」在两个请求同时签发时会漏，所以这个约束必须在库里
    expect(() =>
      db
        .query(
          `INSERT INTO tokens (id, name, role, projects, key_hash, created_at)
           VALUES (?, 'copy', 'project', ?, ?, ?)`,
        )
        .run(TOKEN_REF_PREFIX + "9".repeat(32), JSON.stringify(["p1"]), issued.token.keyHash, NOW),
    ).toThrow(/UNIQUE/i);
  });

  test("老库里已有重复行时：报错并给出排查语句，而不是把库锁死", () => {
    const key = TOKEN_PREFIX + "f".repeat(32);
    const hash = hashToken(key);
    // 先退版本，否则带 UNIQUE 的索引会把重复行挡在插不进来
    downgradeToV5(handle);
    const ins = db.query(
      `INSERT INTO tokens (id, name, role, projects, key_hash, created_at)
       VALUES (?, ?, 'project', ?, ?, ?)`,
    );
    ins.run(TOKEN_REF_PREFIX + "1".repeat(32), "a", JSON.stringify(["p1"]), hash, NOW);
    ins.run(TOKEN_REF_PREFIX + "2".repeat(32), "b", JSON.stringify(["p1"]), hash, NOW);

    let err: unknown;
    try {
      migrate(handle);
    } catch (e) {
      err = e;
    }
    // 迁移必须失败：静默跳过就等于「索引没建 + 没人知道」
    expect(String(err)).toContain("key_hash");
    expect((err as { details?: Record<string, unknown> }).details?.reason).toBe("duplicate_token_key_hash");
    // 错误要能指导排查，而不是只说一句建不了
    expect((err as { details?: Record<string, unknown> }).details?.hint).toContain("SELECT id, name");
    // ⚠ 版本号不能前进：否则重跑时会认为已迁移而永远不再建索引
    expect(getSchemaVersion(handle)).toBe(5);
    // 关键：库仍然可读可写，没有被迁移搞成打不开
    expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tokens").get()!.c).toBe(2);
  });
});
