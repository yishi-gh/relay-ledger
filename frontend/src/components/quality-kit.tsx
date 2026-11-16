import type { ComponentType, ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export type QualityTone = "good" | "warn" | "bad" | "neutral"

const BADGE_BASE = "text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
const BADGE_TONES: Record<QualityTone, string> = {
  good: "text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  warn: "text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10",
  bad: "text-rose-600 dark:text-rose-400 border-rose-500/30 bg-rose-500/10",
  neutral: "text-muted-foreground border-border bg-muted/30",
}

export function QualityBadge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: QualityTone
  children: ReactNode
  className?: string
}) {
  return (
    <Badge variant="outline" className={cn(BADGE_BASE, BADGE_TONES[tone], className)}>
      {children}
    </Badge>
  )
}

export function QualityPanelHeader({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon?: ComponentType<{ className?: string }>
  children?: ReactNode
}) {
  return (
    <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0 shrink-0">
      <div className="flex min-w-0 items-center gap-2">
        <CardTitle className="truncate text-[16px] leading-[24px] font-medium text-foreground">
          {title}
        </CardTitle>
        {children}
      </div>
      {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
    </CardHeader>
  )
}

export function QualityEmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  detail?: string
}) {
  return (
    <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-1.5 py-3 text-center">
      <Icon className="size-4 text-muted-foreground/60" />
      <span className="text-[14px] leading-[20px] font-medium text-foreground">{title}</span>
      {detail ? <span className="text-[12px] leading-[16px] text-muted-foreground">{detail}</span> : null}
    </div>
  )
}
