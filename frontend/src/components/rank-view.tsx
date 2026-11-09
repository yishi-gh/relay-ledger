import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChevronRight, Inbox } from "lucide-react"
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "@/lib/recharts-sized"
import { formatCurrency, formatNumber, formatPercent } from "@/lib/formatters"
import {
  getDeterministicChartColor,
  formatTokenCn,
  type UserRowData,
} from "@/components/table-utils"
import type { ChannelRowData } from "@/components/channels-rank-view"
import type { GroupRowData } from "@/components/groups-rank-view"
import { cn } from "@/lib/utils"

interface RankViewProps {
  timeRange: "24h" | "7d"
  channels: ChannelRowData[]
  groups: GroupRowData[]
  users: UserRowData[]
  onNavigateChannelsDetail: () => void
  onNavigateGroupsDetail: () => void
}

export function RankView({
  channels,
  groups,
  users,
  onNavigateChannelsDetail,
  onNavigateGroupsDetail,
}: RankViewProps) {
  // 1. 渠道数据、Top 5 与 Donut 数据
  const sortedChannels = React.useMemo(() => {
    return [...channels].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  }, [channels])

  const totalChannelRevenue = React.useMemo(() => {
    return sortedChannels.reduce((sum, r) => sum + (r.revenue ?? 0), 0)
  }, [sortedChannels])

  const top1Channel = sortedChannels[0] || null
  const top1ChannelShare =
    totalChannelRevenue > 0 && top1Channel
      ? (top1Channel.revenue ?? 0) / totalChannelRevenue
      : null

  const top5Channels = React.useMemo(() => {
    return sortedChannels.slice(0, 5).map((r, index) => ({
      key: `ch-${r.channel_id}`,
      rank: index + 1,
      id: r.channel_id,
      name: r.channel_name || `渠道 #${r.channel_id}`,
      revenue: r.revenue ?? 0,
      color: getDeterministicChartColor(r.channel_id),
      share: totalChannelRevenue > 0 ? (r.revenue ?? 0) / totalChannelRevenue : 0,
    }))
  }, [sortedChannels, totalChannelRevenue])

  const maxChannelRevenue = Math.max(
    ...top5Channels.map((i) => i.revenue),
    0.0001
  )
  const remainingChannelsCount = Math.max(0, sortedChannels.length - 5)

  const channelDonutData = React.useMemo(() => {
    const data = top5Channels
      .filter((i) => i.revenue > 0)
      .map((i) => ({
        name: i.name,
        value: i.revenue,
        color: i.color,
        share: i.share,
      }))
    const top5Sum = top5Channels.reduce((s, i) => s + i.revenue, 0)
    const otherRevenue = Math.max(0, totalChannelRevenue - top5Sum)
    if (otherRevenue > 0.001) {
      data.push({
        name: `其它 (${remainingChannelsCount} 个渠道)`,
        value: otherRevenue,
        color: "var(--muted-foreground)",
        share: totalChannelRevenue > 0 ? otherRevenue / totalChannelRevenue : 0,
      })
    }
    return data
  }, [top5Channels, totalChannelRevenue, remainingChannelsCount])

  // 2. 分组数据、Top 5 与 Donut 数据
  const sortedGroups = React.useMemo(() => {
    return [...groups].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  }, [groups])

  const totalGroupRevenue = React.useMemo(() => {
    return sortedGroups.reduce((sum, g) => sum + (g.revenue ?? 0), 0)
  }, [sortedGroups])

  const top1Group = sortedGroups[0] || null
  const top1GroupShare =
    totalGroupRevenue > 0 && top1Group
      ? (top1Group.revenue ?? 0) / totalGroupRevenue
      : null

  const top5Groups = React.useMemo(() => {
    return sortedGroups.slice(0, 5).map((g, index) => ({
      key: `grp-${g.group_name || "ungrouped"}-${index}`,
      rank: index + 1,
      name: g.group_name || "未分组",
      revenue: g.revenue ?? 0,
      color: getDeterministicChartColor(g.group_name || "未分组"),
      share: totalGroupRevenue > 0 ? (g.revenue ?? 0) / totalGroupRevenue : 0,
    }))
  }, [sortedGroups, totalGroupRevenue])

  const maxGroupRevenue = Math.max(
    ...top5Groups.map((i) => i.revenue),
    0.0001
  )
  const remainingGroupsCount = Math.max(0, sortedGroups.length - 5)

  const groupDonutData = React.useMemo(() => {
    const data = top5Groups
      .filter((i) => i.revenue > 0)
      .map((i) => ({
        name: i.name,
        value: i.revenue,
        color: i.color,
        share: i.share,
      }))
    const top5Sum = top5Groups.reduce((s, i) => s + i.revenue, 0)
    const otherRevenue = Math.max(0, totalGroupRevenue - top5Sum)
    if (otherRevenue > 0.001) {
      data.push({
        name: `其它 (${remainingGroupsCount} 个分组)`,
        value: otherRevenue,
        color: "var(--muted-foreground)",
        share: totalGroupRevenue > 0 ? otherRevenue / totalGroupRevenue : 0,
      })
    }
    return data
  }, [top5Groups, totalGroupRevenue, remainingGroupsCount])

  // 3. 用户数据、Top 5 与 Donut 数据
  const sortedUsers = React.useMemo(() => {
    return [...users].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  }, [users])

  const totalUserRevenue = React.useMemo(() => {
    return sortedUsers.reduce((sum, u) => sum + (u.revenue ?? 0), 0)
  }, [sortedUsers])

  const top1User = sortedUsers[0] || null
  const top1UserShare =
    totalUserRevenue > 0 && top1User
      ? (top1User.revenue ?? 0) / totalUserRevenue
      : null

  const top5Users = React.useMemo(() => {
    return sortedUsers.slice(0, 5).map((u, index) => ({
      key: `usr-${u.user_name}-${index}`,
      rank: index + 1,
      name: u.user_name || "匿名用户",
      revenue: u.revenue ?? 0,
      requests: u.requests ?? 0,
      tokens: u.tokens ?? 0,
      color: getDeterministicChartColor(u.user_name || "匿名用户"),
      share: u.share ?? (totalUserRevenue > 0 ? u.revenue / totalUserRevenue : 0),
    }))
  }, [sortedUsers, totalUserRevenue])

  const maxUserRevenue = Math.max(
    ...top5Users.map((i) => i.revenue),
    0.0001
  )
  const remainingUsersCount = Math.max(0, sortedUsers.length - 5)

  const userDonutData = React.useMemo(() => {
    const data = top5Users
      .filter((i) => i.revenue > 0)
      .map((i) => ({
        name: i.name,
        value: i.revenue,
        color: i.color,
        share: i.share,
      }))
    const top5Sum = top5Users.reduce((s, i) => s + i.revenue, 0)
    const otherRevenue = Math.max(0, totalUserRevenue - top5Sum)
    if (otherRevenue > 0.001) {
      data.push({
        name: `其它 (${remainingUsersCount} 个用户)`,
        value: otherRevenue,
        color: "var(--muted-foreground)",
        share: totalUserRevenue > 0 ? otherRevenue / totalUserRevenue : 0,
      })
    }
    return data
  }, [top5Users, totalUserRevenue, remainingUsersCount])

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-3.5">
      {/* 三张卡竖向排列：渠道排行 / 分组排行 / 用户排行，各占约 1/3 高度 (grid-rows-3) */}
      <div className="grid grid-rows-3 gap-3.5 h-full min-h-0 flex-1 max-md:flex max-md:flex-col max-md:gap-3 max-md:h-auto">
        {/* 卡 1：渠道售出排行 */}
        <Card className="h-auto md:h-full md:min-h-0 shadow-xs overflow-hidden flex flex-col p-3.5">
          <CardHeader className="p-0 pb-2 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              渠道售出排行
            </CardTitle>

            {/* 卡头右端小字：全站 $77.22 · 7 个渠道 · Top1 33.9% */}
            <div className="flex items-center gap-1.5 text-[12px] leading-[16px] text-muted-foreground font-mono tabular-nums select-none">
              <span>全站 <strong className="text-foreground font-semibold">{formatCurrency(totalChannelRevenue)}</strong></span>
              <span>·</span>
              <span><strong className="text-foreground font-semibold">{sortedChannels.length}</strong> 个渠道</span>
              <span>·</span>
              <span>Top1 <strong className="text-foreground font-semibold">{formatPercent(top1ChannelShare)}</strong></span>
              {remainingChannelsCount > 0 && (
                <>
                  <span>·</span>
                  <span className="text-muted-foreground/80 font-sans" title={`前 5 名展示，另有 ${remainingChannelsCount} 个渠道未列出`}>
                    另有 {remainingChannelsCount} 项
                  </span>
                </>
              )}
            </div>
          </CardHeader>

          <CardContent className="p-0 flex-1 min-h-0 overflow-hidden flex flex-col md:flex-row items-center gap-4">
            {top5Channels.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-6 text-muted-foreground gap-1.5">
                <Inbox className="size-5 opacity-40" />
                <span className="text-[12px] leading-[16px]">当前时间窗口暂无渠道数据</span>
              </div>
            ) : (
              <>
                {/* 左侧：严格 5 行条形列表 (flex-1) */}
                <div className="flex-1 min-w-0 flex flex-col gap-1 py-0.5 justify-center">
                  {top5Channels.map((item) => {
                    const pct = Math.max(2, Math.min(100, (item.revenue / maxChannelRevenue) * 100))

                    return (
                      <div
                        key={item.key}
                        data-slot="rank-item"
                        onClick={onNavigateChannelsDetail}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            onNavigateChannelsDetail()
                          }
                        }}
                        className={cn(
                          "group h-[36px] flex items-center gap-2 px-2.5 rounded-md transition-colors cursor-pointer outline-none select-none",
                          "hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
                        )}
                      >
                        {/* 统一形态的圆点排名徽标 */}
                        <span
                          className={cn(
                            "size-5 rounded-full font-mono text-[12px] leading-[16px] font-medium flex items-center justify-center shrink-0",
                            item.rank === 1
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : item.rank === 2
                              ? "bg-slate-400/20 text-slate-600 dark:text-slate-300"
                              : item.rank === 3
                              ? "bg-orange-500/15 text-orange-600 dark:text-orange-400"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {item.rank}
                        </span>

                        {/* 渠道名称与 ID */}
                        <div className="w-28 sm:w-40 md:w-48 shrink-0 flex items-center gap-1.5 text-[14px] leading-[20px] min-w-0">
                          <span className="font-mono text-[12px] leading-[16px] text-muted-foreground shrink-0">
                            #{item.id}
                          </span>
                          <span className="line-clamp-2 text-foreground font-normal" title={item.name}>
                            {item.name}
                          </span>
                        </div>

                        {/* 横向条形图 */}
                        <div className="flex-1 min-w-0 flex items-center">
                          <div className="h-1.5 w-full rounded-full bg-muted/60 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: item.color,
                                opacity: 0.85,
                              }}
                            />
                          </div>
                        </div>

                        {/* 金额与占比 */}
                        <div className="shrink-0 flex items-center gap-2 text-right">
                          <span className="font-mono tabular-nums text-[14px] sm:text-[16px] leading-[20px] sm:leading-[24px] font-semibold text-foreground w-16 sm:w-20">
                            {formatCurrency(item.revenue)}
                          </span>
                          <span className="font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground w-11 hidden sm:inline-block">
                            {formatPercent(item.share)}
                          </span>
                          <ChevronRight className="size-3.5 text-muted-foreground/40 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* 右侧：环形饼图 (Donut) 固定宽 120px、垂直居中、环心放 Top1 占比 */}
                <div
                  data-slot="donut-container"
                  className="relative size-[110px] min-[480px]:size-[140px] md:size-[150px] xl:size-[168px] shrink-0 self-center mx-auto flex items-center justify-center my-1 md:my-0"
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null
                          const entry = payload[0].payload
                          return (
                            <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] leading-[16px] shadow-md space-y-0.5">
                              <div className="font-medium text-foreground">{entry.name}</div>
                              <div className="flex items-center gap-2 text-muted-foreground font-mono tabular-nums text-[12px]">
                                <span className="text-foreground font-semibold">
                                  {formatCurrency(entry.value)}
                                </span>
                                <span>·</span>
                                <span>{formatPercent(entry.share)}</span>
                              </div>
                            </div>
                          )
                        }}
                      />
                      <Pie
                        data={channelDonutData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius="62%"
                        outerRadius="92%"
                        paddingAngle={2}
                        stroke="none"
                        isAnimationActive={false}
                      >
                        {channelDonutData.map((entry, index) => (
                          <Cell
                            key={`ch-cell-${index}`}
                            fill={entry.color}
                            data-name={entry.name}
                            data-color={entry.color}
                          />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  {/* 环心一行小字：Top1 占比 (14px/20px/600 mono) */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
                    <span className="text-[14px] sm:text-[18px] leading-[20px] sm:leading-[24px] font-semibold font-mono tabular-nums text-foreground">
                      {formatPercent(top1ChannelShare)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* 卡 2：业务分组售出排行 */}
        <Card className="h-auto md:h-full md:min-h-0 shadow-xs overflow-hidden flex flex-col p-3.5">
          <CardHeader className="p-0 pb-2 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              业务分组售出排行
            </CardTitle>

            {/* 卡头右端小字：不重复写全站金额 */}
            <div className="flex items-center gap-1.5 text-[12px] leading-[16px] text-muted-foreground font-mono tabular-nums select-none">
              <span><strong className="text-foreground font-semibold">{sortedGroups.length}</strong> 个分组</span>
              <span>·</span>
              <span>Top1 <strong className="text-foreground font-semibold">{formatPercent(top1GroupShare)}</strong></span>
              {remainingGroupsCount > 0 && (
                <>
                  <span>·</span>
                  <span className="text-muted-foreground/80 font-sans" title={`前 5 名展示，另有 ${remainingGroupsCount} 个分组未列出`}>
                    另有 {remainingGroupsCount} 项
                  </span>
                </>
              )}
            </div>
          </CardHeader>

          <CardContent className="p-0 flex-1 min-h-0 overflow-hidden flex flex-col md:flex-row items-center gap-4">
            {top5Groups.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-6 text-muted-foreground gap-1.5">
                <Inbox className="size-5 opacity-40" />
                <span className="text-[12px] leading-[16px]">当前时间窗口暂无分组数据</span>
              </div>
            ) : (
              <>
                {/* 左侧：严格 5 行条形列表 (flex-1) */}
                <div className="flex-1 min-w-0 flex flex-col gap-1 py-0.5 justify-center">
                  {top5Groups.map((item) => {
                    const pct = Math.max(2, Math.min(100, (item.revenue / maxGroupRevenue) * 100))

                    return (
                      <div
                        key={item.key}
                        data-slot="rank-item"
                        onClick={onNavigateGroupsDetail}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            onNavigateGroupsDetail()
                          }
                        }}
                        className={cn(
                          "group h-[36px] flex items-center gap-2 px-2.5 rounded-md transition-colors cursor-pointer outline-none select-none",
                          "hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
                        )}
                      >
                        {/* 统一形态的圆点排名徽标 */}
                        <span
                          className={cn(
                            "size-5 rounded-full font-mono text-[12px] leading-[16px] font-medium flex items-center justify-center shrink-0",
                            item.rank === 1
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : item.rank === 2
                              ? "bg-slate-400/20 text-slate-600 dark:text-slate-300"
                              : item.rank === 3
                              ? "bg-orange-500/15 text-orange-600 dark:text-orange-400"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {item.rank}
                        </span>

                        {/* 分组名称 */}
                        <div className="w-28 sm:w-40 md:w-48 shrink-0 flex items-center gap-1.5 text-[14px] leading-[20px] min-w-0">
                          <span className="line-clamp-2 text-foreground font-normal" title={item.name}>
                            {item.name}
                          </span>
                        </div>

                        {/* 横向条形图 */}
                        <div className="flex-1 min-w-0 flex items-center">
                          <div className="h-1.5 w-full rounded-full bg-muted/60 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: item.color,
                                opacity: 0.85,
                              }}
                            />
                          </div>
                        </div>

                        {/* 金额与占比 */}
                        <div className="shrink-0 flex items-center gap-2 text-right">
                          <span className="font-mono tabular-nums text-[14px] sm:text-[16px] leading-[20px] sm:leading-[24px] font-semibold text-foreground w-16 sm:w-20">
                            {formatCurrency(item.revenue)}
                          </span>
                          <span className="font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground w-11 hidden sm:inline-block">
                            {formatPercent(item.share)}
                          </span>
                          <ChevronRight className="size-3.5 text-muted-foreground/40 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* 右侧：环形饼图 (Donut) 固定宽 120px、垂直居中、环心放 Top1 占比 */}
                <div
                  data-slot="donut-container"
                  className="relative size-[110px] min-[480px]:size-[140px] md:size-[150px] xl:size-[168px] shrink-0 self-center mx-auto flex items-center justify-center my-1 md:my-0"
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null
                          const entry = payload[0].payload
                          return (
                            <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] leading-[16px] shadow-md space-y-0.5">
                              <div className="font-medium text-foreground">{entry.name}</div>
                              <div className="flex items-center gap-2 text-muted-foreground font-mono tabular-nums text-[12px]">
                                <span className="text-foreground font-semibold">
                                  {formatCurrency(entry.value)}
                                </span>
                                <span>·</span>
                                <span>{formatPercent(entry.share)}</span>
                              </div>
                            </div>
                          )
                        }}
                      />
                      <Pie
                        data={groupDonutData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius="62%"
                        outerRadius="92%"
                        paddingAngle={2}
                        stroke="none"
                        isAnimationActive={false}
                      >
                        {groupDonutData.map((entry, index) => (
                          <Cell
                            key={`grp-cell-${index}`}
                            fill={entry.color}
                            data-name={entry.name}
                            data-color={entry.color}
                          />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  {/* 环心一行小字：Top1 占比 (14px/20px/600 mono) */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
                    <span className="text-[14px] sm:text-[18px] leading-[20px] sm:leading-[24px] font-semibold font-mono tabular-nums text-foreground">
                      {formatPercent(top1GroupShare)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* 卡 3：用户排行 */}
        <Card className="h-auto md:h-full md:min-h-0 shadow-xs overflow-hidden flex flex-col p-3.5">
          <CardHeader className="p-0 pb-2 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              用户售出排行
            </CardTitle>

            {/* 卡头右端小字：9 个用户 · Top1 58.0% · 另有 N 项 */}
            <div className="flex items-center gap-1.5 text-[12px] leading-[16px] text-muted-foreground font-mono tabular-nums select-none">
              <span><strong className="text-foreground font-semibold">{sortedUsers.length}</strong> 个用户</span>
              <span>·</span>
              <span>Top1 <strong className="text-foreground font-semibold">{formatPercent(top1UserShare)}</strong></span>
              {remainingUsersCount > 0 && (
                <>
                  <span>·</span>
                  <span className="text-muted-foreground/80 font-sans" title={`前 5 名展示，另有 ${remainingUsersCount} 个用户未列出`}>
                    另有 {remainingUsersCount} 项
                  </span>
                </>
              )}
            </div>
          </CardHeader>

          <CardContent className="p-0 flex-1 min-h-0 overflow-hidden flex flex-col md:flex-row items-center gap-4">
            {top5Users.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center py-6 text-muted-foreground gap-1.5">
                <Inbox className="size-5 opacity-40" />
                <span className="text-[12px] leading-[16px]">当前时间窗口暂无用户数据</span>
              </div>
            ) : (
              <>
                {/* 左侧：严格 5 行条形列表 (flex-1) */}
                <div className="flex-1 min-w-0 flex flex-col gap-1 py-0.5 justify-center">
                  {top5Users.map((item) => {
                    const pct = Math.max(2, Math.min(100, (item.revenue / maxUserRevenue) * 100))

                    return (
                      <div
                        key={item.key}
                        data-slot="rank-item"
                        title={`请求 ${formatNumber(item.requests)} 次 · Token ${formatTokenCn(item.tokens)}`}
                        className={cn(
                          "group h-[36px] flex items-center gap-2 px-2.5 rounded-md transition-colors outline-none select-none",
                          "hover:bg-accent/40 cursor-default"
                        )}
                      >
                        {/* 统一形态的圆点排名徽标 */}
                        <span
                          className={cn(
                            "size-5 rounded-full font-mono text-[12px] leading-[16px] font-medium flex items-center justify-center shrink-0",
                            item.rank === 1
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : item.rank === 2
                              ? "bg-slate-400/20 text-slate-600 dark:text-slate-300"
                              : item.rank === 3
                              ? "bg-orange-500/15 text-orange-600 dark:text-orange-400"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {item.rank}
                        </span>

                        {/* 用户名 */}
                        <div className="w-28 sm:w-40 md:w-48 shrink-0 flex items-center gap-1.5 text-[14px] leading-[20px] min-w-0">
                          <span className="line-clamp-2 text-foreground font-normal" title={item.name}>
                            {item.name}
                          </span>
                        </div>

                        {/* 横向条形图 */}
                        <div className="flex-1 min-w-0 flex items-center">
                          <div className="h-1.5 w-full rounded-full bg-muted/60 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: item.color,
                                opacity: 0.85,
                              }}
                            />
                          </div>
                        </div>

                        {/* 金额与占比 */}
                        <div className="shrink-0 flex items-center gap-2 text-right">
                          <span className="font-mono tabular-nums text-[14px] sm:text-[16px] leading-[20px] sm:leading-[24px] font-semibold text-foreground w-16 sm:w-20">
                            {formatCurrency(item.revenue)}
                          </span>
                          <span className="font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground w-11 hidden sm:inline-block">
                            {formatPercent(item.share)}
                          </span>
                          <span className="size-3.5 shrink-0" />
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* 右侧：环形饼图 (Donut) 固定宽 120px、垂直居中、环心放 Top1 占比 */}
                <div
                  data-slot="donut-container"
                  className="relative size-[110px] min-[480px]:size-[140px] md:size-[150px] xl:size-[168px] shrink-0 self-center mx-auto flex items-center justify-center my-1 md:my-0"
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null
                          const entry = payload[0].payload
                          return (
                            <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] leading-[16px] shadow-md space-y-0.5">
                              <div className="font-medium text-foreground">{entry.name}</div>
                              <div className="flex items-center gap-2 text-muted-foreground font-mono tabular-nums text-[12px]">
                                <span className="text-foreground font-semibold">
                                  {formatCurrency(entry.value)}
                                </span>
                                <span>·</span>
                                <span>{formatPercent(entry.share)}</span>
                              </div>
                            </div>
                          )
                        }}
                      />
                      <Pie
                        data={userDonutData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius="62%"
                        outerRadius="92%"
                        paddingAngle={2}
                        stroke="none"
                        isAnimationActive={false}
                      >
                        {userDonutData.map((entry, index) => (
                          <Cell
                            key={`usr-cell-${index}`}
                            fill={entry.color}
                            data-name={entry.name}
                            data-color={entry.color}
                          />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  {/* 环心一行小字：Top1 占比 (14px/20px/600 mono) */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
                    <span className="text-[14px] sm:text-[18px] leading-[20px] sm:leading-[24px] font-semibold font-mono tabular-nums text-foreground">
                      {formatPercent(top1UserShare)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
