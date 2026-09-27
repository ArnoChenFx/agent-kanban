// 校验一键安装脚本：静态约定 + 端到端真跑一遍。
//
// 分两部分，缺一不可：
//   1. 静态：资产名与 release.yml matrix 对账、装的是用户级目录、不用 sudo、文案无中文。
//      这些错了不影响运行，只会让用户下错文件、装到要提权的地方、或者看不懂输出。
//   2. 功能：起一个本地假 Releases，真跑一遍脚本，断言文件落盘、**可执行位真的置上了**、
//      重跑幂等、期间没有任何外网请求。
//      可执行位是 chmod 漏掉时唯一的症状——文件在、路径对、脚本退出码 0，
//      但用户第一次运行就 Permission denied。静态检查看不出这个。
//
// 跑法：bun run verify:install（已登记进 verify:all.ts 与 ci.yml）
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SH = join(ROOT, "install", "install.sh");
const PS1 = join(ROOT, "install", "install.ps1");
const POSIX_ASSET = "agent-kanban-linux-x64";
const WINDOWS_ASSET = "agent-kanban-windows-x64.exe";

// ⚠ 必须用**异步** spawn，不能用 spawnSync。
//   假 Releases 就跑在**本进程**里（Bun.serve），而 spawnSync 会同步阻塞事件循环：
//   子进程发 HTTP 请求过来时没人应答，双方互等到超时——第一次跑就是卡死在这里。
//   （Bun 1.4.2 实测：spawnSync + 进程内 server = 死锁，不是慢，是永远不返回。）
const runProcess = (cmd: string, args: string[], env: Record<string, string>) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    // 兜底超时：脚本若因为下载不通而挂在 curl 上，CI 上会变成一个 6 小时的 job。
    const guard = setTimeout(() => child.kill(), 60_000);
    child.on("close", (status) => {
      clearTimeout(guard);
      resolveRun({ status, stdout, stderr });
    });
  });

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

// ⚠ 读文件一律归一化换行符。
//   Windows runner 上 git 的 core.autocrlf 默认为 true，checkout 出来是 CRLF。
//   本脚本是行结构正则（/^#!\/usr\/bin\/env bash/m、/^[ \t]+/m），CRLF 下会整段失配——
//   本机和 Linux CI 全绿，只有 Windows 报红。与 verify-deploy.ts 开头同一个坑。
const readText = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

console.log("=== 文件存在与基本形态 ===");
check("install.sh 存在", existsSync(SH), SH);
check("install.ps1 存在", existsSync(PS1), PS1);
if (fails > 0) {
  console.log(`\n✗ ${fails} 项失败`);
  process.exit(1);
}

const sh = readText(SH);
const ps1 = readText(PS1);

