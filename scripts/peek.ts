// 一次性排查脚本：检查数据库结构与 project 数据
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";

// 默认打开仓库自用的开发库；从脚本位置推导，不能写死绝对路径
const ROOT = resolve(import.meta.dir, "..");
const path = process.argv[2] ?? join(ROOT, ".kanban", "kanban.db");
const db = new Database(path, { readwrite: true, create: false });

console.log("schema_version =", db.query("SELECT v FROM meta WHERE k='schema_version'").get());
console.log("\n表:", db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name).join(", "));
console.log("\nprojects:", db.query("SELECT key, name, root_path, api_key_hash FROM projects").all());
console.log("\ntasks(project_key, id):", db.query("SELECT project_key, id, title FROM tasks ORDER BY seq").all().map((r) => `${r.project_key}/${r.id} ${r.title}`).join(" | "));
console.log("\ncounters:", db.query("SELECT * FROM project_counters").all());
console.log("\nevents 分布:", db.query("SELECT project_key, COUNT(*) c FROM events GROUP BY project_key").all());
console.log("\ntasks 表结构:", db.query("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name).join(","));
db.close();
