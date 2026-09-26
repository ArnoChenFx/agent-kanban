/**
 * 项目选择（记住上次选的那个，没有就自动选第一个）的行为测试。
 *
 * ## 为什么单独测一个纯函数
 *
 * 规则本身只有两行判断，但历史上错在两处、且都不报错：
 *   1. 下拉框只改了 React state，没写 localStorage → 刷新就丢（静态守卫在 web-contract.test.ts）
 *   2. 兜底只判了「有没有选过」，没判「记住的那个还能不能访问」→
 *      project 被删、或换了权限不同的 token 之后，页面停在一片空白上
 *
 * 第 2 条只有拿真 token 打后端才暴露得出来，所以把判断抽成纯函数
 * （web/src/lib/project.ts，不引 React、不碰 localStorage）在这里逐条钉住。
 */

import { describe, expect, test } from "bun:test";
import { resolveProject } from "../web/src/lib/project.ts";

describe("resolveProject：记住的能用就用，否则退第一个", () => {
  test("有记忆且仍可访问 → 继续看它（哪怕它不是列表第一个）", () => {
    expect(resolveProject("web-demo", ["cli-kit", "web-demo"])).toBe("web-demo");
  });

  test("没记忆（第一次打开）→ 列表第一个", () => {
    expect(resolveProject(null, ["cli-kit", "web-demo"])).toBe("cli-kit");
  });

  test("空串记忆按「没选过」处理（分享链接 ?project= 会留下空串）", () => {
    expect(resolveProject("", ["cli-kit", "web-demo"])).toBe("cli-kit");
  });

  test("记忆的项目已经不在列表里 → 退第一个，不留着一个取不到看板的死 key", () => {
    // 两种成因：project 被删了 / 这次换了个只授权了别的 project 的 token
    expect(resolveProject("deleted-project", ["cli-kit", "web-demo"])).toBe("cli-kit");
  });

  test("一个项目都没有 → null，交给界面保留占位（别硬凑一个不存在的 key）", () => {
    expect(resolveProject(null, [])).toBeNull();
    expect(resolveProject("web-demo", [])).toBeNull();
  });
});