check("install.sh 有 shebang", /^#!\/usr\/bin\/env bash/.test(sh));
check("install.sh 以 set -euo pipefail 开头（紧跟 shebang 之后可有空行/注释）", /set -euo pipefail/.test(sh));
check("install.ps1 设了 ErrorActionPreference", /ErrorActionPreference\s*=\s*'Stop'/.test(ps1));
check("两个文件都无 tab 缩进", !/^\t/m.test(sh) && !/^\t/m.test(ps1));
check("两个文件都无行尾空格", !/ +$/m.test(sh) && !/ +$/m.test(ps1));

// ---- 界面文案必须全英文 ----
// 与 verify-workflows.ts 对 workflow 全文、verify-deploy.ts 对 compose/.env 的
// 同一条规定：面向用户的字符串是英文，中文只允许出现在注释里。所以这里检查的是
// 「非注释行」，不能全文扫描（注释里的中文是仓库既定风格，是预期的）。
const userFacingLines = (text: string) =>
  text
    .split("\n")
    .map((l, i) => ({ l, i }))
    // 去掉纯注释行；行尾注释留着（其中的中文多半还是在解释逻辑，但要尽量避免）
    .filter(({ l }) => {
      const t = l.trim();
      if (t.startsWith("#")) return false;
      return !/\s#\s/.test(t);
    });
for (const [name, text] of [
  ["install.sh", sh],
  ["install.ps1", ps1],
] as const) {
  const offenders = userFacingLines(text)
    .filter(({ l }) => /[一-鿿]/.test(l))
    .map(({ l, i }) => `${i + 1}: ${l.trim().slice(0, 50)}`);
  check(`${name} 界面文案无中文（注释可以有）`, offenders.length === 0, offenders.slice(0, 3).join(" | "));
}

console.log("\n=== 用户级安装，不提权 ===");
// 用户级安装的整个意义就是不需要 sudo。哪天有人为了让脚本"更稳"加了 sudo，
// CI 上以非 root 跑会直接失败，而且用户会以为是脚本坏了。
check("install.sh 不出现 sudo", !/(^|[^a-zA-Z])sudo(\s|$)/.test(sh.replace(/^.*#.*$/gm, "")));
check("install.ps1 不提管理员", !/RunAsAdministrator|-Verb\s+RunAs/i.test(ps1));
check("macOS/Linux 装到 ~/.local/bin", /\$\{AGENT_KANBAN_INSTALL_DIR:-\$HOME\/\.local\/bin\}/.test(sh));
check("Windows 装到 LOCALAPPDATA", /AGENT_KANBAN_INSTALL_DIR[\s\S]{0,200}LOCALAPPDATA/.test(ps1));
check("Linux arm64 显式报错而非退回 x86", /no Linux %s binary is published/.test(sh));
check("Windows 非 x64 显式报错", /only windows-x64/.test(ps1));

console.log("\n=== Windows 只改用户级 PATH ===");
// 写 HKLM 需要管理员，非管理员终端会整个失败——这是选「仅用户级」的原因。
// 这里守住它，免得有人后来"顺手"改成机器级。
check("读的是 User 作用域 PATH", /GetEnvironmentVariable\(\s*'Path',\s*'User'\s*\)/.test(ps1));
check("写的是 User 作用域 PATH", /SetEnvironmentVariable\(\s*'Path',\s*[\w$]+,\s*'User'\s*\)/.test(ps1));
check("不碰 Machine 作用域", !/'Machine'/.test(ps1));
check("PATH 追加幂等（先判存在）", /already on your user PATH/.test(ps1));
check("install.sh PATH 追加幂等（先判存在）", /already on your PATH|already has a PATH entry/.test(sh));

console.log("\n=== 与 release.yml 对账 ===");
const releaseYml = readText(join(ROOT, ".github", "workflows", "release.yml"));
// 权威来源是 release job 里的 assets 列表：release.yml matrix 的 asset 字段。
// 平台数、命名都以那里为准。
const releaseAssets = [
  ...new Set(
    [...releaseYml.matchAll(/^[ \t]*- target: bun-[\w-]+[\s\S]*?[ \t]*asset:\s*(\S+)/gm)].map((m) => m[1]!),
  ),
];
check("release.yml 里取到 4 个资产名", releaseAssets.length === 4, releaseAssets.join(", "));

// 安装脚本里出现的资产名（只认完整的 agent-kanban-* 字面量）。
const scriptAssets = [
  ...new Set(
    [...`${sh}\n${ps1}`.matchAll(/\bagent-kanban-(?:linux|darwin|windows)-[a-z0-9]+(?:\.exe)?\b/g)].map((m) => m[0]),
  ),
];
const missingInScripts = releaseAssets.filter((a) => !scriptAssets.includes(a));
const extraInScripts = scriptAssets.filter((a) => !releaseAssets.includes(a));
// 改名时这里是唯一会红的地方：脚本引用了一个不存在的资产（或漏了新平台），
// 而两边各自看都没问题——只有对着看才知道资产名对不上。
check(
  "安装脚本覆盖全部发布资产",
  missingInScripts.length === 0,
  missingInScripts.length ? `漏：${missingInScripts.join(", ")}` : `${scriptAssets.length} 个`,
);
check("安装脚本不多引不存在的资产", extraInScripts.length === 0, extraInScripts.join(", "));

// ---- 仓库 slug 一致 ----
// 拼错 slug 的话，脚本会安安静静地从别人的仓库下东西装到 PATH 上。
const composeImg = /image:\s*"?ghcr\.io\/([\w.\/-]+)/.exec(readText(join(ROOT, "docker-compose.yml")))?.[1] ?? "";
const shSlug = /REPO_SLUG="([^"]+)"/.exec(sh)?.[1] ?? "";
const psSlug = /\$RepoSlug\s*=\s*'([^']+)'/.exec(ps1)?.[1] ?? "";
check("install.sh 的 slug 与 git remote 一致", shSlug === "ArnoChenFx/agent-kanban", shSlug);
check("install.ps1 的 slug 与 install.sh 一致", psSlug === shSlug, psSlug);
check(
  "Docker 镜像坐标（报错文案里引导的替代方案）全小写",
  composeImg.length > 0 && composeImg === composeImg.toLowerCase(),
  composeImg,
);
// compose 里写的是 `image: ghcr.io/<repo>:latest`，带 tag；脚本里的镜像常量
// 同样是带 tag 的完整串（它要直接当 docker 命令用），所以只比前两段仓库路径。
// 变量名两边不一样：install.sh 用 bash 的 DOCKER_IMAGE，install.ps1 用 PowerShell
// 的 $DockerImage —— 正则要跟着各自真实的写法。
const composeRepo = composeImg.split("/").slice(0, 2).join("/");
const shDockerRepo = (/DOCKER_IMAGE="ghcr\.io\/([^"]+)"/.exec(sh)?.[1] ?? "").split(":")[0]!;
const psDockerRepo = (/\$DockerImage\s*=\s*'ghcr\.io\/([^']+)'/.exec(ps1)?.[1] ?? "").split(":")[0]!;
check(
  "install.sh 的 Docker 镜像仓库与 compose 一致",
  shDockerRepo === composeRepo && shDockerRepo !== "",
  `${shDockerRepo} vs ${composeRepo}`,
);
check("install.ps1 的 Docker 镜像仓库与 install.sh 一致", psDockerRepo === shDockerRepo, psDockerRepo);

