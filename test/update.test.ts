/**
 * 自更新的纯逻辑部分：版本比较、资产映射、checksum、release 解析、
 * 原地替换。全部不碰网络——fetch 注入假实现,替换在临时目录里做。
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../src/core/update.ts";

describe("compareVersions", () => {
  test("same version is 0, v prefix ignored", () => {
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
    expect(compareVersions("v0.1.5", "0.1.5")).toBe(0);
  });

  test("numeric fields compare numerically, not lexically", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("10.0.0", "9.0.0")).toBe(1);
  });

  test("prerelease is lower than the release", () => {
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBe(1);
  });

  test("prerelease identifiers compare per segment, numeric first", () => {
    expect(compareVersions("0.2.0-rc.1", "0.2.0-rc.2")).toBe(-1);
    expect(compareVersions("0.2.0-rc.2", "0.2.0-rc.10")).toBe(-1);
    expect(compareVersions("0.2.0-alpha", "0.2.0-beta")).toBe(-1);
    // semver: 数值标识符 < 字母标识符
    expect(compareVersions("0.2.0-1", "0.2.0-alpha")).toBe(-1);
    expect(compareVersions("0.2.0-rc.1.1", "0.2.0-rc.1")).toBe(1);
  });

  test("unparsable versions throw instead of silently comparing", () => {
    expect(() => compareVersions("abc", "1.0.0")).toThrow("unparsable");
    expect(() => compareVersions("1.0", "1.0.0")).toThrow("unparsable");
  });
});

describe("resolveAssetName", () => {
  test("maps platform/arch to the release matrix", () => {
    expect(resolveAssetName("linux", "x64")).toBe("agent-kanban-linux-x64");
    expect(resolveAssetName("darwin", "x64")).toBe("agent-kanban-darwin-x64");
    expect(resolveAssetName("darwin", "arm64")).toBe("agent-kanban-darwin-arm64");
    expect(resolveAssetName("win32", "x64")).toBe("agent-kanban-windows-x64.exe");
  });

  test("linux-arm64 has no binary (workflow does not build it)", () => {
    expect(() => resolveAssetName("linux", "arm64")).toThrow("Docker");
  });

  test("unknown platforms are refused", () => {
    expect(() => resolveAssetName("freebsd", "x64")).toThrow("freebsd/x64");
    expect(() => resolveAssetName("linux", "riscv64")).toThrow("linux/riscv64");
  });
});

describe("isCompiledBinary", () => {
  test("bun itself means running from source", () => {
    expect(isCompiledBinary("/usr/local/bin/bun")).toBe(false);
    expect(isCompiledBinary("C:\\tools\\bun.exe")).toBe(false);
    expect(isCompiledBinary("/some/path/bun-debug")).toBe(false);
  });

  test("any other name is a compiled binary", () => {
    expect(isCompiledBinary("/usr/local/bin/agent-kanban")).toBe(true);
    expect(isCompiledBinary("C:\\bin\\agent-kanban-windows-x64.exe")).toBe(true);
  });
});

describe("parseChecksum and sha256Hex", () => {
  test("parses the sha256sum output format", () => {
    const { digest, file } = parseChecksum(
      "0f1a65cd4e1b8f0b6a2c8e5d7f9a3b1c4e6d8f0a2b4c6e8d0f2a4b6c8d0e2f4a  agent-kanban-linux-x64\n",
    );
    expect(digest).toBe("0f1a65cd4e1b8f0b6a2c8e5d7f9a3b1c4e6d8f0a2b4c6e8d0f2a4b6c8d0e2f4a");
    expect(file).toBe("agent-kanban-linux-x64");
  });

  test("uppercase hex is normalized, missing filename tolerated", () => {
    const { digest, file } = parseChecksum("0F1A65CD4E1B8F0B6A2C8E5D7F9A3B1C4E6D8F0A2B4C6E8D0F2A4B6C8D0E2F4A");
    expect(digest).toBe("0f1a65cd4e1b8f0b6a2c8e5d7f9a3b1c4e6d8f0a2b4c6e8d0f2a4b6c8d0e2f4a");
    expect(file).toBe(null);
  });

  test("rejects empty or non-hex content", () => {
    expect(() => parseChecksum("\n  \n")).toThrow("empty");
    expect(() => parseChecksum("nothex  file")).toThrow("sha256");
  });

  test("sha256Hex matches a well-known digest vector", () => {
    // sha256("") 的公认值
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("fetchLatestRelease", () => {
  const releaseBody = {
    tag_name: "v0.2.0",
    html_url: "https://github.com/ArnoChenFx/agent-kanban/releases/tag/v0.2.0",
    assets: [
      { name: "agent-kanban-linux-x64", browser_download_url: "https://example.com/bin" },
      { name: "agent-kanban-linux-x64.sha256", browser_download_url: "https://example.com/sum" },
      { name: "source.zip", browser_download_url: "https://example.com/src" },
    ],
  };

  const okFetch = (body: unknown, status = 200): typeof fetch =>
    ((_url: unknown, init?: RequestInit) => {
      void init;
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch;

  test("parses tag and asset list", async () => {
    const release = await fetchLatestRelease(DEFAULT_UPDATE_REPO, okFetch(releaseBody));
    expect(release.tag).toBe("v0.2.0");
    expect(release.assets).toHaveLength(3);
    expect(release.assets[0]).toEqual({
      name: "agent-kanban-linux-x64",
      browser_download_url: "https://example.com/bin",
    });
  });

  test("404 means no releases yet, 403 means rate limited", async () => {
    expect(fetchLatestRelease("x/y", okFetch({}, 404))).rejects.toThrow("no published release");
    expect(fetchLatestRelease("x/y", okFetch({}, 403))).rejects.toThrow("rate limit");
  });

  test("malformed bodies are rejected, not partially trusted", async () => {
    expect(fetchLatestRelease("x/y", okFetch({}))).rejects.toThrow("tag_name");
    expect(fetchLatestRelease("x/y", okFetch({ tag_name: "v1.0.0" }))).rejects.toThrow("assets");
  });

  test("a rejected token (401) falls back to an anonymous request", async () => {
    const savedToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_expired";
    try {
      const calls: (string | undefined)[] = [];
      const authThenAnon = ((_url: unknown, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push(headers.Authorization);
        if (headers.Authorization) {
          return Promise.resolve(new Response("bad token", { status: 401 }));
        }
        return Promise.resolve(new Response(JSON.stringify(releaseBody), { status: 200 }));
      }) as typeof fetch;

      const release = await fetchLatestRelease(DEFAULT_UPDATE_REPO, authThenAnon);
      expect(release.tag).toBe("v0.2.0");
      expect(calls).toEqual([expect.stringMatching(/^Bearer ghp_expired$/), undefined]);
    } finally {
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
    }
  });

  test("downloadToBuffer surfaces HTTP errors with the URL", async () => {
    const failing = ((_url: unknown) =>
      Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch;
    expect(downloadToBuffer("https://example.com/bin", failing)).rejects.toThrow("HTTP 404");
  });
});

describe("resolveUpdateRepo", () => {
  test("env override wins, empty string falls back to default", () => {
    expect(resolveUpdateRepo({})).toBe(DEFAULT_UPDATE_REPO);
    expect(resolveUpdateRepo({ KANBAN_UPDATE_REPO: "me/fork" })).toBe("me/fork");
    expect(resolveUpdateRepo({ KANBAN_UPDATE_REPO: "  " })).toBe(DEFAULT_UPDATE_REPO);
  });
});

describe("applyUpdate", () => {
  test("replaces in place, keeps the old binary as .old", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-update-"));
    const exe = join(dir, "agent-kanban");
    writeFileSync(exe, "old-binary");

    const { exePath, backupPath } = applyUpdate({ exePath: exe, binary: new TextEncoder().encode("new-binary") });
    expect(exePath).toBe(exe);
    expect(backupPath).toBe(`${exe}.old`);
    expect(readFileSync(exe, "utf8")).toBe("new-binary");
    expect(readFileSync(`${exe}.old`, "utf8")).toBe("old-binary");
    expect(existsSync(`${exe}.new`)).toBe(false);
  });

  test("a stale .old from a previous run does not block the update", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-update-"));
    const exe = join(dir, "agent-kanban");
    writeFileSync(exe, "current");
    writeFileSync(`${exe}.old`, "stale-from-last-time");

    applyUpdate({ exePath: exe, binary: new TextEncoder().encode("next") });
    expect(readFileSync(exe, "utf8")).toBe("next");
    expect(readFileSync(`${exe}.old`, "utf8")).toBe("current");
  });
});
