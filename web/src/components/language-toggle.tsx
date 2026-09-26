/**
 * 语言切换按钮。
 *
 * 为什么只有一个按钮而不是"两个选项并排"：只有两种语言时，"点我切到另一种"
 * 是唯一确定的动作，比让用户在两个已经知道自己语言的名字里再挑一次更省事；
 * 而且顶栏横向空间紧张，一个图标按钮放得下，两段文字放不下。
 *
 * 按钮上只放 Languages 图标，**当前语言不靠图标表达**——靠高亮边框和
 * aria-pressed 之外还有 tooltip 文案（"切换到 English"），鼠标用户移上去就知道
 * 点完会变成什么。屏幕阅读器读 aria-label 里的目标语言名。
 */

import { LanguagesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { LOCALES, LOCALE_NAME, useI18n, type Locale } from "@/lib/i18n"
import { cn } from "@/lib/utils"

export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n()
  // 只有两种语言，目标永远是"不是我当前的那个"
  const target = LOCALES.find((l) => l !== locale) as Locale
  const label = t("locale.switch", { name: LOCALE_NAME[target] })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocale(target)}
          aria-label={label}
          className={cn(className)}
          data-locale={locale}
        >
          <LanguagesIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
