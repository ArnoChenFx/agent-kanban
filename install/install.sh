#!/usr/bin/env bash
# agent-kanban 一键安装脚本（macOS / Linux）
#
#   curl -fsSL https://raw.githubusercontent.com/ArnoChenFx/agent-kanban/main/install/install.sh | bash
#
# 装到用户级目录（默认 ~/.local/bin），不需要管理员 / sudo。
set -euo pipefail

REPO_SLUG="ArnoChenFx/agent-kanban"
DOCKER_IMAGE="ghcr.io/arnochenfx/agent-kanban:latest"
BIN_NAME="agent-kanban"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# ---- 平台识别 ----
# 资产名必须与 release.yml matrix 里的 `asset:` 完全一致，改名时两处一起改；
# scripts/verify-install.ts 会把两边的集合拿来对账。
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64|aarch64) ASSET="agent-kanban-darwin-arm64" ;;
      x86_64) ASSET="agent-kanban-darwin-x64" ;;
      *) fail "unsupported macOS architecture: $arch" ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64|amd64) ASSET="agent-kanban-linux-x64" ;;
      *)
        # 这里必须显式退出而不是退回 x86：arm64 上装到的 x86 二进制跑不起来
        # （Apple Silicon 还会先尝试 Rosetta，失败信息与架构无关，极难自查）。
        # 不发 Linux arm64 二进制是因为它只能靠 qemu 冒烟，验证不到真实执行；
        # 而 Docker 镜像本来就是多架构的，架构由运行时解析。
        printf 'error: no Linux %s binary is published (only linux-x64).\n' "$arch" >&2
        printf 'The Docker image is multi-architecture and resolves this for you:\n\n' >&2
        printf '  docker run -d --name agent-kanban -p 7788:7788 -v kanban-data:/data %s\n\n' "$DOCKER_IMAGE" >&2
        printf 'If this is an Apple Silicon Mac, use install.sh instead of a Linux build.\n' >&2
        exit 1
        ;;
    esac
    ;;
  *) fail "unsupported operating system: $os (macOS and Linux use this script; Windows uses install.ps1)" ;;
esac

# ---- 下载地址 ----
# releases/latest/download 由 GitHub 解析到最新的**正式**版（不含 prerelease）。
# AGENT_KANBAN_DOWNLOAD_BASE / _VERSION / _INSTALL_DIR 三个覆盖项让脚本可测：
# verify-install.ts 用它们把下载指向本地假 server，不联网。
if [ -n "${AGENT_KANBAN_DOWNLOAD_BASE:-}" ]; then
  BASE="${AGENT_KANBAN_DOWNLOAD_BASE%/}"
elif [ -n "${AGENT_KANBAN_VERSION:-}" ]; then
  BASE="https://github.com/${REPO_SLUG}/releases/download/v${AGENT_KANBAN_VERSION}"
else
  BASE="https://github.com/${REPO_SLUG}/releases/latest/download"
fi
URL="${BASE}/${ASSET}"

INSTALL_DIR="${AGENT_KANBAN_INSTALL_DIR:-$HOME/.local/bin}"
TARGET="${INSTALL_DIR}/${BIN_NAME}"

printf 'agent-kanban installer\n'
printf '  platform    %s/%s\n' "$os" "$arch"
printf '  asset       %s\n' "$ASSET"
printf '  install to  %s\n\n' "$TARGET"

command -v curl >/dev/null 2>&1 || fail "curl is required (macOS ships it; Debian/Ubuntu: apt-get install curl)"

# ---- 下载到临时目录再原子落盘 ----
# 用 mktemp -d 而不是 /tmp/固定名：两个人同时装（或同目录跑两个 agent）时
# 后一个不会踩前一个还没 mv 走的文件。同目录内的 mv 是原子的，所以
# 正在运行的老版本不会被半截文件顶掉。
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BIN="${TMP_DIR}/${ASSET}"

printf 'Downloading %s\n' "$URL"
curl -fsSL --retry 3 --retry-delay 1 -o "$TMP_BIN" "$URL" || fail "download failed: $URL"

# curl 不会给下载物打上可执行位，漏掉这一步的话安装"成功"了但一运行就
# Permission denied —— 而 chmod 0755 之后紧跟 mv，中间没有别的失败点。
chmod 0755 "$TMP_BIN"
mkdir -p "$INSTALL_DIR"
mv -f "$TMP_BIN" "$TARGET"

# ---- PATH ----
# 装到用户目录后，PATH 不一定已经包含它。三种情况分别处理，重跑不产生重复行。
in_path() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

if in_path "$INSTALL_DIR"; then
  printf '\n%s is already on your PATH.\n' "$INSTALL_DIR"
else
  # fish 的配置语法与 sh 系不通用，单独处理
  case "${SHELL:-}" in
    */fish)
      RC="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      LINE="fish_add_path ${INSTALL_DIR}"
      ;;
    */zsh)
      RC="$HOME/.zshrc"
      LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
      ;;
    *)
      RC="$HOME/.bashrc"
      LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
      ;;
  esac

  # AGENT_KANBAN_SKIP_PATH=1 供 scripts/verify-install.ts 使用：门禁要用真实的
  # 临时安装目录跑这个脚本，而往开发者自己的 ~/.bashrc 追加一行是对本机的
  # 真实副作用（下次开 shell 就多一条指向已删除目录的 PATH）。同族的
  # _DOWNLOAD_BASE / _VERSION / _INSTALL_DIR 覆盖项也都是为了这个。
  if [ "${AGENT_KANBAN_SKIP_PATH:-}" = "1" ]; then
    printf '\nSkipping the PATH update (AGENT_KANBAN_SKIP_PATH=1).\n'
  elif [ -f "$RC" ] && grep -qF "$INSTALL_DIR" "$RC"; then
    printf '\n%s already has a PATH entry for %s (it takes effect in new shells).\n' "$RC" "$INSTALL_DIR"
  else
    printf '\nAdding %s to your PATH in %s\n' "$INSTALL_DIR" "$RC"
    touch "$RC"
    printf '\n# agent-kanban\n%s\n' "$LINE" >>"$RC"
    printf 'Run `source %s` (or open a new terminal) to pick it up now.\n' "$RC"
  fi
fi

# ---- 装完即用 ----
# 真正跑一次，而不是只看文件在不在：下载到的是 404 页面、传输被截断、
# 或者架构下错，都只会在"执行"这一步暴露。
printf '\n'
"$TARGET" --version || fail "installed binary failed to run: $TARGET"

cat <<EOF

Installed to $TARGET

Next:
  agent-kanban init                  create a board in the current directory
  agent-kanban serve                 web board on http://127.0.0.1:7788/
  agent-kanban install-protocol      teach your agents to use the board

Upgrade later by re-running this script; the new binary replaces the old one.
Uninstall by deleting $TARGET.
EOF
