import * as React from "react"
import { Card, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Globe,
  Layers,
  Search,
  RefreshCw,
  AlertTriangle,
  Info,
  HelpCircle,
  Pin,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatTimestamp } from "@/lib/formatters"
import { fetchChannelRoutes, type ChannelRoutesPayload } from "@/lib/api"
import { SiteLogo } from "@/components/site-logo"

interface ChannelRoutesViewProps {
  refreshKey?: number
}

const ITEM_HEIGHT = 28

// 4 层横向默认中心 X 坐标与宽度（用于静态导出兼容与默认计算）
export const COLUMN_CONFIG = [
  { key: "group", label: "本站分组", centerX: 110, width: 150 },
  { key: "channel", label: "路由渠道", centerX: 390, width: 220 },
  { key: "account", label: "上游账户", centerX: 680, width: 180 },
  { key: "website", label: "上游网站", centerX: 910, width: 150 },
] as const

export interface CanvasNode {
  id: string
  kind: "group" | "channel" | "account" | "website"
  label: string
  subLabel?: string
  x: number
  y: number
  width: number
  height: number
  state?: "enabled" | "disabled" | "unknown"
  isSynthetic?: boolean
  rawId?: string | number
  channelData?: ChannelRoutesPayload["channels"][number]
}

export interface CanvasEdge {
  id: string
  kind: "gc" | "ca" | "aw" | "gm" | "mc"
  fromId: string
  toId: string
  x1: number
  y1: number
  x2: number
  y2: number
  isDisabled: boolean
  isRuleDisabled: boolean
  isUnknown: boolean
  channelId?: number
  abilityKey?: string
}

type RouteAbility = ChannelRoutesPayload["abilities"][number]
type RouteChannel = ChannelRoutesPayload["channels"][number]
type RouteAccount = ChannelRoutesPayload["accounts"][number]

function edgeId(kind: CanvasEdge["kind"], fromId: string, toId: string): string {
  return JSON.stringify([kind, fromId, toId])
}

function channelAccountNodeIds(channel: RouteChannel): string[] {
  return channel.account_ids && channel.account_ids.length > 0
    ? channel.account_ids.map((id) => `account:${id}`)
    : ["synthetic:unassigned-account"]
}

function computeColumnGap(count: number, availHeight: number, maxGap = 8, minGap = 0): number {
  if (count <= 1) return 0
  const totalItemHeight = count * ITEM_HEIGHT
  const remaining = availHeight - totalItemHeight
  if (remaining <= 0) return minGap
  const gap = Math.floor(remaining / (count - 1))
  return Math.max(minGap, Math.min(maxGap, gap))
}

export function buildRouteEdges(
  abilities: RouteAbility[],
  channels: RouteChannel[],
  accounts: RouteAccount[],
  nodeMap: Map<string, CanvasNode>,
): CanvasEdge[] {
  const edges = new Map<string, CanvasEdge>()
  const channelMap = new Map(channels.map((channel) => [channel.id, channel]))

  function addEdge(kind: CanvasEdge["kind"], fromId: string, toId: string, flags: Partial<CanvasEdge> = {}) {
    const from = nodeMap.get(fromId)
    const to = nodeMap.get(toId)
    if (!from || !to) return
    const id = edgeId(kind, fromId, toId)
    edges.set(id, {
      id,
      kind,
      fromId,
      toId,
      x1: from.x + from.width / 2,
      y1: from.y + from.height / 2,
      x2: to.x - to.width / 2,
      y2: to.y + to.height / 2,
      isDisabled: false,
      isRuleDisabled: false,
      isUnknown: false,
      ...flags,
    })
  }

  // 1. Group -> Channel 边：按 (group, channel_id) 聚合去重，不跨组扩散
  const groupChannels = new Map<string, RouteAbility[]>()
  for (const ability of abilities) {
    const gcKey = JSON.stringify([ability.group, ability.channel_id])
    const rules = groupChannels.get(gcKey) ?? []
    rules.push(ability)
    groupChannels.set(gcKey, rules)
  }

  for (const [, rules] of groupChannels) {
    const channel = channelMap.get(rules[0].channel_id)
    addEdge("gc", `group:${rules[0].group}`, `channel:${rules[0].channel_id}`, {
      isDisabled: channel?.state === "disabled",
      isUnknown: channel?.state === "unknown",
      isRuleDisabled: rules.every((r) => r.enabled !== true),
      channelId: rules[0].channel_id,
    })
  }

  // 2. Channel -> Account 边：独立于 ability 规则，渠道归属结构始终完整
  const accountChannels = new Map<string, RouteChannel[]>()
  for (const channel of channels) {
    for (const accountNodeId of channelAccountNodeIds(channel)) {
      addEdge("ca", `channel:${channel.id}`, accountNodeId, {
        isDisabled: channel.state === "disabled",
        isUnknown: channel.state === "unknown",
        channelId: channel.id,
      })
      const sources = accountChannels.get(accountNodeId) ?? []
      sources.push(channel)
      accountChannels.set(accountNodeId, sources)
    }
  }

  // 3. Account -> Website 边：独立生成，未配置网站接入合成节点
  function addWebsiteEdge(accountNodeId: string, websiteNodeId: string) {
    const sources = accountChannels.get(accountNodeId) ?? []
    addEdge("aw", accountNodeId, websiteNodeId, {
      isUnknown: sources.length > 0 && sources.every((channel) => channel.state !== "enabled"),
    })
  }

  for (const account of accounts) {
    addWebsiteEdge(
      `account:${account.id}`,
      account.website ? `website:${account.website}` : "synthetic:unassigned-website"
    )
  }
  if (accountChannels.has("synthetic:unassigned-account")) {
    addWebsiteEdge("synthetic:unassigned-account", "synthetic:unassigned-website")
  }

  return Array.from(edges.values())
}

