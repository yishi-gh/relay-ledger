import * as React from "react"
import { cn } from "@/lib/utils"

export interface SiteLogoProps {
  kind: "channel" | "account"
  id: string | number
  label?: string
  size?: number
  className?: string
}

function getInitials(label?: string, fallbackId?: string | number): string {
  if (label && label.trim()) {
    const enMatch = label.match(/[A-Za-z0-9]/)
    if (enMatch && enMatch[0]) {
      return enMatch[0].toUpperCase()
    }
    return label.trim().slice(0, 1)
  }
  return String(fallbackId || "").slice(0, 1).toUpperCase()
}

export function SiteLogo({ kind, id, label, size = 16, className }: SiteLogoProps) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null)
  const src = `/api/site-logo?kind=${kind}&id=${encodeURIComponent(String(id))}`
  const initials = getInitials(label, id)
  const hasFailed = failedSrc === src

  if (hasFailed || !id) {
    return (
      <span
        style={{ width: `${size}px`, height: `${size}px`, fontSize: "12px" }}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-xs bg-muted/60 text-muted-foreground font-mono font-medium select-none overflow-hidden leading-none",
          className
        )}
        title={label}
        aria-hidden="true"
      >
        {initials}
      </span>
    )
  }

  return (
    <span
      style={{ width: `${size}px`, height: `${size}px` }}
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-xs overflow-hidden bg-muted/30", className)}
    >
      <img
        key={src}
        src={src}
        alt={label || ""}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(src)}
        className="size-full object-contain"
      />
    </span>
  )
}
