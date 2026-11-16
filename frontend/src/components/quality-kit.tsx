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
const DOT_TONES: Record<QualityTone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-rose-500",
  neutral: "bg-muted-foreground/60",
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

export function QualityStatusRow({
  tone = "neutral",
  title,
  detail,
  meta,
}: {
  tone?: QualityTone
  title: string
  detail?: string
  meta?: string
}) {
  return (
    <div className="flex gap-2 rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5 text-[12px] leading-[16px]">
      <span
        aria-hidden="true"
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT_TONES[tone])}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-words font-medium text-foreground" title={title}>
            {title}
          </span>
          {meta ? (
            <span className="shrink-0 font-mono text-[12px] leading-[16px] tabular-nums text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </div>
        {detail ? <p className="break-words text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  )
}
