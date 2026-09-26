import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Board } from "@/components/board"
import { consumeUrlLogin } from "@/lib/api"
import "./index.css"

// 启动引导：先吃掉分享链接里的 ?key=…&project=…&theme=…
// 必须在 render 之前完成——组件的 useState 初始值只在首次挂载时求值，
// 放在 render 阶段调用会赶不上（StrictMode 下尤其不可靠）。
consumeUrlLogin()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider>
        {/* 看板是单页应用：所有路径都渲染同一个看板 */}
        <Board />
        <Toaster position="bottom-right" richColors closeButton />
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
)
