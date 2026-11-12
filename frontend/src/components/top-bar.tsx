import * as React from "react"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { CalendarDays, ChevronDown, Moon, RefreshCw, Sun } from "lucide-react"
import type { DateRange, RangeType } from "@/lib/api"
import { parseBeijingDateTime, formatBeijingDateTimeInput, validateCustomRange } from "@/lib/time-range"
import { formatBeijingTime } from "@/lib/formatters"

// 保留原有导出路径，兼容既有引用。
export { formatBeijingTime }

interface TopBarProps {
  title: string
  maxT?: number
  rows?: number
  timeRange: RangeType
  customRange: DateRange | null
  onTimeRangeChange: (range: RangeType, custom?: DateRange) => void
  onRefresh?: () => void
  refreshing?: boolean
}

export function TopBar({
  title,
  maxT,
  timeRange,
  customRange = null,
  onTimeRangeChange,
  onRefresh,
  refreshing = false,
}: TopBarProps) {
  const { theme, setTheme } = useTheme()
  const { isMobile } = useSidebar()
  const [rangeOpen, setRangeOpen] = React.useState(false)
  const [fromInput, setFromInput] = React.useState("")
  const [toInput, setToInput] = React.useState("")
  const [rangeError, setRangeError] = React.useState<string | null>(null)
  const rangeLabel = timeRange === "today" ? "今日" : timeRange === "7d" ? "近7天" : timeRange === "custom" ? "自定义" : "近24小时"

  const openRange = () => {
    const now = Date.now()
    setFromInput(formatBeijingDateTimeInput(customRange?.from ?? now - 24 * 3600000))
    setToInput(formatBeijingDateTimeInput(customRange?.to ?? now))
    setRangeError(null)
    setRangeOpen(true)
  }

  const applyCustomRange = (event: React.FormEvent) => {
    event.preventDefault()
    try {
      const range = validateCustomRange({ from: parseBeijingDateTime(fromInput), to: parseBeijingDateTime(toInput) })
      onTimeRangeChange("custom", range)
      setRangeOpen(false)
      setRangeError(null)
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <header className="sticky top-0 z-20 flex min-h-12 w-full items-center justify-between gap-x-2 sm:gap-x-4 border-b border-border/80 bg-background/95 px-3 sm:px-4 py-2 backdrop-blur-xs">
      {/* 左侧：SidebarTrigger + 当前页标题 */}
      <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
        <SidebarTrigger className="size-9 sm:size-8 shrink-0 text-muted-foreground hover:text-foreground" />
        <h1 className="text-[16px] sm:text-[18px] leading-[24px] font-semibold text-foreground tracking-tight truncate">
          {title}
        </h1>
      </div>

      {/* 右侧：数据截止时间、时间范围与全局操作 */}
      <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
        <span className="hidden md:inline text-[12px] leading-[16px] text-muted-foreground font-mono whitespace-nowrap">
          数据截止 {formatBeijingTime(maxT)}
        </span>

        <div className="hidden md:block h-3.5 w-px bg-border/70 mx-0.5" />

        <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-[12px]" onClick={openRange} aria-label="选择时间范围" title={timeRange === "custom" && customRange ? `${formatBeijingTime(customRange.from)} 至 ${formatBeijingTime(customRange.to)}` : rangeLabel}>
          <CalendarDays data-icon="inline-start" />
          {rangeLabel}
          <ChevronDown data-icon="inline-end" />
        </Button>
        <Sheet open={rangeOpen} onOpenChange={setRangeOpen}>
          <SheetContent side={isMobile ? "bottom" : "right"} className="max-h-[90dvh] overflow-y-auto p-5 sm:w-[420px] sm:max-w-[420px]">
            <SheetHeader className="p-0 pr-8">
              <SheetTitle>时间范围</SheetTitle>
              <SheetDescription>北京时间</SheetDescription>
            </SheetHeader>
            <ToggleGroup value={timeRange === "custom" ? [] : [timeRange]} onValueChange={(values) => {
              const value = values[0]
              if (value === "today" || value === "24h" || value === "7d") {
                onTimeRangeChange(value)
                setRangeOpen(false)
              }
            }} variant="outline" className="grid w-full grid-cols-3">
              <ToggleGroupItem value="today" className="min-w-0 text-[13px]">今日</ToggleGroupItem>
              <ToggleGroupItem value="24h" className="min-w-0 text-[13px]">近24小时</ToggleGroupItem>
              <ToggleGroupItem value="7d" className="min-w-0 text-[13px]">近7天</ToggleGroupItem>
            </ToggleGroup>
            <form onSubmit={applyCustomRange} className="flex min-w-0 flex-col gap-4 border-t border-border pt-4">
              <span className="text-[14px] font-medium">自定义</span>
              <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">开始时间
                <Input type="datetime-local" value={fromInput} onChange={(event) => setFromInput(event.target.value)} required className="min-w-0 w-full" aria-label="自定义开始时间" />
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">结束时间
                <Input type="datetime-local" value={toInput} onChange={(event) => setToInput(event.target.value)} required className="min-w-0 w-full" aria-label="自定义结束时间" />
              </label>
              {rangeError && <p role="alert" className="text-[13px] text-destructive">{rangeError}</p>}
              <Button type="submit" className="self-end">应用时间范围</Button>
            </form>
          </SheetContent>
        </Sheet>

        {onRefresh && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 sm:size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="刷新数据"
          >
            <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="size-8 sm:size-7 shrink-0 text-muted-foreground hover:text-foreground"
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

        <a
          href="https://github.com/yishi-gh/relay-ledger"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex size-8 sm:size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          aria-label="查看 GitHub 仓库"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4"
            aria-hidden="true"
          >
            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
            <path d="M9 18c-4.51 2-5-2-7-2" />
          </svg>
        </a>
      </div>
    </header>
  )
}
