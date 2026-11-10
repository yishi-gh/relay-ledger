import * as React from "react"
import { Card, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Radio,
  Server,
  Globe,
  Layers,
  Cpu,
  Search,
  RefreshCw,
  AlertTriangle,
  Info,
  HelpCircle,
  Pin,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatTimestamp } from "@/lib/formatters"
import { fetchChannelRoutes, type ChannelRoutesPayload } from "@/lib/api"

interface ChannelRoutesViewProps {
  refreshKey?: number
}

const PAGE_SIZE = 24
const CANVAS_WIDTH = 1120
const ITEM_HEIGHT = 38

// 5 列横向中心 X 坐标与宽度（基于统一 1120px 画布标尺）
const COLUMN_CONFIG = [
  { key: "group", label: "本站分组", centerX: 110, width: 150 },
  { key: "model", label: "请求模型", centerX: 350, width: 170 },
  { key: "channel", label: "路由渠道", centerX: 590, width: 170 },
  { key: "account", label: "上游账户", centerX: 830, width: 150 },
  { key: "website", label: "上游网站", centerX: 1030, width: 140 },
] as const

interface CanvasNode {
  id: string
  kind: "group" | "model" | "channel" | "account" | "website"
  label: string
  subLabel?: string
  x: number
  y: number
  width: number
  height: number
  state?: "enabled" | "disabled" | "unknown"
  isSynthetic?: boolean
  rawId?: string | number
}

