export type SortDirection = "desc" | "asc"

export interface SortState {
  key: string
  dir: SortDirection
}

/**
 * 列头点击三态循环：
 * 第一次点击 -> 降序 (desc)
 * 第二次点击 -> 升序 (asc)
 * 第三次点击 -> 回到默认口径 (null, 原接口顺序)
 */
export function nextSort(current: SortState | null, columnKey: string): SortState | null {
  if (!current || current.key !== columnKey) {
    return { key: columnKey, dir: "desc" }
  }
  if (current.dir === "desc") {
    return { key: columnKey, dir: "asc" }
  }
  return null
}

export type AccessorMap<T> = Record<
  string,
  (row: T) => number | string | null | undefined
>

/**
 * 通用排序函数：
 * - 数值列按原始数值比较；
 * - 字符串列按中文拼音 localeCompare('zh-Hans-CN') 比较；
 * - null / undefined / NaN / 空值在升序与降序下均恒排末尾；
 * - sort 为 null 时保持原始接口数组顺序不变。
 */
export function sortRows<T>(
  rows: T[],
  sort: SortState | null,
  accessors: AccessorMap<T>
): T[] {
  if (!sort) {
    return [...rows]
  }

  const accessor = accessors[sort.key]
  if (!accessor) {
    return [...rows]
  }

  return [...rows].sort((a, b) => {
    const valA = accessor(a)
    const valB = accessor(b)

    const aEmpty =
      valA == null ||
      valA === "" ||
      (typeof valA === "number" && isNaN(valA))
    const bEmpty =
      valB == null ||
      valB === "" ||
      (typeof valB === "number" && isNaN(valB))

    // 空值无论升序还是降序均排在最末
    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1

    if (typeof valA === "number" && typeof valB === "number") {
      return sort.dir === "asc" ? valA - valB : valB - valA
    }

    const strA = String(valA)
    const strB = String(valB)
    const cmp = strA.localeCompare(strB, "zh-Hans-CN", { numeric: true })
    return sort.dir === "asc" ? cmp : -cmp
  })
}

/**
 * 辅助渲染列头的排序状态符号与 aria-sort
 */
export function getSortHeaderAttrs(sort: SortState | null, columnKey: string) {
  const isCurrent = sort?.key === columnKey
  const dir = isCurrent ? sort.dir : null
  const ariaSort = dir === "desc" ? "descending" : dir === "asc" ? "ascending" : "none"
  const symbol = dir === "desc" ? "↓" : dir === "asc" ? "↑" : "↕"
  return {
    isActive: isCurrent,
    dir,
    ariaSort: ariaSort as "descending" | "ascending" | "none",
    symbol,
  }
}
