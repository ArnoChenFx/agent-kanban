/**
 * 人类可读输出格式化。
 *
 * 看板的主要读者是人（终端）和 agent（JSON），因此这里的输出要满足：
 * - 人在终端里能快速扫读：对齐、中文宽度正确、相对时间直观
 * - agent 在 JSON 里能稳定解析：字段名固定（见契约 §6）
 */

/** 终端默认颜色开关（NO_COLOR 环境变量或 --no-color 时关闭） */
export const colorsEnabled = (): boolean => !process.env.NO_COLOR;

/** 颜色码：仅在 board 等装饰性输出使用；JSON 输出绝不带颜色 */
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

/** 条件着色：颜色关闭时原样返回。接受 number 方便直接给计数上色 */
export function paint(text: string | number, color: keyof typeof C | null): string {
  const s = String(text);
  if (color === null || !colorsEnabled()) return s;
  return `${C[color]}${s}${C.reset}`;
}

export const style = {
  dim: (s: string | number) => paint(s, "dim"),
  bold: (s: string | number) => paint(s, "bold"),
  red: (s: string | number) => paint(s, "red"),
  green: (s: string | number) => paint(s, "green"),
  yellow: (s: string | number) => paint(s, "yellow"),
  blue: (s: string | number) => paint(s, "blue"),
  magenta: (s: string | number) => paint(s, "magenta"),
  cyan: (s: string | number) => paint(s, "cyan"),
  gray: (s: string | number) => paint(s, "gray"),
};

/** 状态 → 颜色 */
export function statusColor(status: string): keyof typeof C | null {
  switch (status) {
    case "todo":
      return "cyan";
    case "doing":
      return "yellow";
    case "blocked":
      return "red";
    case "review":
      return "magenta";
    case "done":
      return "green";
    case "cancelled":
      return "gray";
    default:
      return "blue";
  }
}

/** 状态 → 英文标签（终端展示用） */
const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  doing: "Doing",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** 状态 → 短符号（board 列表用，节省横向空间） */
const STATUS_MARKS: Record<string, string> = {
  backlog: "○",
  todo: "○",
  doing: "▸",
  blocked: "⛔",
  review: "◎",
  done: "✓",
  cancelled: "✗",
};

export function statusMark(status: string): string {
  return STATUS_MARKS[status] ?? "?";
}

/** ANSI 转义序列匹配（颜色码）。宽度计算时必须先剔除，否则彩色文本的对齐全乱。 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** 去掉 ANSI 颜色转义序列，得到纯文本（用于计算显示宽度） */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * 计算字符串的显示宽度（中文/全角字符算 2 列）。
 *
 * 终端表格对齐必须用显示宽度而不是 .length，否则中英混排会错位。
 * 彩色输出先 stripAnsi：转义序列不占显示列数。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0) ?? 0;
    width += isWideChar(code) ? 2 : 1;
  }
  return width;
}

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 韩文字母
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首、标点
    (code >= 0x3041 && code <= 0x33ff) || // 假名、兼容字符
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) // Emoji
  );
}

/** 按显示宽度左侧补空格（用于右对齐） */
export function padStartWidth(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text));
  return " ".repeat(pad) + text;
}

/** 按显示宽度右侧补空格（用于左对齐），超宽则截断并加省略号。保留原有颜色码。 */
export function padEndWidth(text: string, width: number): string {
  const plain = stripAnsi(text);
  const current = displayWidth(plain);
  if (current > width) {
    // 逐字符裁剪到目标宽度减 1，留一位给省略号（按纯文本宽度，不计转义）
    let out = "";
    let w = 0;
    for (const char of plain) {
      const cw = isWideChar(char.codePointAt(0) ?? 0) ? 2 : 1;
      if (w + cw > width - 1) break;
      out += char;
      w += cw;
    }
    return out + "…";
  }
  return text + " ".repeat(width - current);
}

/** 进度条：█ 已完成 ░ 未完成 */
export function progressBar(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * 相对时间：`<60s` → "just now"，`<60m` → "12m ago"，`<24h` → "5h ago"，否则 "2d ago"。
 * 未来时间返回 "0s ago"（时钟回拨兜底，不显示负数，避免 agent 解析出错）。
 *
 * ⚠ 这是**展示值**不是标识符，所以随 CLI 文案一起英文化；
 *   但 displayWidth 的全角计算必须保留——任务标题可以是中文，回显时仍要算 2 列宽。
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.floor(day / 30)}mo ago`;
}

/** 时长格式化：毫秒 → "2h14m" / "45s" / "3d" */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    const rest = min % 60;
    return rest > 0 ? `${hour}h${rest}m` : `${hour}h`;
  }
  const day = Math.floor(hour / 24);
  const restHour = hour % 24;
  return restHour > 0 ? `${day}d${restHour}h` : `${day}d`;
}

/**
 * 解析时长字符串 → 毫秒。支持 "2h"、"30m"、"90s"、"1d"、"1h30m"。
 * 纯数字按分钟处理（agent 常写 "30" 意图是 30 分钟）。
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (/^\d+$/.test(text)) return Number(text) * 60_000;
  const re = /(\d+)\s*([dhms])/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const value = Number(m[1]);
    switch (m[2]) {
      case "d":
        total += value * 86_400_000;
        break;
      case "h":
        total += value * 3_600_000;
        break;
      case "m":
        total += value * 60_000;
        break;
      case "s":
        total += value * 1_000;
        break;
    }
  }
  return matched ? total : null;
}

/** 截断长文本（把换行替成空格，保留显示宽度语义） */
export function truncate(text: string, width: number): string {
  return padEndWidth(text.replace(/\n/g, " "), width);
}
