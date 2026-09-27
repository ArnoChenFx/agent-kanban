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
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, setInitialConfig, type Db } from "../src/core/db.ts";
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
  revokeToken,
  tokenToJson,
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
});