console.log("\n=== 可测性覆盖项 ===");
// 门禁靠这三个变量把下载指向本地假 server。没有它们，功能测试就必须联网，
// 而 CI 断网/限流时的失败会被误读成脚本坏了。
for (const v of ["AGENT_KANBAN_DOWNLOAD_BASE", "AGENT_KANBAN_VERSION", "AGENT_KANBAN_INSTALL_DIR"]) {
  check(`install.sh 支持 ${v}`, sh.includes(v));
  check(`install.ps1 支持 ${v}`, ps1.includes(v));
}
check("install.sh 支持跳过 PATH 写入", sh.includes("AGENT_KANBAN_SKIP_PATH"));
check("install.ps1 支持跳过 PATH 写入", ps1.includes("AGENT_KANBAN_SKIP_PATH"));

// ---------------------------------------------------------------------------
// 端到端：起一个假 Releases，真跑一遍脚本
// ---------------------------------------------------------------------------
console.log(`\n=== 端到端（${process.platform}）===`);

const sandbox = mkdtempSync(join(tmpdir(), "ak-install-"));

// 假 Releases 返回的是**真可执行文件**：拿一段两行的 TS 现编一个 stub。
// 之前这里返回的是一段文本，于是 Windows 上 `& $target --version` 报
// "not a valid application for this OS platform"；换成 shell 脚本的话，
// macOS/Linux 分支又会 Permission denied（chmod 0755 只给二进制文件有用）。
// 也就是说文本方案在任何一个平台都验不到"装完即用"这条断言。
// 用 bun 自己编出来的单文件二进制，三个平台都真的能跑，编译一次 ~0.2s。
// 只在本平台编译并只在本平台断言：CI 是三平台矩阵，各跑各的。
const STUB_SRC = 'console.log("agent-kanban 0.0.0-fake");\n';
// `bun build -` 不认 stdin（"ModuleNotFound resolving \"-\""），所以先落一个源文件。
const stubSrcPath = join(sandbox, "stub.ts");
writeFileSync(stubSrcPath, STUB_SRC);
// ⚠ Windows 上 `bun build --outfile stub.bin` 实际写出的是 **stub.bin.exe**
//   （它按 Windows 可执行文件惯例补扩展名），而 Linux/macOS 写出的就是 stub.bin。
//   写死 stub.bin 会在 Windows 上 ENOENT——CI 矩阵里正好有一半是 Windows。
const stubOut = join(sandbox, process.platform === "win32" ? "stub.bin.exe" : "stub.bin");
const stub = Bun.spawnSync(["bun", "build", "--compile", "--outfile", stubOut, stubSrcPath]);
if (stub.exitCode !== 0 || !existsSync(stubOut)) {
  console.log(`✗ 编不出 stub 二进制：${stub.stderr.toString()}`);
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}
const FAKE_SIZE = statSync(stubOut).size;

