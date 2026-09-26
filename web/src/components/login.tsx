/**
 * 登录卡片。
 *
 * 为什么需要：所有 /api/* 都要 token（ADR-13）。本地模式起 server 时会
 * 自动生成管理员 token 并写进 config.toml，用户从那儿复制过来即可。
 *
 * 安全取舍：token 存 localStorage（刷新免登录），
 * 代价是 XSS 能读到它——所以本项目**严格禁止 innerHTML**（见 docs/plan/002 §5）。
 *
 * 语言：登录页没有顶栏，语言切换按钮直接挂在卡片右上角，
 * 否则未登录的用户反而是唯一改不了语言的一群人。
 */

import { useState } from "react"
import { KeyRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { LanguageToggle } from "@/components/language-toggle"
import { useI18n } from "@/lib/i18n"

export function LoginCard({ onLogin }: { onLogin: (token: string, project?: string) => void }) {
  const [token, setToken] = useState("")
  const [project, setProject] = useState("")
  const { t } = useI18n()

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        {/* CardAction 是 shadcn 为"卡头右上角放一个控件"留的格子：
            CardHeader 见到它会自动切成两列，标题不会被挤窄。 */}
        <CardAction>
          <LanguageToggle />
        </CardAction>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-5" />
          {t("login.title")}
        </CardTitle>
        <CardDescription>
          {t("login.desc.before")} <code>{t("login.desc.cmd")}</code>
          {t("login.desc.mid")}
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
              <FieldLabel htmlFor="token">{t("login.label.token")}</FieldLabel>
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
              <FieldLabel htmlFor="project">{t("login.label.project")}</FieldLabel>
              <Input
                id="project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder={t("login.placeholder.project")}
              />
              <FieldDescription>{t("login.desc.project")}</FieldDescription>
            </Field>
          </FieldGroup>
          <Button type="submit" className="mt-4 w-full" disabled={!token.trim()}>
            {t("login.submit")}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="text-muted-foreground text-xs">
        <p>
          {t("login.footer.before")} <code>/admin</code>
          {t("login.footer.after")}
        </p>
      </CardFooter>
    </Card>
  )
}