interface CanvasEdge {
  id: string
  kind: "gm" | "mc" | "ca" | "aw"
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

function abilityKey(ability: RouteAbility): string {
  return JSON.stringify([ability.group, ability.model, ability.channel_id])
}

function channelAccountNodeIds(channel: RouteChannel): string[] {
  return channel.account_ids.length > 0
    ? channel.account_ids.map((id) => `account:${id}`)
    : ["synthetic:unassigned-account"]
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
      id, kind, fromId, toId,
      x1: from.x + from.width / 2,
      y1: from.y + from.height / 2,
      x2: to.x - to.width / 2,
      y2: to.y + to.height / 2,
      isDisabled: false, isRuleDisabled: false, isUnknown: false,
      ...flags,
    })
  }

  const modelRules = new Map<string, RouteAbility[]>()
  for (const ability of abilities) {
    const modelKey = JSON.stringify([ability.group, ability.model])
    const rules = modelRules.get(modelKey) ?? []
    rules.push(ability)
    modelRules.set(modelKey, rules)
    const channel = channelMap.get(ability.channel_id)
    addEdge("mc", `model:${modelKey}`, `channel:${ability.channel_id}`, {
      isDisabled: channel?.state === "disabled",
      isUnknown: channel?.state === "unknown",
      isRuleDisabled: ability.enabled !== true,
      channelId: ability.channel_id,
      abilityKey: abilityKey(ability),
    })
  }
  for (const [modelKey, rules] of modelRules) {
    addEdge("gm", `group:${rules[0].group}`, `model:${modelKey}`, {
      isUnknown: rules.every((rule) => channelMap.get(rule.channel_id)?.state !== "enabled" || rule.enabled !== true),
    })
  }

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
  function addWebsiteEdge(accountNodeId: string, websiteNodeId: string) {
    const sources = accountChannels.get(accountNodeId) ?? []
    addEdge("aw", accountNodeId, websiteNodeId, {
      isUnknown: sources.length > 0 && sources.every((channel) => channel.state !== "enabled"),
    })
  }
  for (const account of accounts) {
    addWebsiteEdge(`account:${account.id}`, account.website ? `website:${account.website}` : "synthetic:unassigned-website")
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
  const selectedRules = new Map<string, RouteAbility>()
  if (pinnedChannelId !== null) channelFocus.add(pinnedChannelId)
  const hovered = hoveredNodeId ? nodeMap.get(hoveredNodeId) : undefined
  if (hovered) {
    nodeIds.add(hovered.id)
    if (hovered.kind === "channel" && typeof hovered.rawId === "number") {
      channelFocus.add(hovered.rawId)
    } else if (hovered.kind === "group" || hovered.kind === "model") {
      for (const ability of abilities) {
        const matches = hovered.kind === "group"
          ? ability.group === hovered.rawId
          : JSON.stringify([ability.group, ability.model]) === hovered.rawId
        if (matches) selectedRules.set(abilityKey(ability), ability)
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
  for (const channel of channels) {
    if (channelAccountNodeIds(channel).some((id) => accountNodeIds.has(id))) channelFocus.add(channel.id)
  }
  // 只有直接关注渠道、账户或网站时才展开该渠道的本页规则，模型/分组不反向扩散。
  for (const ability of abilities) {
    if (channelFocus.has(ability.channel_id)) selectedRules.set(abilityKey(ability), ability)
  }
  const downstreamChannels = new Set(channelFocus)
  for (const ability of selectedRules.values()) {
    const groupId = `group:${ability.group}`
    const modelId = `model:${JSON.stringify([ability.group, ability.model])}`
    const channelId = `channel:${ability.channel_id}`
    nodeIds.add(groupId)
    nodeIds.add(modelId)
    nodeIds.add(channelId)
    edgeIds.add(edgeId("gm", groupId, modelId))
    edgeIds.add(edgeId("mc", modelId, channelId))
    downstreamChannels.add(ability.channel_id)
  }
  for (const channelId of downstreamChannels) nodeIds.add(`channel:${channelId}`)
  for (const edge of edges) {
    if (edge.kind === "ca" && edge.channelId !== undefined && downstreamChannels.has(edge.channelId)) {
      nodeIds.add(edge.fromId)
      nodeIds.add(edge.toId)
      edgeIds.add(edge.id)
      accountNodeIds.add(edge.toId)
    }
  }
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

  // 筛选与分页状态
  const [searchQuery, setSearchQuery] = React.useState("")
  const [selectedGroup, setSelectedGroup] = React.useState<string>("all")
  const [selectedAccount, setSelectedAccount] = React.useState<string>("all")
  const [includeDisabled, setIncludeDisabled] = React.useState(true)
  const [currentPage, setCurrentPage] = React.useState(1)

  // 渠道锁定 Pin 与悬停状态
  const [pinnedChannelId, setPinnedChannelId] = React.useState<number | null>(null)
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null)

  const handleManualRefresh = React.useCallback(() => {
    setLoading(true)
    setRetrySeq((s) => s + 1)
  }, [])

  // 统一数据拉取逻辑（AbortController 保护，单一生命周期）
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

  // 2. 筛选 Abilities（规则流向）
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

  // 3. 模型二元对 (JSON.stringify([group, model]) 严格隔离同名跨组)
  const uniqueModelPairs = React.useMemo(() => {
    const map = new Map<string, { group: string; model: string; abilityCount: number }>()
    filteredAbilities.forEach((a) => {
      const key = JSON.stringify([a.group, a.model])
      const existing = map.get(key)
      if (existing) {
        existing.abilityCount++
      } else {
        map.set(key, { group: a.group, model: a.model, abilityCount: 1 })
      }
    })
    return Array.from(map.entries()).map(([key, val]) => ({
      key,
      group: val.group,
      model: val.model,
      abilityCount: val.abilityCount,
    }))
  }, [filteredAbilities])

  // 分页计算
  const totalPages = Math.max(1, Math.ceil(uniqueModelPairs.length / PAGE_SIZE))
  const effectivePage = Math.max(1, Math.min(currentPage, totalPages))
  const pagedModelPairs = React.useMemo(() => {
    const start = (effectivePage - 1) * PAGE_SIZE
    return uniqueModelPairs.slice(start, start + PAGE_SIZE)
  }, [uniqueModelPairs, effectivePage])

  const pagedModelKeySet = React.useMemo(() => {
    return new Set(pagedModelPairs.map((m) => m.key))
  }, [pagedModelPairs])

  const currentAbilities = React.useMemo(() => {
    return filteredAbilities.filter((a) => {
      const key = JSON.stringify([a.group, a.model])
      return pagedModelKeySet.has(key)
    })
  }, [filteredAbilities, pagedModelKeySet])

  // 4. 节点集合准备
  // 列 1: Groups (本页活跃分组，单选时显示选中项)
  const visibleGroups = React.useMemo(() => {
    const active = new Set(currentAbilities.map((a) => a.group))
    if (active.size === 0 && selectedGroup !== "all") {
      active.add(selectedGroup)
    }
    return (allGroups.length > 0 ? allGroups : ["default"]).filter((g) =>
      selectedGroup === "all" ? active.has(g) : g === selectedGroup
    )
  }, [allGroups, currentAbilities, selectedGroup])

  // 列 3: Channels（全部渠道保全，无论本页是否有 ability 均可见）
  const visibleChannels = React.useMemo(() => {
    const list = data?.channels ?? []
    if (!includeDisabled) {
      return list.filter((c) => c.state !== "disabled")
    }
    return list
  }, [data, includeDisabled])

  // 列 4: Accounts
  const visibleAccounts = React.useMemo(() => {
    return data?.accounts ?? []
  }, [data])

  // 列 5: Websites (安全 Origin 去重)
  const visibleWebsites = React.useMemo(() => {
    const set = new Set<string>()
    data?.accounts.forEach((a) => {
      if (a.website) set.add(a.website)
    })
    return Array.from(set).sort()
  }, [data])

  // 检查是否有未关联账户或未配置网站的渠道/账户
  const hasUnassignedAccount = React.useMemo(() => {
    return visibleChannels.some((c) => !c.account_ids || c.account_ids.length === 0)
  }, [visibleChannels])

  const hasUnassignedWebsite = React.useMemo(() => {
    return visibleAccounts.some((a) => !a.website) || hasUnassignedAccount
  }, [visibleAccounts, hasUnassignedAccount])

  // 5. 画布节点与几何坐标计算（1:1 CSS 像素统一度量衡）
  const { nodes, nodeMap, canvasHeight } = React.useMemo(() => {
    const list: CanvasNode[] = []
    const map = new Map<string, CanvasNode>()
    const startY = 56 // 位于列标题下方

    // 列 1: Groups
    const groupGap = 12
    visibleGroups.forEach((g, idx) => {
      const node: CanvasNode = {
        id: `group:${g}`,
        kind: "group",
        label: g,
        x: COLUMN_CONFIG[0].centerX,
        y: startY + idx * (ITEM_HEIGHT + groupGap),
        width: COLUMN_CONFIG[0].width,
        height: ITEM_HEIGHT,
        rawId: g,
      }
      list.push(node)
      map.set(node.id, node)
    })

    // 列 2: Models
    const modelGap = 10
    pagedModelPairs.forEach((m, idx) => {
      const node: CanvasNode = {
        id: `model:${m.key}`,
        kind: "model",
        label: m.model,
        subLabel: m.group,
        x: COLUMN_CONFIG[1].centerX,
        y: startY + idx * (ITEM_HEIGHT + modelGap),
        width: COLUMN_CONFIG[1].width,
        height: ITEM_HEIGHT,
        rawId: m.key,
      }
      list.push(node)
      map.set(node.id, node)
    })

    // 列 3: Channels
    const channelGap = 10
    visibleChannels.forEach((c, idx) => {
      const node: CanvasNode = {
        id: `channel:${c.id}`,
        kind: "channel",
        label: c.name,
        subLabel: `#${c.id}`,
        x: COLUMN_CONFIG[2].centerX,
        y: startY + idx * (ITEM_HEIGHT + channelGap),
        width: COLUMN_CONFIG[2].width,
        height: ITEM_HEIGHT,
        state: c.state,
        rawId: c.id,
      }
      list.push(node)
      map.set(node.id, node)
    })

    // 列 4: Accounts
    const accountGap = 12
    visibleAccounts.forEach((a, idx) => {
      const node: CanvasNode = {
        id: `account:${a.id}`,
        kind: "account",
        label: a.name || a.id,
        x: COLUMN_CONFIG[3].centerX,
        y: startY + idx * (ITEM_HEIGHT + accountGap),
        width: COLUMN_CONFIG[3].width,
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
        x: COLUMN_CONFIG[3].centerX,
        y: startY + visibleAccounts.length * (ITEM_HEIGHT + accountGap),
        width: COLUMN_CONFIG[3].width,
        height: ITEM_HEIGHT,
        isSynthetic: true,
      }
      list.push(node)
      map.set(node.id, node)
    }

    // 列 5: Websites
    const websiteGap = 14
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
        x: COLUMN_CONFIG[4].centerX,
        y: startY + idx * (ITEM_HEIGHT + websiteGap),
        width: COLUMN_CONFIG[4].width,
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
        x: COLUMN_CONFIG[4].centerX,
        y: startY + visibleWebsites.length * (ITEM_HEIGHT + websiteGap),
        width: COLUMN_CONFIG[4].width,
        height: ITEM_HEIGHT,
        isSynthetic: true,
      }
      list.push(node)
      map.set(node.id, node)
    }

    let maxBottom = 500
    list.forEach((n) => {
      maxBottom = Math.max(maxBottom, n.y + n.height)
    })

    return {
      nodes: list,
      nodeMap: map,
      canvasHeight: maxBottom + 40,
    }
  }, [
    visibleGroups,
    pagedModelPairs,
    visibleChannels,
    visibleAccounts,
    visibleWebsites,
    hasUnassignedAccount,
    hasUnassignedWebsite,
  ])

  // 6. 独立生成连线边（不因无 ability 或分页断链）
  const edges = React.useMemo(
    () => buildRouteEdges(currentAbilities, visibleChannels, visibleAccounts, nodeMap),
    [currentAbilities, visibleChannels, visibleAccounts, nodeMap],
  )

  // 7. 高亮匹配集合计算
  const highlightedElements = React.useMemo(
    () => getRouteHighlights(pinnedChannelId, hoveredNodeId, currentAbilities, visibleChannels, visibleAccounts, nodeMap, edges),
    [pinnedChannelId, hoveredNodeId, currentAbilities, visibleChannels, visibleAccounts, nodeMap, edges],
  )

  // 选中的渠道详情卡片数据
  const selectedChannel = React.useMemo(() => {
    if (pinnedChannelId === null) return null
    return channelMap.get(pinnedChannelId) ?? null
  }, [pinnedChannelId, channelMap])

  // 选中渠道所属的所有 Abilities (跨分组全量规则)
  const selectedChannelAbilities = React.useMemo(() => {
    if (!selectedChannel || !data?.abilities) return []
    return data.abilities.filter((a) => a.channel_id === selectedChannel.id)
  }, [selectedChannel, data])

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3.5 overflow-y-auto pr-1">
      {/* 1. 顶栏：快照状态说明与同步时间 */}
      <div className="rounded-lg border border-border/80 bg-muted/20 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shrink-0">
        <div className="flex items-start gap-2.5 min-w-0">
          <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5 min-w-0 text-[12px] leading-[16px]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-foreground">
                当前拓扑配置快照
              </span>
              <span className="text-muted-foreground">
                来自 NewAPI 当前路由配置（配置快照，不随 24 小时 / 7 天查询窗口改变）
              </span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground flex-wrap">
              <span>
                最近同步：{data?.synced_at ? formatTimestamp(data.synced_at) : "从未同步"}
              </span>
              {data?.last_attempt_at && data.last_attempt_at !== data.synced_at && (
                <>
                  <span>·</span>
                  <span>最近尝试：{formatTimestamp(data.last_attempt_at)}</span>
                </>
              )}
              <span>·</span>
              <span>
                {data?.channels.length ?? 0} 个渠道 · {data?.abilities.length ?? 0} 条规则 · {allGroups.length} 个分组
              </span>
              {data?.routes_available === false && (
                <Badge variant="outline" className="text-[12px] h-5 px-1.5 border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10">
                  {data.routes_error || "未获取到路由分流规则"}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
          {pinnedChannelId !== null && (
            <Button
              variant="outline"
              size="sm"
              className="text-[12px] h-7 px-2.5 text-muted-foreground"
              onClick={() => setPinnedChannelId(null)}
              aria-label="清除当前选中的渠道锁定"
            >
              <X className="size-3.5 mr-1" />
              清除锁定
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-[12px] h-7 px-2.5"
            onClick={handleManualRefresh}
            disabled={loading}
            aria-label="重新拉取拓扑快照"
          >
            <RefreshCw className={cn("size-3.5 mr-1", loading && "animate-spin")} />
            刷新快照
          </Button>
        </div>
      </div>

      {/* 初始加载状态（不画空白 1120 画布） */}
      {loading && !data && (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-muted-foreground text-[13px] flex flex-col items-center justify-center gap-2">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" />
          <span>正在加载渠道路由配置快照...</span>
        </div>
      )}

      {/* 初始请求网络失败 */}
      {fetchError && !data && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 flex flex-col items-center justify-center gap-2 text-destructive text-[13px]">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-5 shrink-0" />
            <span>获取拓扑快照失败：{fetchError}</span>
          </div>
          <Button variant="outline" size="sm" className="h-7 text-[12px] mt-1" onClick={handleManualRefresh}>
            重试
          </Button>
        </div>
      )}

      {/* 已有快照时重新拉取网络/服务失败：保留旧快照但明确展示错误条与重试按钮 */}
      {fetchError && data && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3.5 py-2.5 flex items-center justify-between gap-2 shrink-0 text-destructive text-[13px]">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>获取拓扑快照失败：{fetchError}（当前保留 {data.synced_at ? formatTimestamp(data.synced_at) : "既有"} 快照）</span>
          </div>
          <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={handleManualRefresh}>
            重试
          </Button>
        </div>
      )}

      {/* 尚未采集到快照 / 首次同步失败（明确显示具体错误，标尚无可用快照） */}
      {data && !data.available && (
        <div className="rounded-lg border border-border bg-muted/30 p-8 text-center text-muted-foreground text-[13px] flex flex-col items-center justify-center gap-1.5">
          <Info className="size-5 text-muted-foreground shrink-0" />
          <span className="font-medium text-foreground">尚无可用快照</span>
          <span>{data.error ? `同步异常：${data.error}` : "后台首次采集同步完成后将展示当前拓扑。"}</span>
          {data.last_attempt_at && (
            <span className="text-[12px]">最近尝试时间：{formatTimestamp(data.last_attempt_at)}</span>
          )}
        </div>
      )}

      {/* 合法空渠道状态 */}
      {data?.available && data.channels.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground text-[13px]">
          当前没有配置渠道。请在 NewAPI 中添加渠道后重新同步。
        </div>
      )}

      {/* 存在旧快照但新同步失败的错误提示条 */}
      {data?.available && data.error && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 flex items-center gap-2 shrink-0 text-amber-600 dark:text-amber-400 text-[12px]">
          <AlertTriangle className="size-4 shrink-0" />
          <span>快照同步异常：{data.error}（当前展示 {formatTimestamp(data.synced_at)} 旧快照；最近尝试时间：{formatTimestamp(data.last_attempt_at)}）</span>
        </div>
      )}

      {/* 2. 交互控制条、3. 5 层拓扑画布、4. 选中渠道锁定详情：仅在有可用快照且存在渠道时展示 */}
      {data?.available && data.channels.length > 0 && (
        <>
          {/* 2. 交互控制条：搜索、分组、账户筛选、分页与停用开关 */}
          <Card className="shadow-xs p-3 shrink-0 gap-0">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
            {/* 搜索框 */}
            <div className="relative min-w-[180px] max-w-[260px] flex-1">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索模型或渠道名..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  setCurrentPage(1)
                }}
                className="h-8 pl-8 text-[12px]"
                aria-label="搜索模型或渠道名"
              />
            </div>

            {/* 分组筛选 */}
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className="text-muted-foreground whitespace-nowrap">分组:</span>
              <select
                value={selectedGroup}
                onChange={(e) => {
                  setSelectedGroup(e.target.value)
                  setCurrentPage(1)
                }}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground focus-visible:border-ring outline-none"
                aria-label="按本站分组筛选"
              >
                <option value="all" className="bg-popover text-popover-foreground">全部分组 ({allGroups.length})</option>
                {allGroups.map((g) => (
                  <option key={g} value={g} className="bg-popover text-popover-foreground">
                    {g}
                  </option>
                ))}
              </select>
            </div>

            {/* 账户筛选 */}
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className="text-muted-foreground whitespace-nowrap">账户:</span>
              <select
                value={selectedAccount}
                onChange={(e) => {
                  setSelectedAccount(e.target.value)
                  setCurrentPage(1)
                }}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12px] text-foreground focus-visible:border-ring outline-none max-w-[180px] truncate"
                aria-label="按上游财务账户筛选"
              >
                <option value="all" className="bg-popover text-popover-foreground">全部账户 ({allAccounts.length})</option>
                {allAccounts.map((a) => (
                  <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                    {a.name || a.id}
                  </option>
                ))}
              </select>
            </div>

            {/* 包含停用渠道开关 */}
            <div className="flex items-center gap-1.5 ml-1">
              <Checkbox
                id="includeDisabled"
                checked={includeDisabled}
                onCheckedChange={(c) => setIncludeDisabled(Boolean(c))}
              />
              <label htmlFor="includeDisabled" className="text-[12px] text-muted-foreground cursor-pointer select-none">
                包含停用渠道
              </label>
            </div>
          </div>

          {/* 分页控制器 */}
          <div className="flex items-center gap-2.5 shrink-0 self-end lg:self-auto text-[12px] text-muted-foreground">
            <span>
              第 {uniqueModelPairs.length === 0 ? 0 : (effectivePage - 1) * PAGE_SIZE + 1} -{" "}
              {Math.min(effectivePage * PAGE_SIZE, uniqueModelPairs.length)} 项 / 共 {uniqueModelPairs.length} 个分组与模型组合
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="size-7 p-0"
                onClick={() => setCurrentPage(Math.max(1, effectivePage - 1))}
                disabled={effectivePage <= 1}
                aria-label="上一页模型"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <span className="px-1 font-mono text-foreground font-medium">
                {effectivePage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="size-7 p-0"
                onClick={() => setCurrentPage(Math.min(totalPages, effectivePage + 1))}
                disabled={effectivePage >= totalPages}
                aria-label="下一页模型"
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>

        {/* 过滤提示条 */}
        <div className="mt-2 pt-2 border-t border-border/50 text-[12px] text-muted-foreground flex items-center justify-between">
          <span>搜索和筛选仅影响左侧路由；右侧保留全部渠道及账户关联。</span>
          {pinnedChannelId !== null && (
            <span className="text-primary font-medium">已锁定渠道 #{pinnedChannelId}（点击画布任意空白处解除）</span>
          )}
        </div>
      </Card>

      {/* 3. 5 层拓扑画布 (统一度量衡，列标题处于同滚动面) */}
      <Card className="shadow-xs overflow-hidden flex flex-col min-w-0 flex-1 gap-0">
        <div
          className="relative w-full overflow-x-auto overflow-y-auto flex-1 min-h-[520px] select-none p-4"
          onClick={() => {
            if (pinnedChannelId !== null) {
              setPinnedChannelId(null)
            }
          }}
        >
          {/* 画布固定宽度与真实高度 */}
          <div
            className="relative mx-auto"
            style={{ width: `${CANVAS_WIDTH}px`, height: `${canvasHeight}px` }}
          >
            {/* 列标题 Header（与节点共用同一 centerX / width，绝对像素居中严格对齐） */}
            <div className="absolute top-0 left-0 w-full h-9 border-b border-border bg-muted/40 text-[13px] font-medium text-muted-foreground z-10 rounded-t-lg">
              {COLUMN_CONFIG.map((col) => (
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

            {/* SVG 连线层（1:1 像素与 DOM 节点完全对准） */}
            <svg
              className="absolute inset-0 size-full pointer-events-none z-0"
              width={CANVAS_WIDTH}
              height={canvasHeight}
              viewBox={`0 0 ${CANVAS_WIDTH} ${canvasHeight}`}
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

            {/* DOM 节点层（统一使用 <button> 支持无障碍键盘聚焦与点击） */}
            {nodes.map((node) => {
              const isPinned = node.kind === "channel" && pinnedChannelId === node.rawId
              const isNodeActive = highlightedElements ? highlightedElements.nodeIds.has(node.id) : false
              const isDimmed = highlightedElements !== null && !isNodeActive && !isPinned

              const isChannelDisabled = node.kind === "channel" && node.state === "disabled"
              const isChannelUnknown = node.kind === "channel" && node.state === "unknown"

              let icon = <Layers className="size-3.5 text-muted-foreground shrink-0" />
              if (node.kind === "model") icon = <Cpu className="size-3.5 text-muted-foreground shrink-0" />
              if (node.kind === "channel") icon = <Radio className="size-3.5 text-muted-foreground shrink-0" />
              if (node.kind === "account") icon = node.isSynthetic ? <HelpCircle className="size-3.5 text-muted-foreground shrink-0" /> : <Server className="size-3.5 text-muted-foreground shrink-0" />
              if (node.kind === "website") icon = node.isSynthetic ? <HelpCircle className="size-3.5 text-muted-foreground shrink-0" /> : <Globe className="size-3.5 text-muted-foreground shrink-0" />

              // 边框与高亮样式（停用节点保持灰显，严禁刷 primary）
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
                    "rounded-lg border px-2 py-1 shadow-2xs flex items-center justify-between text-[12px] text-left transition-all z-10 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    styleClass,
                    isDimmed && "opacity-25",
                    node.isSynthetic && "border-dashed bg-muted/30 text-muted-foreground"
                  )}
                  aria-label={`${COLUMN_CONFIG.find((c) => c.key === node.kind)?.label || ""}: ${node.label}`}
                >
                  <div className="flex items-center gap-1.5 truncate flex-1 min-w-0">
                    {icon}
                    <span className={cn("truncate", node.kind === "model" && "font-mono")} title={node.subLabel ? `${node.label} (${node.subLabel})` : node.label}>
                      {node.label}
                    </span>
                  </div>

                  {/* 状态徽标与标识 */}
                  {node.kind === "channel" && (
                    <div className="flex items-center gap-1 shrink-0">
                      {isChannelDisabled ? (
                        <Badge variant="outline" className="text-[12px] h-5 px-1 text-rose-600 dark:text-rose-400 border-rose-500/30">
                          停用
                        </Badge>
                      ) : isChannelUnknown ? (
                        <Badge variant="outline" className="text-[12px] h-5 px-1 text-muted-foreground">
                          未知
                        </Badge>
                      ) : (
                        <span className="size-2 rounded-full bg-emerald-500 shrink-0" title="已启用" />
                      )}
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

                  {node.kind === "model" && node.subLabel && (
                    <Badge variant="outline" className="text-[12px] h-4.5 px-1 shrink-0 text-muted-foreground font-mono">
                      {node.subLabel}
                    </Badge>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </Card>

      {/* 4. 锁定渠道详情抽屉/卡片（展示 priority/weight 真实路由表与 mapping） */}
      {selectedChannel && (
        <Card className="shadow-xs p-4 shrink-0 gap-3 border-primary/40 bg-card">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <Radio className="size-4 text-primary shrink-0" />
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px] leading-[16px]">
            {/* 接口地址 */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">接口地址 (仅展示域名)</span>
              <span className="font-mono text-foreground truncate" title={selectedChannel.endpoint || "未配置"}>
                {selectedChannel.endpoint || "未配置"}
              </span>
            </div>

            {/* 所属财务账户 */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">关联财务账户</span>
              <span className="text-foreground">
                {selectedChannel.account_ids && selectedChannel.account_ids.length > 0 ? (
                  selectedChannel.account_ids
                    .map((id) => accountMap.get(id)?.name || id)
                    .join("、")
                ) : (
                  <span className="text-muted-foreground">未关联财务账户</span>
                )}
              </span>
            </div>

            {/* 模型重写 */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col gap-1">
              <span className="text-muted-foreground font-medium">模型重写 (Model Mapping)</span>
              {selectedChannel.mapping_error ? (
                <span className="text-destructive truncate" title={selectedChannel.mapping_error}>
                  配置读取异常: {selectedChannel.mapping_error}
                </span>
              ) : selectedChannel.model_mapping && Object.keys(selectedChannel.model_mapping).length > 0 ? (
                <div className="flex flex-col gap-0.5 font-mono text-[12px]">
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

          {/* 该渠道关联的 Abilities 真实路由参数表 (优先级 / 权重) */}
          <div className="pt-1">
            <span className="text-[12px] font-medium text-foreground block mb-1.5">
              命中此渠道的路由分流规则 (共 {selectedChannelAbilities.length} 条，渠道状态见上方卡头)
            </span>
            {selectedChannelAbilities.length === 0 ? (
              <div className="text-[12px] text-muted-foreground rounded-lg border border-border/60 p-2.5 bg-muted/10">
                该渠道当前无关联的分流规则 (Abilities)。可能尚未配置模型分配，或规则已被删除。
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="max-h-[160px] overflow-y-auto">
                  <table className="w-full text-[12px] text-left">
                    <thead className="bg-muted/50 border-b border-border sticky top-0 text-muted-foreground">
                      <tr>
                        <th className="px-2.5 py-1.5 font-medium">分组</th>
                        <th className="px-2.5 py-1.5 font-medium">请求模型</th>
                        <th className="px-2.5 py-1.5 font-medium">规则状态</th>
                        <th className="px-2.5 py-1.5 font-medium text-right font-mono">优先级 (Priority)</th>
                        <th className="px-2.5 py-1.5 font-medium text-right font-mono">权重 (Weight)</th>
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
                            <td className="px-2.5 py-1 text-foreground">{ab.group}</td>
                            <td className="px-2.5 py-1 font-mono text-foreground">{ab.model}</td>
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