export function getRouteHighlights(
  pinnedChannelId: number | null,
  hoveredNodeId: string | null,
  abilities: RouteAbility[],
  channels: RouteChannel[],
  accounts: RouteAccount[],
  nodeMap: Map<string, CanvasNode>,
  edges: CanvasEdge[],
): { nodeIds: Set<string>; edgeIds: Set<string> } | null {
  if (pinnedChannelId === null && !hoveredNodeId) return null
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  const channelFocus = new Set<number>()
  const accountNodeIds = new Set<string>()
  const matchedAbilities = new Set<RouteAbility>()

  if (pinnedChannelId !== null) channelFocus.add(pinnedChannelId)
  const hovered = hoveredNodeId ? nodeMap.get(hoveredNodeId) : undefined

  if (hovered) {
    nodeIds.add(hovered.id)
    if (hovered.kind === "channel" && typeof hovered.rawId === "number") {
      channelFocus.add(hovered.rawId)
    } else if (hovered.kind === "group") {
      for (const ability of abilities) {
        if (ability.group === hovered.rawId) {
          matchedAbilities.add(ability)
        }
      }
    } else if (hovered.kind === "account") {
      accountNodeIds.add(hovered.id)
    } else if (hovered.kind === "website") {
      for (const account of accounts) {
        if (hovered.isSynthetic ? !account.website : account.website === hovered.rawId) {
          accountNodeIds.add(`account:${account.id}`)
        }
      }
      if (hovered.isSynthetic && nodeMap.has("synthetic:unassigned-account")) {
        accountNodeIds.add("synthetic:unassigned-account")
      }
    }
  }

  // 账户反查关联渠道
  for (const channel of channels) {
    if (channelAccountNodeIds(channel).some((id) => accountNodeIds.has(id))) {
      channelFocus.add(channel.id)
    }
  }

  // 仅直接关注渠道、账户、网站或 pin 时展开关联规则；分组命中只用于下游连线。
  for (const ability of abilities) {
    if (channelFocus.has(ability.channel_id)) {
      matchedAbilities.add(ability)
    }
  }

  const downstreamChannels = new Set(channelFocus)
  for (const ability of matchedAbilities) {
    const groupId = `group:${ability.group}`
    const channelId = `channel:${ability.channel_id}`
    nodeIds.add(groupId)
    nodeIds.add(channelId)
    edgeIds.add(edgeId("gc", groupId, channelId))
    downstreamChannels.add(ability.channel_id)
  }

  for (const channelId of downstreamChannels) nodeIds.add(`channel:${channelId}`)

  // 点亮 Channel -> Account
  for (const edge of edges) {
    if (edge.kind === "ca" && edge.channelId !== undefined && downstreamChannels.has(edge.channelId)) {
      nodeIds.add(edge.fromId)
      nodeIds.add(edge.toId)
      edgeIds.add(edge.id)
      accountNodeIds.add(edge.toId)
    }
  }

  // 点亮 Account -> Website
  for (const edge of edges) {
    if (edge.kind === "aw" && accountNodeIds.has(edge.fromId)) {
      nodeIds.add(edge.fromId)
      nodeIds.add(edge.toId)
      edgeIds.add(edge.id)
    }
  }

  return { nodeIds, edgeIds }
}

