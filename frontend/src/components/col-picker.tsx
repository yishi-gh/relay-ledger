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
}

interface ColPickerProps {
  columns: ColumnItem[]
  visibleKeys: string[]
  onToggleColumn: (key: string) => void
}

export function ColPicker({ columns, visibleKeys, onToggleColumn }: ColPickerProps) {
  const visibleCount = visibleKeys.length
  const totalCount = columns.length

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
        className="w-52 p-1.5 space-y-0.5 bg-popover text-popover-foreground shadow-md rounded-lg border border-border z-50"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[12px] leading-[16px] text-muted-foreground px-2 py-1 font-medium">
            显示列配置 ({visibleCount}/{totalCount})
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="my-1 border-border/60" />
          {columns.map((col) => {
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
                  "flex items-center gap-2 px-2 py-1.5 cursor-pointer text-[14px] leading-[20px] rounded-md select-none outline-none transition-colors",
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
                  <span className="text-[12px] leading-[16px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    锁定
                  </span>
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
