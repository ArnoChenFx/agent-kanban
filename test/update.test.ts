/**
 * 自更新的纯逻辑部分：版本比较、资产映射、checksum、release 解析、
 * 原地替换。全部不碰网络——fetch 注入假实现,替换在临时目录里做。
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  verifyChecksum,
} from "../src/core/update.ts";
import { cmdUpdate } from "../src/commands/update.ts";
import { KanbanError } from "../src/core/errors.ts";

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

  // 真实事故（v0.1.8 自更新在 Windows 上必坏）：Windows runner 的 sha256sum
  // 走二进制模式，文件名带 `*` 前缀，而 Linux / macOS 是两个空格的文本模式。
  // 下面是 v0.1.8 真实的 agent-kanban-windows-x64.exe.sha256 原文。
  test("GNU binary-mode '*' prefix is stripped (v0.1.8 windows asset)", () => {
    const real = "862733062d0d1899652a4e3f9d1908b9992ce73ae6538b25efd3a9a7e7b788ad *agent-kanban-windows-x64.exe\n";
    expect(parseChecksum(real)).toEqual({
      digest: "862733062d0d1899652a4e3f9d1908b9992ce73ae6538b25efd3a9a7e7b788ad",
      file: "agent-kanban-windows-x64.exe",
    });
  });

  test("CRLF and a leading ./ are tolerated", () => {
    const digest = "0f1a65cd4e1b8f0b6a2c8e5d7f9a3b1c4e6d8f0a2b4c6e8d0f2a4b6c8d0e2f4a";
    expect(parseChecksum(`${digest} *./agent-kanban-darwin-arm64\r\n`).file).toBe("agent-kanban-darwin-arm64");
    expect(parseChecksum(`${digest}  ./agent-kanban-linux-x64\r\n`).file).toBe("agent-kanban-linux-x64");
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

describe("verifyChecksum", () => {
  const binary = new TextEncoder().encode("fake-binary-bytes");
  const digest = sha256Hex(binary);

  test("accepts the real windows .sha256 (binary-mode '*' marker)", () => {
    // 这份 checksum 记录的 digest 是 v0.1.8 真实 .exe 的，内容换成假字节
    // 只为了让断言跑得快；关键是**文件名**能被正确识别并对上资产名。
    const { file } = parseChecksum(
      "862733062d0d1899652a4e3f9d1908b9992ce73ae6538b25efd3a9a7e7b788ad *agent-kanban-windows-x64.exe\n",
    );
    expect(file).toBe("agent-kanban-windows-x64.exe");
  });

  test("matching name and digest pass", () => {
    expect(
      verifyChecksum({
        binary,
        checksumContent: `${digest} *agent-kanban-linux-x64\n`,
        assetName: "agent-kanban-linux-x64",
      }).digest,
    ).toBe(digest);
    // 文本模式（两个空格）同样通过
    expect(
      verifyChecksum({
        binary,
        checksumContent: `${digest}  agent-kanban-linux-x64\n`,
        assetName: "agent-kanban-linux-x64",
      }).digest,
    ).toBe(digest);
  });

  test("a name pointing at another asset is refused before the digest is used", () => {
    let err: unknown;
    try {
      verifyChecksum({
        binary,
        checksumContent: `${digest} *agent-kanban-darwin-arm64\n`,
        assetName: "agent-kanban-linux-x64",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KanbanError);
    expect((err as KanbanError).code).toBe(2);
    expect((err as KanbanError).details.reason).toBe("checksum_name_mismatch");
  });

  test("a wrong digest is a state error, not an internal bug", () => {
    const wrong = "0".repeat(64);
    expect(() =>
      verifyChecksum({
        binary,
        checksumContent: `${wrong}  agent-kanban-linux-x64\n`,
        assetName: "agent-kanban-linux-x64",
      }),
    ).toThrow(KanbanError);
    try {
      verifyChecksum({ binary, checksumContent: `${wrong}  agent-kanban-linux-x64\n`, assetName: "agent-kanban-linux-x64" });
    } catch (e) {
      expect((e as KanbanError).code).toBe(2);
      expect((e as KanbanError).details.reason).toBe("checksum_mismatch");
    }
  });
});

describe("cmdUpdate argument guard", () => {
  // 回归：`agent-kanban update check`（少两个横杠）曾经被完整忽略，
  // 于是命令继续往下走，把新二进制下载下来替换掉了正在运行的自己。
  // 守卫必须在**任何网络请求之前**生效——用 fetch 间谍来证明这一点。
  const withFetchSpy = async (fn: () => Promise<unknown>) => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.reject(new Error("network must not be touched"));
    }) as unknown as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
    return calls;
  };

  test("a stray 'check' positional fails as a usage error and never hits the network", async () => {
    let err: unknown;
    const calls = await withFetchSpy(async () => {
      try {
        await cmdUpdate(["check"]);
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(KanbanError);
    expect((err as KanbanError).code).toBe(1);
    expect((err as KanbanError).message).toContain("unexpected argument: check");
    // 最关键的一条：错误信息必须直接教回正确写法
    expect((err as KanbanError).message).toContain("did you mean --check");
    expect(String((err as KanbanError).details.usage)).toContain("--check");
    expect(calls).toBe(0);
  });

  test("any other stray positional is refused too (with the full usage text)", async () => {
    let err: unknown;
    await withFetchSpy(async () => {
      try {
        await cmdUpdate(["oops"]);
      } catch (e) {
        err = e;
      }
    });
    expect((err as KanbanError).code).toBe(1);
    expect(String((err as KanbanError).details.usage)).toContain("Usage: agent-kanban update");
  });

  test("--help and --check are still accepted as options, not positionals", () => {
    // --help 在守卫之前返回（不打网络），断言它不抛用法错误
    expect(cmdUpdate(["--help"])).resolves.toBe(0);
  });
});

describe("applyUpdate", () => {
  test("replaces in place, keeps the old binary as .old", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-update-"));
    const exe = join(dir, "agent-kanban");
    writeFileSync(exe, "old-binary");

    // macOS 的 $TMPDIR 在 /private/var 符号链接后面，applyUpdate 内部会
    // realpath 解析，所以断言必须对齐到解析后的路径（Windows/Linux 上原样返回）
    const resolved = realpathSync(exe);
    const { exePath, backupPath } = applyUpdate({ exePath: exe, binary: new TextEncoder().encode("new-binary") });
    expect(exePath).toBe(resolved);
    expect(backupPath).toBe(`${resolved}.old`);
    expect(readFileSync(resolved, "utf8")).toBe("new-binary");
    expect(readFileSync(`${resolved}.old`, "utf8")).toBe("old-binary");
    expect(existsSync(`${resolved}.new`)).toBe(false);
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
