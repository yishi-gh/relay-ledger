import * as React from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Checkbox } from "@/components/ui/checkbox"
import { SlidersHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"

export interface ColumnItem {
  key: string
  label: string
  locked?: boolean
  group?: "biz" | "perf" | "audit" | string
}

interface ColPickerProps {
  columns: ColumnItem[]
  visibleKeys: string[]
  onToggleColumn: (key: string) => void
}

const GROUP_TITLES: Record<string, string> = {
  biz: "经营指标",
  perf: "性能指标",
  audit: "核算指标",
}

export function ColPicker({ columns, visibleKeys, onToggleColumn }: ColPickerProps) {
  const visibleCount = visibleKeys.length
  const totalCount = columns.length

  const hasGroups = React.useMemo(() => {
    return columns.some((c) => Boolean(c.group))
  }, [columns])

  const sections = React.useMemo(() => {
    if (!hasGroups) return []
    const groups: { key: string; title: string; columns: ColumnItem[] }[] = []
    const groupOrder = ["biz", "audit", "perf"]

    // 按指定顺序列出已知组
    for (const gKey of groupOrder) {
      const cols = columns.filter((c) => c.group === gKey)
      if (cols.length > 0) {
        groups.push({
          key: gKey,
          title: GROUP_TITLES[gKey] || gKey,
          columns: cols,
        })
      }
    }

    // 其它未在 groupOrder 的 group
    const otherGroups = Array.from(
      new Set(
        columns
          .map((c) => c.group)
          .filter((g): g is string => typeof g === "string" && !groupOrder.includes(g))
      )
    )
    for (const gKey of otherGroups) {
      const cols = columns.filter((c) => c.group === gKey)
      groups.push({
        key: gKey,
        title: GROUP_TITLES[gKey] || gKey,
        columns: cols,
      })
    }

    // 没有 group 标签的项（若有）
    const ungrouped = columns.filter((c) => !c.group)
    if (ungrouped.length > 0) {
      groups.unshift({
        key: "base",
        title: "基础字段",
        columns: ungrouped,
      })
    }

    return groups
  }, [columns, hasGroups])

  const renderColumnItem = (col: ColumnItem) => {
    const isChecked = visibleKeys.includes(col.key)
    const isLocked = Boolean(col.locked)

    return (
      <DropdownMenuItem
        key={col.key}
        closeOnClick={false}
        data-slot="col-picker-item"
        data-disabled={isLocked ? true : undefined}
        onClick={(e) => {
          e.preventDefault()
          if (!isLocked) {
            onToggleColumn(col.key)
          }
        }}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 cursor-pointer text-[13px] leading-[18px] rounded-md select-none outline-none transition-colors",
          isLocked
            ? "opacity-60 cursor-not-allowed bg-muted/30"
            : "hover:bg-accent hover:text-accent-foreground"
        )}
      >
        <Checkbox
          checked={isChecked}
          disabled={isLocked}
          tabIndex={-1}
          className="pointer-events-none size-4 rounded-[3px]"
        />
        <span
          className={cn(
            "flex-1 text-foreground font-normal",
            isLocked && "text-muted-foreground font-medium"
          )}
        >
          {col.label}
        </span>
        {isLocked && (
          <span className="text-[11px] leading-[14px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            锁定
          </span>
        )}
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="col-picker-trigger"
        className="inline-flex items-center justify-center border border-border bg-background hover:bg-muted text-foreground h-8 px-2.5 rounded-lg text-[12px] leading-[16px] gap-1.5 tabular-nums font-medium cursor-pointer transition-colors shadow-xs select-none"
      >
        <SlidersHorizontal className="size-3.5 text-muted-foreground" />
        <span>
          列 {visibleCount}/{totalCount}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-56 p-1.5 space-y-0.5 bg-popover text-popover-foreground shadow-md rounded-lg border border-border z-50 max-h-[85vh] overflow-y-auto"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[12px] leading-[16px] text-muted-foreground px-2 py-1 font-medium">
            显示列配置 ({visibleCount}/{totalCount})
          </DropdownMenuLabel>

          {hasGroups ? (
            sections.map((section) => (
              <React.Fragment key={section.key}>
                <DropdownMenuSeparator className="my-1 border-border/60" />
                <DropdownMenuLabel className="text-[11px] leading-[14px] font-semibold text-muted-foreground px-2 pt-1 pb-0.5">
                  {section.title}
                </DropdownMenuLabel>
                {section.columns.map(renderColumnItem)}
              </React.Fragment>
            ))
          ) : (
            <>
              <DropdownMenuSeparator className="my-1 border-border/60" />
              {columns.map(renderColumnItem)}
            </>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
