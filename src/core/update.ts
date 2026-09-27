/**
 * 自更新：从 GitHub Release 下载最新二进制并替换自身。
 *
 * 适用范围：`bun build --compile` 产物（Releases 分发的单文件二进制）。
 * 源码运行与 Docker 不适用——前者走 git pull，后者由镜像 tag 决定版本。
 *
 * 替换策略：正在运行的二进制**不能被覆盖或删除**（Windows 硬限制，POSIX 上
 * 虽然 rename 覆盖可行，但统一走同一条路径便于回滚），所以顺序是：
 *   1. 新二进制写到 <exe>.new 并校验 sha256
 *   2. 正在运行的 <exe> 改名为 <exe>.old（改名对运行中的进程无害）
 *   3. <exe>.new 改名回 <exe>
 * 第 3 步失败时把 .old 改回去；.old 留在原地，下次更新开始时清理。
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { KanbanError } from "./errors.ts";

/** 默认更新源：与 README 的 Releases 链接同源。可用 KANBAN_UPDATE_REPO 覆盖（自建 fork / 镜像） */
export const DEFAULT_UPDATE_REPO = "ArnoChenFx/agent-kanban";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface LatestRelease {
  tag: string;
  html_url: string;
  assets: ReleaseAsset[];
}

/** 仓库坐标：环境变量优先（空串视为未设置） */
export function resolveUpdateRepo(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.KANBAN_UPDATE_REPO?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_UPDATE_REPO;
}

/**
 * 是否以编译产物运行。源码模式下 execPath 是 bun 解释器本身
 * （`bun run src/cli.ts` / `bun test` 都如此），此时自更新无意义。
 */