const requestedPaths: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    requestedPaths.push(path);
    // 发布矩阵里的**所有**资产都发同一个内容：具体落到哪个资产取决于 runner
    // 的架构（macos-latest 是 arm64，ubuntu/windows 是 x64），只发一个会让
    // macOS CI 因为"下载 404"整个红掉。
    // 其余路径一律 404，用来验证"下载 URL 拼错会干净地失败"。
    if (releaseAssets.some((a) => path === `/${a}`)) {
      return new Response(Bun.file(stubOut), { headers: { "content-type": "application/octet-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;

const env = {
  ...process.env,
  AGENT_KANBAN_DOWNLOAD_BASE: base,
  // 门禁绝不能改开发者自己的 shell 配置：用一次性临时目录，写进 ~/.bashrc
  // 的话下次开 shell 就多一条指向已删除目录的 PATH。
  AGENT_KANBAN_SKIP_PATH: "1",
};

// 两个脚本各有一个"要装到哪"的变量，共用一个沙箱根但用不同子目录，
// 免得后一个把前一个的产物当成自己的已安装文件（会掩盖"没真的落盘"）。
const runShell = async () => {
  const dir = join(sandbox, "sh-bin");
  const r = await runProcess("bash", [SH], {
    ...env,
    AGENT_KANBAN_INSTALL_DIR: dir,
    HOME: sandbox,
    SHELL: "/bin/bash",
  });
  return { r, dir, target: join(dir, "agent-kanban") };
};

const runPowerShell = async () => {
  const dir = join(sandbox, "ps-bin");
  const r = await runProcess(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1],
    { ...env, AGENT_KANBAN_INSTALL_DIR: dir },
  );
  return { r, dir, target: join(dir, "agent-kanban.exe") };
};

const tail = (r: { status: number | null; stderr: string }) =>
  (r.stderr ?? "").split("\n").filter((l) => l.trim()).slice(-3).join(" | ");

// 失败时把脚本自己的输出整段打出来：PowerShell 的错误可能落在 stdout
// （Write-Error / 管道），只看 stderr 会得到一个空的 detail 字段，
// 于是"退出码非 0"变成了没有线索的红。
const dump = (r: { status: number | null; stdout: string; stderr: string }) => {
  if (r.status === 0) return "";
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").filter((l) => l.trim()).slice(-12);
  return "\n    " + out.join("\n    ");
};

try {
  // ---------------------------------------------------------------------------
  // 真跑。macOS/Linux 用 install.sh，Windows 用 install.ps1；CI 是三平台矩阵
  // （.github/workflows/ci.yml 的 test job），所以哪个平台都能覆盖自己那份。
  // ---------------------------------------------------------------------------
  const isWindows = process.platform === "win32";
  const run = isWindows ? runPowerShell : runShell;
  const label = isWindows ? "install.ps1" : "install.sh";
  // install.sh 选资产靠 uname，所以"预期请求了哪个"得跟着 runner 架构算；
  // install.ps1 的资产是写死的。断言请求路径就是想守住这一点：改映射逻辑时
  // 错拼一个资产名，下载会 404，用户拿到的是一个装不上的脚本。
  const asset = isWindows
    ? `/${WINDOWS_ASSET}`
    : process.arch === "arm64"
      ? `/${POSIX_ASSET.replace("linux", "darwin").replace("x64", "arm64")}`
      : `/${POSIX_ASSET}`;

  // ---- 1. 首次安装 ----
  requestedPaths.length = 0;
  const first = await run();
  check(`${label} 退出码 0`, first.r.status === 0, tail(first.r) + dump(first.r));
  check(`${label} 二进制落到安装目录`, existsSync(first.target), first.target);
  if (existsSync(first.target)) {
    // 落盘内容必须与服务端一致：下到 404 页面时文件照样存在、脚本照样退出 0，
    // 只有比对内容/大小才看得出来。
    const got = statSync(first.target).size;
    check(
      `${label} 落盘内容与下载一致（没下到 404 页）`,
      got === FAKE_SIZE,
      `装到 ${got} 字节，假资产 ${FAKE_SIZE} 字节`,
    );
  }
  // Unix 上还要验可执行位：chmod 漏掉时这就是唯一的症状——文件在、路径对、
  // 退出码 0，但用户第一次运行就 Permission denied。静态检查看不出这个。
  if (!isWindows) {
    check(`${label} 可执行位已置上`, (statSync(first.target).mode & 0o111) !== 0, `mode=${(statSync(first.target).mode & 0o777).toString(8)}`);
  }
  check(`${label} 结尾跑过 --version（装完即用）`, (first.r.stdout ?? "").includes("0.0.0-fake"), (first.r.stdout ?? "").trim().split("\n").pop() ?? "");
  // 只有一个请求，且就是那个资产——"下载 URL 拼错"在这里是静默的：
  // 请求会打到 404，脚本失败，但错误信息指向网络而不是 URL 拼错。
  check(`${label} 只请求了本地假 server 上的目标资产`, requestedPaths.length === 1 && requestedPaths[0] === asset, `预期 ${asset}，实际 ${requestedPaths.join(", ") || "(无请求)"}`);

  // ---- 2. 重跑幂等（这就是"升级"的路径）----
  requestedPaths.length = 0;
  const again = await run();
  check(`${label} 重跑仍退出 0`, again.r.status === 0, tail(again.r) + dump(again.r));
  check(`${label} 重跑后二进制仍在`, existsSync(again.target));
  check(`${label} 重跑重新下载一次`, requestedPaths.length === 1, requestedPaths.join(", "));

  // ---- 3. 下载地址失效时必须失败，而不是留下一个坏文件 ----
  const broken = isWindows
    ? await runProcess("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1], {
        ...env,
        AGENT_KANBAN_INSTALL_DIR: join(sandbox, "ps-bad"),
        AGENT_KANBAN_DOWNLOAD_BASE: `${base}/nope`,
      })
    : await runProcess("bash", [SH], {
        ...env,
        AGENT_KANBAN_INSTALL_DIR: join(sandbox, "sh-bad"),
        AGENT_KANBAN_DOWNLOAD_BASE: `${base}/nope`,
        HOME: sandbox,
        SHELL: "/bin/bash",
      });
  const badTarget = join(sandbox, isWindows ? "ps-bad" : "sh-bad", isWindows ? "agent-kanban.exe" : "agent-kanban");
  check(`${label} 下载 404 时报错而非静默成功`, `${broken.stdout}${broken.stderr}`.trim().length > 0);
  check(`${label} 下载 404 时不装坏文件`, !existsSync(badTarget), badTarget);
} finally {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${fails === 0 ? "✓ 安装脚本校验全部通过" : `✗ ${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
