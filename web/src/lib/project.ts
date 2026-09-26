/**
 * 决定这次打开看板要看哪个 project。
 *
 * 需求是「记住最后选的项目，没有就自动选第一个」——听起来一行 `?? list[0]` 就够，
 * 但少了「记住的那个还算不算数」这一步：project 可能被删了，也可能这次换了
 * 一个权限不同的 token（项目级 token 只授权了一部分 project）。
 * 那种情况下 localStorage 里的 key 还在、却已经取不到看板，
 * 页面会安静地停在一片空白上——比自动退回第一个项目糟得多。
 *
 * 规则就两条，顺序不能反：
 *  1. 记住的还在可访问列表里 → 用它（换机器、隔天回来都接着上次看）
 *  2. 否则 → 列表第一个；一个都没有 → null（由界面保留占位，等用户自己选）
 *
 * 纯函数、不引 React / 不碰 localStorage：调用方负责读记忆和落盘，
 * 这样行为可以脱离浏览器单测（test/web-project.test.ts）。
 */
export function resolveProject(remembered: string | null, accessible: string[]): string | null {
  // 空串也算「没选过」：分享链接里 ?project= 就会留下空串
  if (remembered && accessible.includes(remembered)) return remembered
  return accessible[0] ?? null
}
