/**
 * 登录卡片。
 *
 * 为什么需要：所有 /api/* 都要 token（ADR-13）。本地模式起 server 时会
 * 自动生成管理员 token 并写进 config.toml，用户从那儿复制过来即可。
 *
 * 安全取舍：token 存 localStorage（刷新免登录），
 * 代价是 XSS 能读到它——所以本项目**严格禁止 innerHTML**（见 docs/plan/002 §5）。
 */

import { useState } from "react"
import { KeyRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export function LoginCard({ onLogin }: { onLogin: (token: string, project?: string) => void }) {
  const [token, setToken] = useState("")
  const [project, setProject] = useState("")

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-5" />
          连接看板
        </CardTitle>
        <CardDescription>
          粘贴访问 token。它由管理员用 <code>kanban admin token create</code> 签发，
          或直接看 server 的 <code>.kanban/config.toml</code> 里的 <code>admin_token</code>。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (token.trim()) onLogin(token.trim(), project.trim() || undefined)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="token">访问 token</FieldLabel>
              <Input
                id="token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="k_..."
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="project">project（可选）</FieldLabel>
              <Input
                id="project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="留空则自动选第一个有权限的"
              />
              <FieldDescription>一个 token 可以授权多个 project。</FieldDescription>
            </Field>
          </FieldGroup>
          <Button type="submit" className="mt-4 w-full" disabled={!token.trim()}>
            进入看板
          </Button>
        </form>
      </CardContent>
      <CardFooter className="text-muted-foreground text-xs">
        <p>
          管理页面在 <code>/admin</code>（创建 project、签发 token）。本页只做看板。
        </p>
      </CardFooter>
    </Card>
  )
}
