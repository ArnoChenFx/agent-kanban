/**
 * `agent-kanban update` —— 从 GitHub Release 自更新二进制。
 *
 * 只对 Releases 分发的单文件二进制有意义；源码与 Docker 模式打印对应
 * 的升级方式后直接返回（不报错——这是信息性输出，不是失败）。
 *
 * 校验链：release tag 与本地版本比较 → 下载平台资产 → 与 CI 发布的
 * .sha256 比对（先对齐文件名、再比 sha256）→ 原地替换（保留 .old 供回滚）。
 * 任一环节失败都不会动现有二进制。
 *
 * `--check` 必须在任何下载之前返回：它只查版本。
 */

import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { style } from "../core/format.ts";
import { readPackageVersion } from "../core/version.ts";
import {
  applyUpdate,
  compareVersions,
  DEFAULT_UPDATE_REPO,
  downloadToBuffer,
  fetchLatestRelease,
  isCompiledBinary,
  resolveAssetName,
  resolveUpdateRepo,
  verifyChecksum,
} from "../core/update.ts";
import { assertKnownOptions, getBool, getString, parseArgs } from "./args.ts";
import { createOutput } from "./output.ts";

const USAGE = `Usage: agent-kanban update [--check] [--repo <owner/name>]

Download the latest release binary from GitHub Releases and replace the running
executable. Only meaningful for the single-binary install; when running from
source or in Docker, this command prints how to update instead.

The latest non-prerelease release is fetched from the GitHub API. The new binary
is checksum-verified against the published .sha256 file before replacing the
current one. The previous binary is kept next to it as <name>.old for manual
rollback, and is cleaned up on the next successful update.

Options:
  --check          Compare versions only, do not download; exits 2 when an update is available
  --repo <o/n>     GitHub repository to update from (default: ${DEFAULT_UPDATE_REPO})

Exit codes:
  0  Up to date, updated successfully, or running from source/Docker (informational)
  1  Bad arguments; this command takes no positional arguments (note the two dashes in --check)
  2  --check found an update available, or the release failed checksum verification

Environment:
  GITHUB_TOKEN         Optional; raises the GitHub API rate limit (60 requests/hour anonymous)
  KANBAN_UPDATE_REPO   Default repository, same as --repo

Examples:
  agent-kanban update --check    # what version would we move to?
  agent-kanban update            # download, verify, replace`;

export async function cmdUpdate(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "check", "help"],
    strings: ["repo"],
    short: { h: "help" },
  });
  assertKnownOptions(args, ["json", "check", "help", "repo"]);

  // ---- 位置参数守卫：必须是第一条会失败的路径（在任何网络请求与下载之前）----
  //
  // `update` 不接受位置参数，而 `assertKnownOptions` 只校验 options
  // （`src/commands/args.ts`），少写两个横杠的 `agent-kanban update check`
  // 会把 "check" 收进 positionals、被完整忽略：命令继续往下走，**把 100MB
  // 的新二进制拉下来换掉了正在运行的自己**。一次"只想看一眼"的命令静默
  // 变成破坏性操作，比报个错糟糕得多——所以这里明确报错并给出正确写法。
  //
  // 放在 `isCompiledBinary()` 之前：参数校验是纯本地的，不该被运行方式分支
  // 短路掉（源码模式下 `update check` 同样要报这个错，否则同一条命令的报错
  // 取决于你是从源码跑还是从二进制跑）。
  if (args.positionals.length > 0) {
    const stray = args.positionals[0]!;
    const bare = stray.replace(/^-+/, "");
    // 猜测写成 `did you mean --check?` 而不是接受它：本仓库的规矩是
    // “拼错参数必须被告知”（见 args.ts 开头），而这里错拼的后果是
    // 替换掉正在运行的二进制，宁可让人/agent 改对命令。
    const hint = bare === "check" || bare === "help" ? `--${bare}` : null;
    throw KanbanError.usage(
      hint ? `unexpected argument: ${stray} (did you mean ${hint}?)` : `unexpected argument: ${stray}`,
      // details.usage 要自包含以 "Usage: " 开头（output.ts 靠这个判是否补表头）
      hint ? `Usage: agent-kanban update ${hint}` : USAGE,
    );
  }

  if (getBool(args, "help")) {
    process.stdout.write(USAGE + "\n");
    return ExitCode.OK;
  }

  const json = getBool(args, "json");
  const out = createOutput(json);
  const repo = getString(args, "repo") ?? resolveUpdateRepo();
  const current = readPackageVersion();

  // 源码 / Docker 模式：没有可替换的二进制,给出对应升级方式
  if (!isCompiledBinary()) {
    out.data({ mode: "source", current_version: current, latest_version: null, updated: false });
    out.line(
      `${style.yellow("!")} agent-kanban ${current} is running from source — self-update does not apply.`,
    );
    out.line(`  ${style.gray("Update with: git pull && bun install && bun run build:binary")}`);
    out.line(`  ${style.gray("(in Docker, pull a newer image tag and recreate the container)")}`);
    return ExitCode.OK;
  }

  const release = await fetchLatestRelease(repo);
  const latest = release.tag.replace(/^v/, "");
  const cmp = compareVersions(latest, current);

  if (cmp <= 0) {
    out.data({ mode: "binary", current_version: current, latest_version: latest, updated: false });
    out.line(`${style.green("✓")} agent-kanban is up to date (${current})`);
    return ExitCode.OK;
  }

  if (getBool(args, "check")) {
    out.data({
      mode: "binary",
      current_version: current,
      latest_version: latest,
      update_available: true,
      release_url: release.html_url,
    });
    out.line(`${style.yellow("!")} update available: ${current} -> ${latest}  ${style.gray(release.html_url)}`);
    out.line(`  ${style.gray("Run: agent-kanban update")}`);
    return ExitCode.STATE;
  }

  const assetName = resolveAssetName(process.platform, process.arch);
  const asset = release.assets.find((a) => a.name === assetName);
  const sumAsset = release.assets.find((a) => a.name === `${assetName}.sha256`);
  if (!asset || !sumAsset) {
    // 外部数据不完整属于状态错误，不是程序 bug：报 INTERNAL 会让调用方
    // 当成"我该上报的缺陷"，而它重试多少次都不会变。
    throw KanbanError.state(
      `release ${release.tag} does not contain ${assetName} and its .sha256; assets: ${release.assets.map((a) => a.name).join(", ") || "(none)"}`,
      { reason: "missing_release_asset", tag: release.tag, asset: assetName },
    );
  }

  out.line(`downloading ${assetName} (${release.tag}) ...`);
  const binary = await downloadToBuffer(asset.browser_download_url);
  const checksumRaw = await downloadToBuffer(sumAsset.browser_download_url);
  // 校验链（文件名对齐 + sha256）在 core 里，失败抛 STATE
  verifyChecksum({
    binary,
    checksumContent: new TextDecoder().decode(checksumRaw),
    assetName,
  });

  const exePath = process.execPath;
  const { exePath: installedPath, backupPath } = applyUpdate({ exePath, binary });

  out.data({
    mode: "binary",
    current_version: current,
    latest_version: latest,
    updated: true,
    binary_path: installedPath,
    backup_path: backupPath,
  });
  out.line(`${style.green("✓")} updated agent-kanban: ${current} -> ${latest}`);
  out.line(`  ${style.gray(`previous binary kept as ${backupPath}; delete it once the new version works`)}`);
  return ExitCode.OK;
}
