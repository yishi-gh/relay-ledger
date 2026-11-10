import type { PersonalPreferences } from "./settings"

const MINUTE_MS = 60000
const REFRESH_OFFSET_MS = 12000

/** 槽位开始后的第 12 秒刷新；严格取未来槽位，避免恰在边界时空转。 */
export function nextRefreshDelay(now: number, intervalMinutes: number): number | null {
  if (intervalMinutes <= 0) return null
  const interval = intervalMinutes * MINUTE_MS
  return (Math.floor((now - REFRESH_OFFSET_MS) / interval) + 1) * interval + REFRESH_OFFSET_MS - now
}

export function isRefreshOverdue(now: number, lastLoadedAt: number, intervalMinutes: number): boolean {
  return intervalMinutes > 0 && now - lastLoadedAt >= intervalMinutes * MINUTE_MS
}

type RefreshEnvironment = {
  now: () => number
  isHidden: () => boolean
  setTimer: (callback: () => void, delay: number) => number
  clearTimer: (timer: number) => void
  onVisibilityChange: (callback: () => void) => () => void
}

const browserEnvironment: RefreshEnvironment = {
  now: () => Date.now(),
  isHidden: () => document.hidden,
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (timer) => window.clearTimeout(timer),
  onVisibilityChange: (callback) => {
    document.addEventListener("visibilitychange", callback)
    return () => document.removeEventListener("visibilitychange", callback)
  },
}

export function startAutoRefresh(
  preferences: Pick<PersonalPreferences["refresh"], "intervalMinutes" | "pauseWhenHidden">,
  callbacks: { isLoading: () => boolean; getLastLoadedAt: () => number; refresh: () => Promise<void> },
  environment: RefreshEnvironment = browserEnvironment,
): () => void {
  const { intervalMinutes, pauseWhenHidden } = preferences
  if (intervalMinutes === 0) return () => {}
  let cancelled = false
  let refreshing = false
  let timer: number | undefined

  function schedule() {
    if (cancelled) return
    const delay = nextRefreshDelay(environment.now(), intervalMinutes)
    if (delay !== null) timer = environment.setTimer(() => { void tick() }, delay)
  }

  async function refresh() {
    if (cancelled || refreshing || callbacks.isLoading() || (pauseWhenHidden && environment.isHidden())) return
    refreshing = true
    try {
      await callbacks.refresh()
    } finally {
      refreshing = false
    }
  }

  async function tick() {
    try {
      await refresh()
    } finally {
      schedule()
    }
  }

  const removeVisibilityListener = pauseWhenHidden
    ? environment.onVisibilityChange(() => {
        if (!environment.isHidden() && isRefreshOverdue(environment.now(), callbacks.getLastLoadedAt(), intervalMinutes)) {
          void refresh()
        }
      })
    : () => {}
  schedule()
  return () => {
    cancelled = true
    if (timer !== undefined) environment.clearTimer(timer)
    removeVisibilityListener()
  }
}
