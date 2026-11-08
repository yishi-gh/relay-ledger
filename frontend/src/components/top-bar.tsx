import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Moon, Sun } from "lucide-react"
import { formatNumber } from "@/lib/formatters"

export function formatBeijingTime(ms: number | null | undefined): string {
  if (!ms) return "—"
  const d = new Date(ms)
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  const parts = formatter.formatToParts(d)
  const map: Record<string, string> = {}
  for (const p of parts) {
    map[p.type] = p.value
  }
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`
}

interface TopBarProps {
  title: string
  maxT?: number
  rows?: number
  timeRange: "24h" | "7d"
  onTimeRangeChange: (range: "24h" | "7d") => void
}

export function TopBar({
  title,
  maxT,
  rows,
  timeRange,
  onTimeRangeChange,
}: TopBarProps) {
  const { theme, setTheme } = useTheme()

  return (
    <header className="sticky top-0 z-20 flex min-h-12 w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/80 bg-background/95 px-4 py-2.5 backdrop-blur-xs">
      {/* 左侧：SidebarTrigger + 当前页标题 */}
      <div className="flex items-center gap-2.5 min-w-0">
        <SidebarTrigger className="size-8 shrink-0 text-muted-foreground hover:text-foreground" />
        <h1 className="text-[18px] leading-[24px] font-semibold text-foreground tracking-tight truncate">
          {title}
        </h1>
      </div>

      {/* 右侧：数据截止时间 + 24h/7d + 主题切换 */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <span className="text-[12px] leading-[16px] text-muted-foreground font-mono whitespace-nowrap">
          数据截止 {formatBeijingTime(maxT)} · {formatNumber(rows)} 条记录
        </span>

        <div className="hidden sm:block h-3.5 w-px bg-border/70 mx-0.5" />

        <ToggleGroup
          value={[timeRange]}
          onValueChange={(vals) => {
            if (vals && vals.length > 0) {
              onTimeRangeChange(vals[0] as "24h" | "7d")
            }
          }}
          variant="outline"
          size="sm"
          className="shrink-0"
        >
          <ToggleGroupItem value="24h" className="text-[12px] leading-[16px] px-3 h-7.5">
            近 24 小时
          </ToggleGroupItem>
          <ToggleGroupItem value="7d" className="text-[12px] leading-[16px] px-3 h-7.5">
            近 7 天
          </ToggleGroupItem>
        </ToggleGroup>

        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            const isDark = document.documentElement.classList.contains("dark")
            setTheme(isDark ? "light" : "dark")
          }}
          aria-label="切换主题"
        >
          {theme === "dark" ? (
            <Sun className="size-4" />
          ) : (
            <Moon className="size-4" />
          )}
        </Button>
      </div>
    </header>
  )
}
