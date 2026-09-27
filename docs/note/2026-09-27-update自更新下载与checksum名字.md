# update 自更新的两个坑：`update check` 静默下载、Windows checksum 名字对不上（2026-09-27）

> 用户反馈（v0.1.8 二进制）：
>
> ```
> downloading agent-kanban-windows-x64.exe (v0.1.8) ...
> Error[INTERNAL]: checksum file records *agent-kanban-windows-x64.exe, expected agent-kanban-windows-x64.exe
> ```
>
> 两个独立的问题叠在一条命令上：**他敲的是 `agent-kanban update check`（少两个横杠）**，
> 于是真的下载了；而下载完成后又被 Windows 特有的 checksum 格式挡住。
> 任意一个单独修好都能让这次自更新成功——一起修是因为它们都在同一条路径上。

## 一、坑 1：`update check` 不只是"没生效"，它执行了破坏性操作

`parseArgs`（`src/commands/args.ts`）按"有横杠 / 没横杠"分流，而
`assertKnownOptions` **只校验 `args.options`**：

```ts
export function assertKnownOptions(args: ParsedArgs, allowed: string[]): void {
  const bad = Object.keys(args.options).filter((k) => !allowedSet.has(k));
  //                                ↑ positionals 完全不在视野里
}
```

所以 `update check` 里的 `check` 进了 `args.positionals`，`getBool(args, "check")`
拿到 `false`，`--check` 分支整段被跳过，代码一路走到下载 + `applyUpdate`。
`update` 是全项目**唯一会改写 `process.execPath`** 的命令，所以这里"拼错参数"
的代价不是少了个 flag，而是**把正在运行的自己换掉**。

这条最难受的地方在于**它不报错**：用户以为自己只查了版本，实际做了升级。

### 修法

`update` 不接受位置参数，就显式拒绝，并且**排在一切网络请求与副作用之前**：

```ts
if (args.positionals.length > 0) {
  const stray = args.positionals[0]!;
  const bare = stray.replace(/^-+/, "");
  const hint = bare === "check" || bare === "help" ? `--${bare}` : null;
  throw KanbanError.usage(
    hint ? `unexpected argument: ${stray} (did you mean ${hint}?)` : `unexpected argument: ${stray}`,
    hint ? `Usage: agent-kanban update ${hint}` : USAGE,
  );
}
```

几个刻意的小决策：

- **报错而不是把 `check` 当别名接受。** 仓库的既定规矩是"参数拼错必须被告知，
  否则调用方会以为操作成功了"（`args.ts` 开头的注释）。何况这里的错误拼写后果
  是替换掉用户正在运行的程序。
- **排在 `isCompiledBinary()` 之前。** 源码模式下 `execPath` 是 bun，自更新不适用，
  会走"从源码运行"分支提前返回。若守卫放在它后面，`update check` 在源码下会打印
  一句无关的提示、在二进制下才报错——同一条命令两种行为，更难排查。
- **`details.usage` 要自包含地以 `Usage: ` 开头。** `src/commands/output.ts` 靠
  `usage.trimStart().startsWith("Usage:")` 决定要不要补表头，不自包含就会打出
  两行 `Usage:`。

守卫里带一条 **fetch 间谍**（把 `globalThis.fetch` 换成抛错的实现，断言调用数为 0），
这样测的是"报错发生在下载之前"，而不只是"报了个错"——
`test/update.test.ts` 的 `cmdUpdate argument guard` 就是这么钉的。

## 二、坑 2：GNU 的 `*` 二进制模式标记，只有 Windows 有

`parseChecksum` 拿到文件名后直接和资产名比：

```ts
if (checksum.file && checksum.file !== assetName) {
  throw new Error(`checksum file records ${checksum.file}, expected ${assetName}`);
}
```

而 v0.1.8 真实的 `agent-kanban-windows-x64.exe.sha256`（已下载核对）：

```
862733062d0d1899652a4e3f9d1908b9992ce73ae6538b25efd3a9a7e7b788ad *agent-kanban-windows-x64.exe
```

`*` 是 GNU coreutils 用来标记"这个文件是按二进制读的"的。Linux / macOS runner 上
同一份 workflow 产出的却是**两个空格**（文本模式）：

```
54 48 52 54 … 32 32 61 67 65 6e 74 …   →  "…a  agent-kanban-linux-x64"
```

原因在 CI：`.github/workflows/release.yml` 的 Checksum 步用
`sha256sum "$asset" > "$asset.sha256"`，而 Windows runner 上 `shell: bash` 拿到的是
**Git Bash 里的 MSYS2 版 coreutils**，它默认按二进制模式处理（MSYS2 里没有文本/二进制
转换之别，coreutils 被编译成 `BIN_MODE=1`）。于是**只有 Windows 的 `.sha256` 带 `*`**。

也就是说：digest 是对的，对齐检查被那个 `*` 挡下来了。这个分支过去**从来没在
Windows 上跑通过**——它只在"文件名真的对不上"时才失败，而作者（我）是在 Linux/macOS
上验证的，文本模式正好对得上。

### 修法

解析层把两种写法都认掉，顺带剥掉 `shasum` 可能写出的 `./` 前缀：

```ts
const file = m[2]?.trim().replace(/^\*/, "").trim().replace(/^\.\//, "");
```

不要改 CI 去迁就解析器（`--tag`、手工重写 `.sha256` 都行不通：**已经发布出去的
v0.1.8 里的 `*` 改不掉**，老用户手里的 `.sha256` 就是这个样子）。解析层容错才是
唯一能救既有发布物的地方。

### 顺带：这类失败不该报 INTERNAL

原来两处 `throw new Error(...)` 会经 `toKanbanError` 变成
`INTERNAL(6)`——按 `errors.ts` 的定义那是"视为 bug 并上报"。但"下载下来的东西
和发布说明对不上"是**外部数据问题**，重试不会变好，上报也没人接。改成
`KanbanError.state`（退出码 2）并带上 `details.reason`
（`checksum_name_mismatch` / `checksum_mismatch` / `missing_release_asset`）。

顺手把整条校验链抽成 core 的 `verifyChecksum({ binary, checksumContent, assetName })`：
它原本埋在命令里，**只有真去下一个 100MB 的包才会暴露**，没法脱网测。现在
`test/update.test.ts` 直接拿 v0.1.8 真实的 `.sha256` 原文当输入跑。

## 三、还没法靠这条命令自救的人

v0.1.8 的二进制里带着坑 2，所以**装在用户机器上的那个版本无法自更新**
（下载完成后必然在名字对齐处失败）。修复合入后要等下一个 release；
在那之前只能手工下载一次替换，之后 `update` 才恢复可用：

```powershell
# 从 Release 页下 agent-kanban-windows-x64.exe，替换掉旧的那个
# （校验时注意：Windows 的 .sha256 文件名带 * 前缀，属正常）
```

README 里 `--check` 的写法本来就是对的（`agent-kanban update --check`），
两处 README 都不需要改。
