/**
 * 把后端 `context.get` 的「建议接下来」翻成当前界面语言。
 *
 * ## 为什么不直接显示后端的 `next_actions`
 *
 * 那些串是写给 agent 看的（`agent-kanban context` / MCP / `--json`），中文。
 * Web 看板是给人看的多语言界面：直接渲染中文串，等于界面替 agent 说话；
 * 在词典里给每条中文串配一个英文译法，又会多出第二份真相——后端改了措辞，
 * 词典不会跟着改，英文界面就会安静地显示过时的旧句。
 *
 * 所以后端同时给出 `next_action_items`（代号 + 参数），
 * `next_actions`（中文）由同一份数据渲染而来。这里只负责**选词**：
 * 代号决定用哪条词典文案，参数负责插值。两边永远不会漂移。
 *
 * 约定（与 i18n.tsx 一致）：单复数不做 ICU 语法，需要的地方拆成
 * `.one` / `.many` 两个键，在 `keyFor` 里按数量选。
 *
 * 本模块不引 React，只接收绑定好 locale 的 `t`——和 `lib/status.ts` 一样，
 * 逻辑可以脱离界面单测。
 */

import type { NextActionItem, RecoveryContext } from "./api"
import type { MessageKey, Translate, TranslateParams } from "./i18n"

/**
 * 代号 → 词典键。
 *
 * 返回 `null` 只有一种情况：运行时的代号是本文件不认识的（前端旧、服务端新）。
 * 那时调用方退回后端的中文串，而不是崩掉。
 */
export function keyFor(item: NextActionItem): MessageKey | null {
  switch (item.code) {
    case "takeover":
      return "sidebar.next.takeover"
    case "read_handoff":
      return "sidebar.next.readHandoff"
    case "crash_handoffs":
      return item.args.n === 1 ? "sidebar.next.crashHandoffs.one" : "sidebar.next.crashHandoffs.many"
    case "continue_mine":
      return "sidebar.next.continueMine"
    case "blocked_needs_human":
      return item.args.n === 1 ? "sidebar.next.blocked.one" : "sidebar.next.blocked.many"
    case "claim_new":
      return "sidebar.next.claim"
    case "claim_after":
      return "sidebar.next.claimAfter"
    case "idle":
      return "sidebar.next.idle"
    default: {
      // 穷尽性检查：后端加代号而这里漏了分支，tsc 会在这里报错。
      // 运行时走到这里（新服务端 + 旧前端）返回 null，退回中文串。
      const exhaustive: never = item.code
      void exhaustive
      return null
    }
  }
}

/** 把后端参数转成插值参数。数组在**这里**按语言拼，不让后端写死标点。 */
function formatArgs(item: NextActionItem, t: Translate): TranslateParams {
  const { n, id, task, summary, tasks, commands } = item.args
  return {
    n,
    id,
    task,
    summary,
    // 任务号列举跟随语言标点：中文顿号、英文逗号+空格
    tasks: tasks?.join(t("list.sep")),
    // 命令之间用 " / "：两边都是代码，斜杠不是语言的一部分
    commands: commands?.join(" / "),
  }
}

/**
 * 取本地化后的建议列表。
 *
 * 三条降级路径，缺哪一环都不至于白屏：
 *   1. 老服务端没有 `next_action_items` → 原样返回 `next_actions`
 *   2. 某条代号不认识 → 该条退回 `next_actions` 里的同一序号
 *   3. 服务端多给了几条没对应 item 的 → 追加在后面
 */
export function localizedNextActions(ctx: RecoveryContext, t: Translate): string[] {
  const texts = ctx.next_actions ?? []
  const items = ctx.next_action_items
  if (!items || items.length === 0) return texts

  const out: string[] = []
  items.forEach((item, i) => {
    const key = keyFor(item)
    out.push(key ? t(key, formatArgs(item, t)) : (texts[i] ?? ""))
  })
  for (let i = items.length; i < texts.length; i++) {
    out.push(texts[i]!)
  }
  return out
}