export function isCompiledBinary(execPath: string = process.execPath): boolean {
  const name = basename(execPath).toLowerCase().replace(/\.exe$/, "");
  return name !== "bun" && name !== "bun-debug";
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * 平台 → Release 资产名。矩阵必须与 .github/workflows/release.yml 保持一致：
 * 只发布 linux-x64 / darwin-x64 / darwin-arm64 / windows-x64 四个。
 */
export function resolveAssetName(platform: string, arch: string): string {
  const os =
    platform === "darwin" ? "darwin" :
    platform === "linux" ? "linux" :
    platform === "win32" ? "windows" : null;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (os === null || cpu === null) {
    throw new Error(`no release binary is published for ${platform}/${arch}; use the Docker image or install from source`);
  }
  if (os === "linux" && cpu === "arm64") {
    throw new Error("no linux-arm64 binary is published; use the Docker image (it resolves the architecture for you)");
  }
  return `agent-kanban-${os}-${cpu}${platform === "win32" ? ".exe" : ""}`;
}

/** 语义化版本比较，忽略 "v" 前缀；prerelease 按标识符逐段比较（数值段按数值） */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa) throw new Error(`unparsable version: ${a}`);
  if (!pb) throw new Error(`unparsable version: ${b}`);
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1; // 正式版 > prerelease
  if (pb.pre === null) return -1;
  const as = pa.pre.split(".");
  const bs = pb.pre.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // semver: 数值标识符 < 字母标识符
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 匿名限额 60 次/小时；GITHUB_TOKEN 可提升（只用于 API，资产下载走免认证的 browser_download_url） */
function apiHeaders(withToken: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-kanban-update",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (withToken && token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * API 请求：带 GITHUB_TOKEN（如已设置）以提高限额，但 token 被 401 拒绝时
 * 退回匿名重试——公开仓库不需要认证，而环境里残留的失效 token 很常见。
 */
async function apiGet(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const hasToken = Boolean(process.env.GITHUB_TOKEN?.trim());
  if (hasToken) {
    const res = await fetchImpl(url, { headers: apiHeaders(true) });
    if (res.status !== 401) return res;
  }
  return fetchImpl(url, { headers: apiHeaders(false) });
}

/**
 * 取最新正式 Release（releases/latest 自动排除 draft 与 prerelease）。
 * fetchImpl 可注入，测试不碰网络。
 */
export async function fetchLatestRelease(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LatestRelease> {
  const res = await apiGet(`https://api.github.com/repos/${repo}/releases/latest`, fetchImpl);
  if (res.status === 404) {
    throw new Error(`no published release found in ${repo}`);
  }
  if (res.status === 403) {
    throw new Error(
      "GitHub API request was rejected (rate limit is 60 requests/hour without a token); set GITHUB_TOKEN or retry later",
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    assets?: unknown;
  };
  if (typeof body.tag_name !== "string" || body.tag_name.length === 0) {
    throw new Error("GitHub API response has no tag_name");
  }
  if (!Array.isArray(body.assets)) {
    throw new Error("GitHub API response has no assets list");
  }
  const assets: ReleaseAsset[] = [];
  for (const raw of body.assets) {
    const a = raw as { name?: unknown; browser_download_url?: unknown };
    if (typeof a.name === "string" && typeof a.browser_download_url === "string") {
      assets.push({ name: a.name, browser_download_url: a.browser_download_url });
    }
  }
  return {
    tag: body.tag_name,
    html_url: typeof body.html_url === "string" ? body.html_url : "",
    assets,
  };
}

/** 下载资产到内存。二进制约 60-100MB；带 User-Agent，不带 Authorization（会跟随 302 到 S3 签名地址） */
export async function downloadToBuffer(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await fetchImpl(url, { headers: { "User-Agent": "agent-kanban-update" } });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 解析 .sha256 文件（"hex  filename" 格式，由 CI 的 sha256sum/shasum 生成）
 *
 * 文件名段有两种写法，必须都认：
 *   文本模式   `<hash>  name`   （两个空格，Linux / macOS runner 实测）
 *   二进制模式 `<hash> *name`   （`*` 前缀，Windows runner 实测）
 * GNU coreutils 用 `*` 标记"按二进制读"；MSYS2 发行版（即 Git Bash 里那个
 * sha256sum）默认就是二进制模式，所以 **只有 Windows 的 .sha256 带 `*`**。
 * 不剥掉它的话，"校验文件名与资产是否一致"这一步在 Windows 上永远失败，
 * 而 digest 本身是对的——v0.1.8 自更新就是这么坏的（用户看到
 * `checksum file records *agent-kanban-windows-x64.exe`）。
 * 顺带剥掉 shasum 可能写出的 `./` 前缀，只留 basename 再比对。
 */
export function parseChecksum(content: string): { digest: string; file: string | null } {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) throw new Error("checksum file is empty");
  const m = line.match(/^([0-9a-fA-F]{64})(?:\s+(.*))?$/);
  if (!m) throw new Error("checksum file does not start with a sha256 hex digest");
  const file = m[2]?.trim().replace(/^\*/, "").trim().replace(/^\.\//, "");
  return { digest: m[1]!.toLowerCase(), file: file && file.length > 0 ? file : null };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 完整校验链：先看 .sha256 里记录的文件名是不是这个资产（防止拿错 checksum），
 * 再比 digest。两个失败都归为 STATE 而不是 INTERNAL——外部发布物不对是
 * 数据问题，重试不会变好，报 INTERNAL 会让调用方以为该上报缺陷。
 *
 * 单独抽出来是为了能脱网测：文件名对不上正是 v0.1.8 在 Windows 上自更新
 * 失败的原因（checksum 文件带 `*` 前缀），而这条链原本埋在命令里，
 * 只有真去下一个 100MB 的包才会暴露。
 */
export function verifyChecksum(opts: {
  binary: Uint8Array;
  checksumContent: string;
  assetName: string;
}): { digest: string } {
  const checksum = parseChecksum(opts.checksumContent);
  if (checksum.file && checksum.file !== opts.assetName) {
    throw KanbanError.state(
      `checksum file records ${checksum.file}, expected ${opts.assetName}`,
      { reason: "checksum_name_mismatch", recorded: checksum.file, expected: opts.assetName },
    );
  }
  const actual = sha256Hex(opts.binary);
  if (actual !== checksum.digest) {
    throw KanbanError.state(
      `checksum mismatch for ${opts.assetName}: expected ${checksum.digest}, got ${actual}`,
      { reason: "checksum_mismatch", asset: opts.assetName, expected: checksum.digest, actual },
    );
  }
  return { digest: checksum.digest };
}

/**
 * 原地替换二进制。exePath 会被 realpath 解析（用户可能经 symlink 调用，
 * 替换 symlink 本身会让指向落空）；失败时回滚改名，原二进制无损。
 * 返回实际写入与备份的路径（realpath 后），供调用方提示用户。
 */
export function applyUpdate(opts: { exePath: string; binary: Uint8Array }): { exePath: string; backupPath: string } {
  const exePath = realpathSync(opts.exePath);
  const newFile = `${exePath}.new`;
  const oldFile = `${exePath}.old`;

  // 上次更新留下的 .old：删不掉（旧版本可能还在跑）就明说，Windows 上
  // renameSync 不接受已存在的目标名，带着它走不下去
  try {
    rmSync(oldFile, { force: true });
  } catch {
    throw new Error(
      `cannot remove the backup file ${oldFile}; the previous version may still be running`,
    );
  }

  writeFileSync(newFile, opts.binary);
  if (process.platform !== "win32") chmodSync(newFile, 0o755);

  try {
    renameSync(exePath, oldFile);
  } catch (err) {
    rmSync(newFile, { force: true });
    throw new Error(`cannot rename the running binary: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    renameSync(newFile, exePath);
  } catch (err) {
    try {
      renameSync(oldFile, exePath);
    } catch {
      // 回滚也失败时,原文件仍在 <exe>.old,提示手动还原
    }
    throw new Error(
      `failed to move the new binary into place: ${err instanceof Error ? err.message : String(err)}` +
        (existsSync(oldFile) ? `; the original binary was restored, or is kept at ${oldFile}` : ""),
    );
  }
  return { exePath, backupPath: oldFile };
}
