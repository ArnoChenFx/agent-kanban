// 检查「幽灵依赖」：源码里 import 了，但 package.json 没声明的包。
//
// 为什么要查：bun 有 auto-install，`bun run` 时会顺手把未声明的依赖装进
// node_modules，于是本地永远是绿的。等到 CI 跑 `bun install --frozen-lockfile`
// （只装 lockfile 里的），这些包就消失了，tsc 报 TS2307、vite 报 Can't resolve。
//
// ⚠ 只扫 TS 的 import 是不够的，一共踩过三个盲区：
//   1. CSS 里的 @import 同样会解析包名。第一版就漏了 `@import "shadcn/tailwind.css"`。
//   2. `compilerOptions.types` 是类型库引用，不出现在任何 import 语句里。
//      `web/tsconfig.node.json` 写着 `"types": ["node"]`，可 @types/node 从没被声明过；
//      本地能从**父目录** node_modules 蹭到，Docker 里没有父目录，立刻 TS2688。
//   3. vite.config.ts 在 src/ 之外，不走 walk() 就完全扫不到。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const WEB = resolve(import.meta.dir, "../web");

// 收集 src 下所有源码文件
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

// TS/TSX：只取 bare import。相对路径、@/ 别名、node: 内置都要排除
const BARE_IMPORT =
  /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

// CSS：@import / @plugin / @source 后面跟引号包的，同样是包引用。
// tailwindcss / tw-animate-css 这类顶层构建器不归包管，跳过。
const CSS_AT_RULE = /@(?:import|plugin|source)\s+["']([^"']+)["']/g;
const CSS_BUILTIN = new Set(["tailwindcss", "tw-animate-css", "tailwindcss/preflight"]);

const declared = new Set<string>();
const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8"));
for (const group of ["dependencies", "devDependencies", "peerDependencies"]) {
  for (const name of Object.keys(pkg[group] ?? {})) declared.add(name);
}

const used = new Map<string, Set<string>>();
const record = (spec: string, file: string) => {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) return;
  if (spec.startsWith("node:")) return;
  // 只取包名，忽略子路径（@radix-ui/react-dialog → @radix-ui/react-dialog）
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  if (!used.has(name)) used.set(name, new Set());
  used.get(name)!.add(file.replace(WEB + "\\", "").replace(WEB + "/", ""));
};

const files = walk(join(WEB, "src"));
// vite.config.ts 在 src/ 之外，但它同样 import 外部包（tailwindcss、vite、插件）
const viteConfig = join(WEB, "vite.config.ts");
if (existsSync(viteConfig)) files.push(viteConfig);

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(BARE_IMPORT)) {
    const spec = m[1] ?? m[2];
    if (spec) record(spec, file);
  }
  // .ts 文件不会含 CSS at-rule，但同一循环里处理省一次目录扫描
  for (const m of src.matchAll(CSS_AT_RULE)) {
    if (CSS_BUILTIN.has(m[1]!)) continue;
    record(m[1]!, file);
  }
}

const missing = [...used.keys()].filter((n) => !declared.has(n)).sort();

// ---- compilerOptions.types：类型库也是包依赖 ----
// tsconfig 允许注释，所以用宽松匹配而不是 JSON.parse。
// `vite/client` 这种带子路径的归到包名 `vite`；`node` 对应 `@types/node`。
const missingTypes: string[] = [];
const missingTypePkgs = new Set<string>();
for (const name of readdirSync(WEB).filter((n) => /^tsconfig.*\.json$/.test(n))) {
  const text = readFileSync(join(WEB, name), "utf8");
  for (const m of text.matchAll(/"types"\s*:\s*\[([^\]]*)\]/g)) {
    for (const raw of m[1]!.split(",")) {
      const t = raw.trim().replace(/^["']|["']$/g, "");
      if (!t) continue;
      const pkgName = t.startsWith("@") ? t : t.split("/")[0]!;
      if (declared.has(pkgName) || declared.has(`@types/${pkgName}`)) continue;
      missingTypes.push(`"${t}"（${name}）`);
      missingTypePkgs.add(pkgName.startsWith("@") ? pkgName : `@types/${pkgName}`);
    }
  }
}

console.log(`\n扫描 ${files.length} 个源码文件，引用 ${used.size} 个包`);

if (missingTypes.length > 0) {
  console.log(`\n✗ ${missingTypes.length} 处 types 引用了未声明的类型库（干净环境会报 TS2688）：`);
  for (const t of missingTypes) console.log(`  ${t}`);
  console.log(`  修法：cd web && bun add -d ${[...missingTypePkgs].join(" ")}`);
}

if (missing.length === 0 && missingTypes.length === 0) {
  console.log("✓ 无幽灵依赖：所有 import 与 types 都有对应声明");
  process.exit(0);
}

if (missing.length > 0) {
  console.log(`\n✗ ${missing.length} 个幽灵依赖（CI 上会报 TS2307）：\n`);
  for (const name of missing) {
    const files = [...used.get(name)!];
    console.log(`  ${name}`);
    for (const f of files.slice(0, 3)) console.log(`      ${f}`);
    if (files.length > 3) console.log(`      …另有 ${files.length - 3} 处`);
  }
  console.log(`\n修法：cd web && bun add ${missing.join(" ")}`);
}
process.exit(1);