export function ChannelRoutesView({ refreshKey }: ChannelRoutesViewProps) {
  const [data, setData] = React.useState<ChannelRoutesPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [fetchError, setFetchError] = React.useState<string | null>(null)
  const [retrySeq, setRetrySeq] = React.useState(0)

  // 筛选状态（模型支持搜索，但不作画布独立列）
  const [searchQuery, setSearchQuery] = React.useState("")
  const [selectedGroup, setSelectedGroup] = React.useState<string>("all")
  const [selectedAccount, setSelectedAccount] = React.useState<string>("all")
  const [includeDisabled, setIncludeDisabled] = React.useState(true)

  // 渠道锁定 Pin 与悬停状态
  const [pinnedChannelId, setPinnedChannelId] = React.useState<number | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null)

  const handleManualRefresh = React.useCallback(() => {
    setLoading(true)
    setRetrySeq((s) => s + 1)
  }, [])

  // 统一数据拉取逻辑（AbortController 保护）
  React.useEffect(() => {
    const controller = new AbortController()

    fetchChannelRoutes({ signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return
        setData(res)
        setFetchError(null)
        setLoading(false)
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setFetchError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })

    return () => {
      controller.abort()
    }
  }, [refreshKey, retrySeq])

  // 容器尺寸响应式探测 (ResizeObserver)
  const [scrollportEl, setScrollportEl] = React.useState<HTMLDivElement | null>(null)
  const [viewportSize, setViewportSize] = React.useState<{ width: number; height: number }>({
    width: 1040,
    height: 600,
  })

  React.useEffect(() => {
    if (!scrollportEl) return
    const update = () => {
      const w = scrollportEl.clientWidth
      const h = scrollportEl.clientHeight
      if (w > 0 && h > 0) {
        setViewportSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }))
      }
    }
    update()
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update)
      observer.observe(scrollportEl)
      return () => observer.disconnect()
    }
  }, [scrollportEl])

  // 1. 字典构建
  const channelMap = React.useMemo(() => {
    const map = new Map<number, ChannelRoutesPayload["channels"][0]>()
    data?.channels.forEach((c) => map.set(c.id, c))
    return map
  }, [data])

  const accountMap = React.useMemo(() => {
    const map = new Map<string, ChannelRoutesPayload["accounts"][0]>()
    data?.accounts.forEach((a) => map.set(a.id, a))
    return map
  }, [data])

  const nearChannelMap = React.useMemo(() => {
    const map = new Map<number, NonNullable<ChannelRoutesPayload["near_1h"]>["channels"][number]>()
    data?.near_1h?.channels.forEach((c) => map.set(c.channel_id, c))
    return map
  }, [data])

  const allGroups = React.useMemo(() => {
    const groups = new Set<string>()
    data?.abilities.forEach((a) => {
      if (a.group) groups.add(a.group)
    })
    return Array.from(groups).sort()
  }, [data])

  const allAccounts = React.useMemo(() => {
    return data?.accounts ?? []
  }, [data])

  // 2. 筛选 Abilities（支持模型关键词与分组/账户联动搜索过滤）
  const filteredAbilities = React.useMemo(() => {
    if (!data?.abilities) return []
    return data.abilities.filter((a) => {
      if (selectedGroup !== "all" && a.group !== selectedGroup) return false

      const channel = channelMap.get(a.channel_id)
      if (!includeDisabled) {
        if (a.enabled === false) return false
        if (channel && channel.state === "disabled") return false
      }

      if (selectedAccount !== "all") {
        if (!channel || !channel.account_ids.includes(selectedAccount)) {
          return false
        }
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const modelMatch = a.model.toLowerCase().includes(q)
        const channelMatch = channel ? channel.name.toLowerCase().includes(q) : false
        if (!modelMatch && !channelMatch) return false
      }

      return true
    })
  }, [data, selectedGroup, selectedAccount, includeDisabled, searchQuery, channelMap])

  // 3. 4 列节点集合准备
  // 列 1: Groups (有筛选能力的分组)
  const visibleGroups = React.useMemo(() => {
    const active = new Set(filteredAbilities.map((a) => a.group))
    if (active.size === 0 && selectedGroup !== "all") {
      active.add(selectedGroup)
    }
    return (allGroups.length > 0 ? allGroups : ["default"]).filter((g) =>
      selectedGroup === "all" ? active.has(g) : g === selectedGroup
    )
  }, [allGroups, filteredAbilities, selectedGroup])

  // 列 2: Channels
  const visibleChannels = React.useMemo(() => {
    const list = data?.channels ?? []
    if (!includeDisabled) {
      return list.filter((c) => c.state !== "disabled")
    }
    return list
  }, [data, includeDisabled])

  // 列 3: Accounts
  const visibleAccounts = React.useMemo(() => {
    return data?.accounts ?? []
  }, [data])

  // 列 4: Websites
  const visibleWebsites = React.useMemo(() => {
    const set = new Set<string>()
    data?.accounts.forEach((a) => {
      if (a.website) set.add(a.website)
    })
    return Array.from(set).sort()
  }, [data])

  const hasUnassignedAccount = React.useMemo(() => {
    return visibleChannels.some((c) => !c.account_ids || c.account_ids.length === 0)
  }, [visibleChannels])

  const hasUnassignedWebsite = React.useMemo(() => {
    return visibleAccounts.some((a) => !a.website) || hasUnassignedAccount
  }, [visibleAccounts, hasUnassignedAccount])

  // 4. 动态画布宽度与 4 列布局
  const canvasWidth = React.useMemo(() => {
    const available = viewportSize.width > 32 ? viewportSize.width - 16 : 960
    return Math.max(880, available)
  }, [viewportSize.width])

  const columnLayout = React.useMemo(() => {
    const colWidths = [140, 220, 170, 140] as const
    const totalColsWidth = colWidths[0] + colWidths[1] + colWidths[2] + colWidths[3]
    const marginX = 16
    const availGaps = Math.max(20, (canvasWidth - totalColsWidth - marginX * 2) / 3)

    const x0 = marginX + colWidths[0] / 2
    const x1 = marginX + colWidths[0] + availGaps + colWidths[1] / 2
    const x2 = marginX + colWidths[0] + colWidths[1] + availGaps * 2 + colWidths[2] / 2
    const x3 = canvasWidth - marginX - colWidths[3] / 2

    return [
      { key: "group", label: "本站分组", centerX: Math.round(x0), width: colWidths[0] },
      { key: "channel", label: "路由渠道", centerX: Math.round(x1), width: colWidths[1] },
      { key: "account", label: "上游账户", centerX: Math.round(x2), width: colWidths[2] },
      { key: "website", label: "上游网站", centerX: Math.round(x3), width: colWidths[3] },
    ] as const
  }, [canvasWidth])

  // 5. 几何坐标计算
  const { nodes, nodeMap, canvasHeight } = React.useMemo(() => {
    const list: CanvasNode[] = []
    const map = new Map<string, CanvasNode>()
    const startY = 36 // 位于列标题下方

    const availH = viewportSize.height > 100 ? viewportSize.height - 16 : 560
    const availContentHeight = Math.max(0, availH - startY - 8)

    // 列 1: 本站分组
    const groupCount = visibleGroups.length
    const groupGap = computeColumnGap(groupCount, availContentHeight, 10, 2)
    visibleGroups.forEach((g, idx) => {
      const node: CanvasNode = {
        id: `group:${g}`,
        kind: "group",
        label: g,
        x: columnLayout[0].centerX,
        y: startY + idx * (ITEM_HEIGHT + groupGap),
        width: columnLayout[0].width,
        height: ITEM_HEIGHT,
        rawId: g,
      }
      list.push(node)
      map.set(node.id, node)
    })

    // 列 2: 路由渠道
    const channelCount = visibleChannels.length
    const channelGap = computeColumnGap(channelCount, availContentHeight, channelCount > 10 ? 5 : 12, 0)
    visibleChannels.forEach((c, idx) => {
      const node: CanvasNode = {
        id: `channel:${c.id}`,
        kind: "channel",
        label: c.name,
        subLabel: `#${c.id}`,
        x: columnLayout[1].centerX,
        y: startY + idx * (ITEM_HEIGHT + channelGap),
        width: columnLayout[1].width,
        height: ITEM_HEIGHT,
        state: c.state,
        rawId: c.id,
        channelData: c,
      }
      list.push(node)
      map.set(node.id, node)
    })

    // 列 3: 上游账户
    const accountTotalCount = visibleAccounts.length + (hasUnassignedAccount ? 1 : 0)
    const accountGap = computeColumnGap(accountTotalCount, availContentHeight, 8, 1)
    visibleAccounts.forEach((a, idx) => {
      const node: CanvasNode = {
        id: `account:${a.id}`,
        kind: "account",
        label: a.name || a.id,
        x: columnLayout[2].centerX,
        y: startY + idx * (ITEM_HEIGHT + accountGap),
        width: columnLayout[2].width,
        height: ITEM_HEIGHT,
        rawId: a.id,
      }
      list.push(node)
      map.set(node.id, node)
    })

    if (hasUnassignedAccount) {
      const node: CanvasNode = {
        id: "synthetic:unassigned-account",
        kind: "account",
        label: "未关联财务账户",
        x: columnLayout[2].centerX,
        y: startY + visibleAccounts.length * (ITEM_HEIGHT + accountGap),
        width: columnLayout[2].width,
        height: ITEM_HEIGHT,
        isSynthetic: true,
      }
      list.push(node)
      map.set(node.id, node)
    }

    // 列 4: 上游网站
    const websiteTotalCount = visibleWebsites.length + (hasUnassignedWebsite ? 1 : 0)
    const websiteGap = computeColumnGap(websiteTotalCount, availContentHeight, 12, 4)
    visibleWebsites.forEach((w, idx) => {
      let host = w
      try {
        host = new URL(w).host
      } catch {
        // 原样
      }
      const node: CanvasNode = {
        id: `website:${w}`,
        kind: "website",
        label: host,
        subLabel: w,
        x: columnLayout[3].centerX,
        y: startY + idx * (ITEM_HEIGHT + websiteGap),
        width: columnLayout[3].width,
        height: ITEM_HEIGHT,
        rawId: w,
      }
      list.push(node)
      map.set(node.id, node)
    })

    if (hasUnassignedWebsite) {
      const node: CanvasNode = {
        id: "synthetic:unassigned-website",
        kind: "website",
        label: "未配置网站",
        x: columnLayout[3].centerX,
        y: startY + visibleWebsites.length * (ITEM_HEIGHT + websiteGap),
        width: columnLayout[3].width,
        height: ITEM_HEIGHT,
        isSynthetic: true,
      }
      list.push(node)
      map.set(node.id, node)
    }

    let maxBottom = 0
    for (const n of list) {
      const bottom = n.y + n.height
      if (bottom > maxBottom) {
        maxBottom = bottom
      }
    }

    return {
      nodes: list,
      nodeMap: map,
      canvasHeight: Math.max(maxBottom + 8, availH),
    }
  }, [
    visibleGroups,
    visibleChannels,
    visibleAccounts,
    visibleWebsites,
    hasUnassignedAccount,
    hasUnassignedWebsite,
    columnLayout,
    viewportSize.height,
  ])

  // 6. 边集合与高亮计算
  const edges = React.useMemo(
    () => buildRouteEdges(filteredAbilities, visibleChannels, visibleAccounts, nodeMap),
    [filteredAbilities, visibleChannels, visibleAccounts, nodeMap],
  )

  const highlightedElements = React.useMemo(
    () => getRouteHighlights(pinnedChannelId, hoveredNodeId, filteredAbilities, visibleChannels, visibleAccounts, nodeMap, edges),
    [pinnedChannelId, hoveredNodeId, filteredAbilities, visibleChannels, visibleAccounts, nodeMap, edges],
  )

  // 选中的渠道详情数据
  const selectedChannel = React.useMemo(() => {
    if (pinnedChannelId === null) return null
    return channelMap.get(pinnedChannelId) ?? null
  }, [pinnedChannelId, channelMap])

  // 选中渠道所属的所有 Abilities 规则
  const selectedChannelAbilities = React.useMemo(() => {
    if (!selectedChannel || !data?.abilities) return []
    return data.abilities.filter((a) => a.channel_id === selectedChannel.id)
  }, [selectedChannel, data])

  // 渠道状态圆点计算（综合 channel state、近 1 小时健康与错误覆盖度）
  const getChannelDotInfo = React.useCallback(
    (channel: RouteChannel) => {
      const isChanDisabled = channel.state === "disabled" || channel.status === 2 || channel.status === 3
      const near = nearChannelMap.get(channel.id)
      const errorsAvailable = data?.near_1h?.errors_available === true

      let colorClass = "bg-muted-foreground/50"
      let dotLabel = !errorsAvailable ? "错误未覆盖" : near?.state === "none" ? "近1h无调用" : "状态未知"

      // 1. 红点：优先停用或健康故障
      if (isChanDisabled || near?.state === "fail") {
        colorClass = "bg-rose-500"
        dotLabel = isChanDisabled ? "停用" : "近1h故障"
      } else if (near?.state === "warn") {
        colorClass = "bg-amber-500"
        dotLabel = "近1h告警"
      } else if (channel.state === "enabled" && near?.state === "ok" && errorsAvailable) {
        colorClass = "bg-emerald-500"
        dotLabel = "正常"
      }

      let ownerInfo: string | null = null
      if (channel.owner_source === "auto") {
        ownerInfo = "关联方式: 自动匹配"
      } else if (channel.owner_source === "explicit") {
        ownerInfo = "关联方式: 明确配置"
      } else if (channel.owner_source === "ambiguous") {
        const candidateNames = (channel.owner_candidates || [])
          .map((id) => accountMap.get(id)?.name || id)
          .join("、")
        ownerInfo = candidateNames ? `待确认: 网址对应多个账户 (${candidateNames})` : "待确认: 网址对应多个账户"
      }

      const tooltipText = [
        `${channel.name} (#${channel.id})`,
        `状态: ${dotLabel}`,
        `配置: ${isChanDisabled ? "已停用" : channel.state === "enabled" ? "已启用" : "状态未知"}`,
        ownerInfo,
        near
          ? `近1h: 成功 ${near.requests} · 错误 ${near.errors} · 成功率 ${near.uptime != null ? `${(near.uptime * 100).toFixed(2)}%` : "—"}`
          : "近1h: 无调用记录",
        `错误覆盖: ${errorsAvailable ? "就绪" : "未覆盖/缺少错误同步"}`,
        data?.near_1h ? `时间窗口: ${formatTimestamp(data.near_1h.from)} - ${formatTimestamp(data.near_1h.to)}` : null,
      ]
        .filter(Boolean)
        .join("\n")

      return {
        colorClass,
        label: dotLabel,
        tooltipText,
      }
    },
    [nearChannelMap, data, accountMap]
  )

  return (
    <div className="dashboard-view dashboard-routes dashboard-flow-fallback flex-1 min-h-0 min-w-0 flex flex-col gap-2 md:overflow-hidden">
      {/* 1. 紧凑单行顶栏：状态说明、筛选与操作控件合并，极大释放垂直空间 */}
      <div className="rounded-lg border border-border/80 bg-muted/20 px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 shrink-0 text-sm">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <div className="flex items-center gap-1.5 text-muted-foreground text-[12px]">
            <Info className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className="truncate cursor-help"
              title={`来自 NewAPI 当前路由配置（不随查询区间变化）\n最近同步：${data?.synced_at ? formatTimestamp(data.synced_at) : "从未同步"}${data?.last_attempt_at && data.last_attempt_at !== data.synced_at ? `\n最近尝试：${formatTimestamp(data.last_attempt_at)}` : ""}\n统计：${data?.channels.length ?? 0} 个渠道 · ${data?.abilities.length ?? 0} 条规则 · ${allGroups.length} 个分组`}
            >
              实时配置 · {data?.synced_at ? formatTimestamp(data.synced_at) : "待同步"}
            </span>
          </div>

          <div className="h-3.5 w-px bg-border/60 mx-0.5 hidden sm:block" />

          {/* 搜索框 */}
          <div className="relative min-w-[140px] max-w-[200px]">
            <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索模型或渠道..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 pl-7 text-[12px]"
              aria-label="搜索模型或渠道名"
            />
          </div>

          {/* 分组筛选 */}
          <select
            value={selectedGroup}
            onChange={(e) => setSelectedGroup(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 text-[12px] text-foreground focus-visible:border-ring outline-none"
            aria-label="按本站分组筛选"
          >
            <option value="all" className="bg-popover text-popover-foreground">全部分组 ({allGroups.length})</option>
            {allGroups.map((g) => (
              <option key={g} value={g} className="bg-popover text-popover-foreground">
                {g}
              </option>
            ))}
          </select>

          {/* 账户筛选 */}
          <select
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 text-[12px] text-foreground focus-visible:border-ring outline-none max-w-[150px] truncate"
            aria-label="按上游财务账户筛选"
          >
            <option value="all" className="bg-popover text-popover-foreground">全部账户 ({allAccounts.length})</option>
            {allAccounts.map((a) => (
              <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                {a.name || a.id}
              </option>
            ))}
          </select>

          {/* 包含停用渠道开关 */}
          <div className="flex items-center gap-1 ml-1">
            <Checkbox
              id="includeDisabled"
              checked={includeDisabled}
              onCheckedChange={(c) => setIncludeDisabled(Boolean(c))}
            />
            <label htmlFor="includeDisabled" className="text-[12px] text-muted-foreground cursor-pointer select-none">
              含停用渠道
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 text-[12px]">
          {pinnedChannelId !== null && (
            <Button
              variant="outline"
              size="sm"
              className="text-[12px] h-6.5 px-2 text-muted-foreground"
              onClick={() => setPinnedChannelId(null)}
              aria-label="清除当前选中的渠道锁定"
            >
              <X className="size-3 mr-1" />
              清除锁定
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-[12px] h-6.5 px-2"
            onClick={handleManualRefresh}
            disabled={loading}
            aria-label="重新拉取拓扑快照"
          >
            <RefreshCw className={cn("size-3 mr-1", loading && "animate-spin")} />
            刷新快照
          </Button>
        </div>
      </div>

      {/* 初始加载状态（不画空白画布） */}
      {loading && !data && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-muted-foreground text-[13px] flex flex-col items-center justify-center gap-2 md:flex-1 md:min-h-0 md:overflow-auto">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" />
          <span>加载快照中…</span>
        </div>
      )}

      {/* 初始请求网络失败 */}
      {fetchError && !data && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 flex flex-col items-center justify-center gap-2 text-destructive text-[13px] md:flex-1 md:min-h-0 md:overflow-auto">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-5 shrink-0" />
            <span>获取拓扑快照失败：{fetchError}</span>
          </div>
          <Button variant="outline" size="sm" className="h-7 text-[12px] mt-1" onClick={handleManualRefresh}>
            重试
          </Button>
        </div>
      )}

      {/* 尚未采集到快照 / 首次同步失败 */}
      {data && !data.available && (
        <div className="rounded-lg border border-border bg-muted/30 p-8 text-center text-muted-foreground text-[13px] flex flex-col items-center justify-center gap-1.5 md:flex-1 md:min-h-0 md:overflow-auto">
          <Info className="size-5 text-muted-foreground shrink-0" />
          <span className="font-medium text-foreground">尚无可用快照</span>
          <span>{data.error ? `同步异常：${data.error}` : "等待首次同步"}</span>
          {data.last_attempt_at && (
            <span className="text-[12px]">最近尝试时间：{formatTimestamp(data.last_attempt_at)}</span>
          )}
        </div>
      )}

      {/* 合法空渠道状态 */}
      {data?.available && data.channels.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground text-[13px] md:flex-1 md:min-h-0 md:overflow-auto">
          暂无已配置渠道
        </div>
      )}

      {/* 已有快照时重新拉取失败：保留旧快照但明确展示错误条与重试按钮 */}
      {fetchError && data && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3.5 py-2 flex items-center justify-between gap-2 shrink-0 text-destructive text-[13px]">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>获取拓扑快照失败：{fetchError}（当前保留 {data.synced_at ? formatTimestamp(data.synced_at) : "既有"} 快照）</span>
          </div>
          <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={handleManualRefresh}>
            重试
          </Button>
        </div>
      )}

      {/* 存在旧快照但新同步失败的错误提示条 */}
      {data?.available && data.error && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-1.5 flex items-center gap-2 shrink-0 text-amber-600 dark:text-amber-400 text-[12px]">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>快照同步异常：{data.error}（当前展示 {formatTimestamp(data.synced_at)} 旧快照；最近尝试：{formatTimestamp(data.last_attempt_at)}）</span>
        </div>
      )}

      {/* 仅在有可用快照且存在渠道时展示画布与控制器 */}
      {data?.available && data.channels.length > 0 && (
        <>
          {/* 2. 4 层拓扑画布 */}
          <Card className="dashboard-panel route-canvas shadow-xs overflow-hidden flex flex-col min-w-0 md:min-h-0 md:flex-1 gap-0 py-0">
            <div
              ref={setScrollportEl}
              className="relative w-full overflow-auto flex-1 min-h-0 select-none p-2 max-md:h-[480px] max-md:flex-none"
              onClick={() => {
                if (pinnedChannelId !== null) {
                  setPinnedChannelId(null)
                }
              }}
            >
              {/* 画布容器 */}
              <div
                className="relative mx-auto"
                style={{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }}
              >
                {/* 4 列标题 Header */}
                <div className="absolute top-0 left-0 w-full h-8 border-b border-border bg-muted/40 text-[13px] font-medium text-muted-foreground z-10 rounded-t-lg">
                  {columnLayout.map((col) => (
                    <div
                      key={col.key}
                      style={{
                        position: "absolute",
                        left: `${col.centerX - col.width / 2}px`,
                        width: `${col.width}px`,
                        top: 0,
                        bottom: 0,
                      }}
                      className="flex items-center justify-center text-center font-medium"
                    >
                      {col.label}
                    </div>
                  ))}
                </div>

                {/* SVG 连线层 */}
                <svg
                  className="absolute inset-0 size-full pointer-events-none z-0"
                  width={canvasWidth}
                  height={canvasHeight}
                  viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
                >
                  {edges.map((edge) => {
                    const isEdgeActive = highlightedElements ? highlightedElements.edgeIds.has(edge.id) : false
                    const isDimmed = highlightedElements !== null && !isEdgeActive

                    const d = `M ${edge.x1} ${edge.y1} C ${(edge.x1 + edge.x2) / 2} ${edge.y1}, ${(edge.x1 + edge.x2) / 2} ${edge.y2}, ${edge.x2} ${edge.y2}`

                    // 停用渠道或停用规则保持虚线灰显，高亮时也绝不能涂成绿色
                    const isDashed = edge.isDisabled || edge.isRuleDisabled || edge.isUnknown

                    let strokeColor = "var(--border)"
                    if (isEdgeActive) {
                      strokeColor = isDashed ? "var(--muted-foreground)" : "var(--primary)"
                    } else if (isDashed) {
                      strokeColor = "var(--border)"
                    }

                    return (
                      <path
                        key={edge.id}
                        d={d}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={isEdgeActive ? 2.5 : 1.5}
                        strokeDasharray={isDashed ? "4 4" : undefined}
                        className={cn("transition-opacity duration-150", isDimmed ? "opacity-10" : "opacity-90")}
                      />
                    )
                  })}
                </svg>

                {/* DOM 节点层 */}
                {nodes.map((node) => {
                  const isPinned = node.kind === "channel" && pinnedChannelId === node.rawId
                  const isNodeActive = highlightedElements ? highlightedElements.nodeIds.has(node.id) : false
                  const isDimmed = highlightedElements !== null && !isNodeActive && !isPinned

                  const isChannelDisabled = node.kind === "channel" && node.state === "disabled"
                  const dotInfo = node.channelData ? getChannelDotInfo(node.channelData) : null

                  let icon: React.ReactNode = <Layers className="size-3 text-muted-foreground shrink-0" />
                  if (node.kind === "channel") {
                    icon = <SiteLogo kind="channel" id={node.rawId || 0} label={node.label} size={16} />
                  } else if (node.kind === "account") {
                    icon = node.isSynthetic ? (
                      <HelpCircle className="size-3 text-muted-foreground shrink-0" />
                    ) : (
                      <SiteLogo kind="account" id={node.rawId || ""} label={node.label} size={16} />
                    )
                  } else if (node.kind === "website") {
                    icon = node.isSynthetic ? (
                      <HelpCircle className="size-3 text-muted-foreground shrink-0" />
                    ) : (
                      <Globe className="size-3 text-muted-foreground shrink-0" />
                    )
                  }

                  // 边框与高亮样式（停用节点始终保持灰显虚线，严禁刷 primary）
                  let styleClass = "border-border bg-card hover:border-foreground/40 text-foreground"
                  if (isChannelDisabled) {
                    styleClass = isPinned || isNodeActive
                      ? "border-dashed border-muted-foreground ring-2 ring-muted-foreground/30 bg-muted/30 text-muted-foreground"
                      : "border-dashed border-border/80 bg-muted/20 text-muted-foreground hover:border-muted-foreground/50"
                  } else if (isPinned) {
                    styleClass = "ring-2 ring-primary border-primary bg-primary/5 text-foreground font-semibold"
                  } else if (isNodeActive) {
                    styleClass = "border-primary ring-2 ring-primary/20 bg-accent/40 text-foreground font-semibold"
                  }

                  return (
                    <button
                      type="button"
                      key={node.id}
                      style={{
                        position: "absolute",
                        left: `${node.x - node.width / 2}px`,
                        top: `${node.y}px`,
                        width: `${node.width}px`,
                        height: `${node.height}px`,
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (node.kind === "channel" && typeof node.rawId === "number") {
                          setPinnedChannelId(isPinned ? null : node.rawId)
                        }
                      }}
                      onMouseEnter={() => setHoveredNodeId(node.id)}
                      onMouseLeave={() => setHoveredNodeId(null)}
                      className={cn(
                        "rounded-md border px-2 py-0.5 shadow-2xs flex items-center justify-between text-[12px] text-left transition-all z-10 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        styleClass,
                        isDimmed && "opacity-25",
                        node.isSynthetic && "border-dashed bg-muted/30 text-muted-foreground"
                      )}
                      aria-label={`${COLUMN_CONFIG.find((c) => c.key === node.kind)?.label || ""}: ${node.label}`}
                    >
                      <div className="flex items-center gap-1.5 truncate flex-1 min-w-0">
                        {icon}
                        <span className="truncate font-medium" title={node.subLabel ? `${node.label} (${node.subLabel})` : node.label}>
                          {node.label}
                        </span>
                      </div>

                      {/* 渠道状态指示 Dot 与锁定状态 */}
                      {node.kind === "channel" && dotInfo && (
                        <div className="flex items-center gap-1.5 shrink-0 ml-1">
                          <span
                            className={cn("size-2 rounded-full shrink-0 cursor-help", dotInfo.colorClass)}
                            title={dotInfo.tooltipText}
                          />

                          {isPinned && (
                            <Pin
                              className={cn(
                                "size-3 shrink-0",
                                isChannelDisabled ? "text-muted-foreground" : "text-primary"
                              )}
                            />
                          )}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </Card>

          {/* 3. 选中渠道详情卡片 */}
          {selectedChannel && (
            <Card className="dashboard-panel route-detail shadow-xs p-3.5 shrink-0 gap-2.5 border-primary/40 bg-card md:max-h-[45%] md:min-h-0 md:overflow-y-auto">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <SiteLogo kind="channel" id={selectedChannel.id} label={selectedChannel.name} size={18} />
                  <CardTitle className="text-[15px] font-medium text-foreground">
                    渠道详情: #{selectedChannel.id} {selectedChannel.name}
                  </CardTitle>
                  {selectedChannel.state === "disabled" ? (
                    <Badge variant="outline" className="text-[12px] text-rose-600 dark:text-rose-400 border-rose-500/30">
                      停用状态
                    </Badge>
                  ) : selectedChannel.state === "unknown" ? (
                    <Badge variant="outline" className="text-[12px] text-muted-foreground">
                      状态未知
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[12px] text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                      已启用
                    </Badge>
                  )}
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0"
                  onClick={() => setPinnedChannelId(null)}
                  aria-label="关闭渠道详情"
                >
                  <X className="size-4" />
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-[12px] leading-[16px]">
                {/* 接口地址 */}
                <div className="rounded-lg border border-border/70 bg-muted/20 p-2 flex flex-col gap-0.5">
                  <span className="text-muted-foreground font-medium">接口地址 (仅展示域名)</span>
                  <span className="font-mono text-foreground truncate" title={selectedChannel.endpoint || "未配置"}>
                    {selectedChannel.endpoint || "未配置"}
                  </span>
                </div>

                {/* 所属财务账户 */}
                <div className="rounded-lg border border-border/70 bg-muted/20 p-2 flex flex-col gap-0.5">
                  <span className="text-muted-foreground font-medium">关联财务账户</span>
                  <span
                    className="text-foreground truncate"
                    title={
                      selectedChannel.account_ids && selectedChannel.account_ids.length > 0
                        ? selectedChannel.account_ids.map((id) => accountMap.get(id)?.name || id).join("、")
                        : "未关联财务账户"
                    }
                  >
                    {selectedChannel.account_ids && selectedChannel.account_ids.length > 0 ? (
                      selectedChannel.account_ids
                        .map((id) => accountMap.get(id)?.name || id)
                        .join("、")
                    ) : (
                      <span className="text-muted-foreground">未关联财务账户</span>
                    )}
                  </span>
                  {selectedChannel.owner_source === "auto" && (
                    <span className="text-[11px] leading-[15px] text-muted-foreground truncate" title="根据接口网址自动匹配关联财务账户">
                      关联方式：自动匹配
                    </span>
                  )}
                  {selectedChannel.owner_source === "explicit" && (
                    <span className="text-[11px] leading-[15px] text-muted-foreground truncate" title="根据配置文件中明确指定的渠道归属">
                      关联方式：明确配置
                    </span>
                  )}
                  {selectedChannel.owner_source === "ambiguous" && (
                    <span
                      className="text-[11px] leading-[15px] text-amber-600 dark:text-amber-400 font-medium truncate"
                      title={
                        selectedChannel.owner_candidates && selectedChannel.owner_candidates.length > 0
                          ? `待确认：网址对应多个账户，候选：${selectedChannel.owner_candidates.map((id) => accountMap.get(id)?.name || id).join("、")}`
                          : "待确认：网址对应多个账户"
                      }
                    >
                      待确认：网址对应多个账户
                      {selectedChannel.owner_candidates && selectedChannel.owner_candidates.length > 0
                        ? `（候选：${selectedChannel.owner_candidates.map((id) => accountMap.get(id)?.name || id).join("、")}）`
                        : ""}
                    </span>
                  )}
                </div>

                {/* 模型重写 */}
                <div className="rounded-lg border border-border/70 bg-muted/20 p-2 flex flex-col gap-0.5">
                  <span className="text-muted-foreground font-medium">模型重写 (Model Mapping)</span>
                  {selectedChannel.mapping_error ? (
                    <span className="text-destructive truncate" title={selectedChannel.mapping_error}>
                      配置读取异常: {selectedChannel.mapping_error}
                    </span>
                  ) : selectedChannel.model_mapping && Object.keys(selectedChannel.model_mapping).length > 0 ? (
                    <div className="flex flex-col gap-0.5 font-mono text-[12px] max-h-[48px] overflow-y-auto">
                      {Object.entries(selectedChannel.model_mapping).map(([from, to]) => (
                        <span key={from} className="truncate" title={`${from} -> ${to}`}>
                          {from} → {to}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">无重写（原名透传）</span>
                  )}
                </div>
              </div>

              {/* 该渠道关联的 Abilities 真实路由参数表 */}
              <div className="pt-1">
                <span className="text-[12px] font-medium text-foreground block mb-1">
                  命中此渠道的路由分流规则 (共 {selectedChannelAbilities.length} 条，渠道状态见上方卡头)
                </span>
                {selectedChannelAbilities.length === 0 ? (
                  <div className="text-[12px] text-muted-foreground rounded-lg border border-border/60 p-2 bg-muted/10">
                    该渠道当前无关联的分流规则 (Abilities)。可能尚未配置模型分配，或规则已被删除。
                  </div>
                ) : (
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="max-h-[140px] overflow-auto">
                      <table className="w-full min-w-[660px] table-fixed text-[12px] text-left">
                        <colgroup>
                          <col style={{ width: "120px" }} />
                          <col />
                          <col style={{ width: "180px" }} />
                          <col style={{ width: "80px" }} />
                          <col style={{ width: "80px" }} />
                        </colgroup>
                        <thead className="bg-muted/50 border-b border-border sticky top-0 text-muted-foreground">
                          <tr>
                            <th className="px-2.5 py-1.5 font-medium">分组</th>
                            <th className="px-2.5 py-1.5 font-medium">请求模型</th>
                            <th className="px-2.5 py-1.5 font-medium">规则状态</th>
                            <th className="px-2.5 py-1.5 font-medium text-right tabular-nums">优先级</th>
                            <th className="px-2.5 py-1.5 font-medium text-right tabular-nums">权重</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {selectedChannelAbilities.map((ab, idx) => {
                            const isChanDisabled = selectedChannel.state === "disabled"
                            const isChanUnknown = selectedChannel.state === "unknown"
                            let statusBadge: React.ReactNode
                            if (ab.enabled === false) {
                              statusBadge = (
                                <Badge variant="outline" className="text-[12px] h-4.5 px-1 text-muted-foreground border-border">
                                  规则停用
                                </Badge>
                              )
                            } else if (ab.enabled == null) {
                              statusBadge = (
                                <Badge variant="outline" className="text-[12px] h-4.5 px-1 text-muted-foreground border-border">
                                  规则未知
                                </Badge>
                              )
                            } else if (isChanDisabled) {
                              statusBadge = (
                                <Badge variant="outline" className="text-[12px] h-4.5 px-1 text-muted-foreground border-border" title="规则开启，但所属渠道已停用">
                                  规则开启 (渠道已停用)
                                </Badge>
                              )
                            } else if (isChanUnknown) {
                              statusBadge = (
                                <Badge variant="outline" className="text-[12px] h-4.5 px-1 text-muted-foreground border-border" title="规则开启，但所属渠道状态未知">
                                  规则开启 (渠道未知)
                                </Badge>
                              )
                            } else {
                              statusBadge = (
                                <Badge variant="outline" className="text-[12px] h-4.5 px-1 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                                  规则开启
                                </Badge>
                              )
                            }

                            return (
                              <tr key={`${ab.group}-${ab.model}-${idx}`} className="hover:bg-muted/30">
                                <td className="px-2.5 py-1 text-foreground"><span className="block truncate" title={ab.group}>{ab.group}</span></td>
                                <td className="px-2.5 py-1 text-foreground"><span className="block truncate" title={ab.model}>{ab.model}</span></td>
                                <td className="px-2.5 py-1">{statusBadge}</td>
                                <td className="px-2.5 py-1 text-right font-mono tabular-nums text-foreground">
                                  {ab.priority != null ? ab.priority : "—"}
                                </td>
                                <td className="px-2.5 py-1 text-right font-mono tabular-nums text-foreground">
                                  {ab.weight != null ? ab.weight : "—"}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
