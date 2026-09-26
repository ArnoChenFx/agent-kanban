# =============================================================================
# agent-kanban server 镜像
# -----------------------------------------------------------------------------
# 目标：`docker run` 就能得到一个可用的看板 server（HTTP + SSE + Web 界面）。
#
# ⚠ 这里**不编译二进制**，直接用 bun 跑 TypeScript 源码。
#   原因：`bun build --compile` 会把 bun 运行时链进产物（约 +90MB），
#   而运行镜像如果基于 oven/bun 镜像本来就有同一个运行时——等于装了两份。
#   直接跑源码：镜像里只有一份 bun，体积更小也更透明（改代码不用重新编译）。
#   代价：启动时多几百毫秒的 TS 解析（可忽略）。
#
#   单文件二进制那条路（下载即用、自带前端）仍然保留，走的是 CI 的 release 流程，
#   与本镜像互不影响。详见 docs/note/2026-02-19-CI与容器化实施笔记.md。
#
# 前端构建产物放在 /opt/kanban/web，由 KANBAN_WEB_DIR 指向它。
#
# 数据卷：/data —— project / token / 任务 / 交接 / config.toml 都在这里
# =============================================================================

# ---------- 阶段 1：构建前端 ----------
FROM oven/bun:1.4.2-alpine AS web-builder
WORKDIR /app

# 只拷前端清单，源码改动时不触发重装依赖
COPY web/package.json ./web/
RUN cd web && (bun install --frozen-lockfile || bun install)

COPY web ./web
RUN cd web && bun run build

# ---------- 阶段 2：运行 ----------
FROM oven/bun:1.4.2-alpine

# ca-certificates：走 https 的场景需要
# tzdata：任务时间戳按本地时区显示
# wget：给 HEALTHCHECK 用（alpine 没有 curl）
RUN apk add --no-cache ca-certificates tzdata wget \
    && adduser -D -u 10001 -h /data kanban \
    && mkdir -p /data \
    && chown -R kanban:kanban /data

WORKDIR /app

# 运行时不需要 node_modules（本项目零运行时依赖，devDeps 只有 typescript / @types/bun），
# 所以只拷源码本身，进一步压体积。
COPY --chown=kanban:kanban src ./src
COPY --chown=kanban:kanban package.json bunfig.toml ./

# 前端产物（不内嵌，直接挂目录；改前端只需重建这个目录）
COPY --from=web-builder /app/web/dist /opt/kanban/web

ENV KANBAN_HOST=0.0.0.0 \
    KANBAN_PORT=7788 \
    KANBAN_WEB_DIR=/opt/kanban/web

VOLUME ["/data"]
WORKDIR /data
USER kanban

EXPOSE 7788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7788/api/health || exit 1

# 注意 ENTRYPOINT：bun 直接跑 TS 源码，不需要构建步骤
ENTRYPOINT ["bun", "run", "/app/src/cli.ts"]
CMD ["serve", "--port", "7788", "--host", "0.0.0.0"]
