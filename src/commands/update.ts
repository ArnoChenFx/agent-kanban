/**
 * `agent-kanban update` —— 从 GitHub Release 自更新二进制。
 *
 * 只对 Releases 分发的单文件二进制有意义；源码与 Docker 模式打印对应
 * 的升级方式后直接返回（不报错——这是信息性输出，不是失败）。
 *
 * 校验链：release tag 与本地版本比较 → 下载平台资产 → 与 CI 发布的
 * .sha256 比对 → 原地替换（保留 .old 供回滚）。任一环节失败都不会动
 * 现有二进制。
 */

import { ExitCode, type ExitCodeValue } from "../core/errors.ts";
import { style } from "../core/format.ts";
import { readPackageVersion } from "../core/version.ts";
import {
  applyUpdate,
  compareVersions,
  DEFAULT_UPDATE_REPO,
  downloadToBuffer,
  fetchLatestRelease,
  isCompiledBinary,
  parseChecksum,
  resolveAssetName,
  resolveUpdateRepo,
  sha256Hex,
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
  2  --check found an update available

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
    throw new Error(`release ${release.tag} does not contain ${assetName} and its .sha256; assets: ${release.assets.map((a) => a.name).join(", ") || "(none)"}`);
  }

  out.line(`downloading ${assetName} (${release.tag}) ...`);
  const binary = await downloadToBuffer(asset.browser_download_url);
  const checksumRaw = await downloadToBuffer(sumAsset.browser_download_url);
  const checksum = parseChecksum(new TextDecoder().decode(checksumRaw));
  // 校验文件里记录的文件名与资产一致,防止拿错 checksum
  if (checksum.file && checksum.file !== assetName) {
    throw new Error(`checksum file records ${checksum.file}, expected ${assetName}`);
  }
  const actual = sha256Hex(binary);
  if (actual !== checksum.digest) {
    throw new Error(`checksum mismatch for ${assetName}: expected ${checksum.digest}, got ${actual}`);
  }

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
