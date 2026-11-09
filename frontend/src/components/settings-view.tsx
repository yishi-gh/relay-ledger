import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Server,
  Info,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  HardDrive,
  Clock,
  Palette,
  Globe,
  Coins,
} from "lucide-react"
import { formatNumber } from "@/lib/formatters"
import { formatBeijingTime } from "@/components/top-bar"
import { useTheme } from "@/components/theme-provider"
import { fetchHealthz, type Meta } from "@/lib/api"
import { cn } from "@/lib/utils"

interface SettingsViewProps {
  meta: Meta | null
  lastRefreshTime?: number
}

interface ApiEndpointItem {
  path: string
  name: string
  interval: string
  description: string
}

const API_ENDPOINTS: ApiEndpointItem[] = [
  { path: "/api/healthz", name: "服务健康检查", interval: "实时探测", description: "后端进程健康心跳与探针响应" },
  { path: "/api/meta", name: "元数据与配置", interval: "15 分钟", description: "实例站点名、基础地址、币种汇率及数据边界" },
  { path: "/api/overview", name: "经营总览", interval: "15 分钟", description: "全站售出额、Token 吞吐、请求总量与综合毛利率" },
  { path: "/api/trend", name: "售出趋势", interval: "15 分钟", description: "小时/自然日级售出金额堆叠与调用走势" },
  { path: "/api/profit", name: "盈利面板", interval: "15 分钟", description: "上游供应商账户成本、利润与毛利率账本对账" },
  { path: "/api/models", name: "模型经营", interval: "15 分钟", description: "按模型聚合售出、请求、Token 及每亿 Token 均价" },
  { path: "/api/channels", name: "渠道明细", interval: "15 分钟", description: "下游渠道经营表现、TPS 速率与延迟分位数" },
  { path: "/api/groups", name: "分组明细", interval: "15 分钟", description: "业务分组维度用量、售出额与渠道聚合明细" },
  { path: "/api/capital", name: "资金与续航", interval: "15 分钟", description: "上游账户实时余额流水、7日日均消耗与续航天数" },
  { path: "/api/upstreams", name: "上游账户", interval: "15 分钟", description: "上游各供应商账户配置状态、渠道归属与期末余额" },
  { path: "/api/quality", name: "数据质量", interval: "15 分钟", description: "日志同步任务、采集耗时、缺快照及 Schema 状态" },
  { path: "/api/errors", name: "HTTP 错误", interval: "15 分钟", description: "Nginx 4xx/5xx 小时分桶、Top 状态码与路径分布" },
]

export function SettingsView({ meta, lastRefreshTime }: SettingsViewProps) {
  const { theme } = useTheme()
  const [healthOk, setHealthOk] = React.useState<boolean | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [lastCheckMs, setLastCheckMs] = React.useState<number>(Date.now())

  const checkHealth = React.useCallback(async () => {
    setChecking(true)
    try {
      const res = await fetchHealthz()
      setHealthOk(Boolean(res?.ok))
    } catch {
      // 离线开发环境降级或后端未部署
      setHealthOk(meta?.preview ? true : false)
    } finally {
      setChecking(false)
      setLastCheckMs(Date.now())
    }
  }, [meta?.preview])

  React.useEffect(() => {
    void checkHealth()
  }, [checkHealth])

  const themeDisplay =
    theme === "dark" ? "暗色模式 (Dark)" : theme === "light" ? "亮色模式 (Light)" : "跟随系统 (System)"

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-3.5">
      {/* 1. 只读说明提示横条 */}
      <div className="rounded-lg border border-border/80 bg-muted/30 px-3.5 py-2.5 flex items-start gap-2.5 shrink-0">
        <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <p className="text-[12px] leading-[16px] text-muted-foreground">
            配置在服务器的 <span className="font-mono text-foreground font-medium">instance.json</span>，需改后重启服务，本页只读。系统不提供在线修改接口，确保生产配置受 Git 与运维脚本严格管护。
          </p>
          <Badge variant="outline" className="text-[12px] leading-[16px] h-5 px-1.5 shrink-0 self-start sm:self-auto font-medium text-muted-foreground">
            只读视图
          </Badge>
        </div>
      </div>

      {/* 2. 实例基本信息卡片 */}
      <Card className="shadow-xs p-4 shrink-0">
        <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              实例配置信息
            </CardTitle>
            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium">
              {meta?.preview ? "预览模式 (Preview)" : "生产环境 (Production)"}
            </Badge>
          </div>
          <Server className="size-4 text-muted-foreground" />
        </CardHeader>

        <CardContent className="p-0">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
            {/* 站点名 */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Globe className="size-3.5" />
                <span className="text-[12px] leading-[16px] font-medium">站点名称</span>
              </div>
              <span className="text-[14px] leading-[20px] font-medium text-foreground mt-1 truncate capitalize" title={meta?.site_name || meta?.site || "Madfu"}>
                {meta?.site_name || meta?.site || "Madfu"}
              </span>
            </div>

            {/* Base URL */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Globe className="size-3.5" />
                <span className="text-[12px] leading-[16px] font-medium">基础地址</span>
              </div>
              <span className="text-[14px] leading-[20px] font-mono text-foreground mt-1 truncate" title={meta?.base_url || "https://ai.aobzii.cn"}>
                {meta?.base_url || "https://ai.aobzii.cn"}
              </span>
            </div>

            {/* 数据目录 */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <HardDrive className="size-3.5" />
                <span className="text-[12px] leading-[16px] font-medium">数据源目录</span>
              </div>
              <span className="text-[14px] leading-[20px] font-mono text-foreground mt-1 truncate" title={meta?.source || "db/sites/madfu.db"}>
                {meta?.source || "./data"}
              </span>
            </div>

            {/* 采集间隔 */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="size-3.5" />
                <span className="text-[12px] leading-[16px] font-medium">采集对账间隔</span>
              </div>
              <span className="text-[14px] leading-[20px] font-mono tabular-nums text-foreground mt-1">
                15 分钟 (900s)
              </span>
            </div>

            {/* 当前主题 */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Palette className="size-3.5" />
                <span className="text-[12px] leading-[16px] font-medium">当前主题</span>
              </div>
              <span className="text-[14px] leading-[20px] font-medium text-foreground mt-1 truncate">
                {themeDisplay}
              </span>
            </div>

            {/* 汇率与记录数 */}
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Coins className="size-3.5" />
                <span className="text-[12px] leading-[16px] font-medium">基准汇率</span>
              </div>
              <span className="text-[14px] leading-[20px] font-mono tabular-nums text-foreground mt-1 truncate">
                1 {meta?.currency || "USD"} = {formatNumber(meta?.quota_per_unit || 500000)} Q
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. 各接口健康状况卡片 */}
      <Card className="shadow-xs overflow-hidden flex flex-col p-4 flex-1 min-h-0">
        <CardHeader className="p-0 pb-2.5 flex flex-row items-center justify-between space-y-0 shrink-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              接口服务健康状况
            </CardTitle>
            {healthOk === true ? (
              <Badge
                variant="outline"
                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10 flex items-center gap-1"
              >
                <CheckCircle2 className="size-3" />
                服务正常
              </Badge>
            ) : healthOk === false ? (
              <Badge
                variant="destructive"
                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium flex items-center gap-1"
              >
                <AlertCircle className="size-3" />
                探测异常
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium">
                检测中...
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="text-[12px] leading-[16px] text-muted-foreground font-mono tabular-nums hidden sm:inline">
              最近刷新: {formatBeijingTime(lastRefreshTime || lastCheckMs)}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="text-[12px] leading-[16px] h-7 px-2.5 gap-1.5 cursor-pointer"
              onClick={checkHealth}
              disabled={checking}
            >
              <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
              <span>探测</span>
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
          <div className="rounded-lg border border-border bg-card flex-1 min-h-0 overflow-auto">
            <Table className="min-w-[680px] lg:min-w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: "22%" }} />
                <col style={{ width: "22%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "26%" }} />
                <col style={{ width: "14%" }} />
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border">
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    接口路由
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    服务名称
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    刷新策略
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    功能定义与职责
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                    服务状态
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {API_ENDPOINTS.map((ep) => (
                  <TableRow
                    key={ep.path}
                    className="h-[38px] hover:bg-muted/40 transition-colors border-b border-border/60"
                  >
                    <TableCell className="px-3 py-1 font-mono text-[12px] leading-[16px] text-foreground font-medium truncate">
                      {ep.path}
                    </TableCell>
                    <TableCell className="px-3 py-1 text-[12px] leading-[16px] text-foreground font-normal truncate">
                      {ep.name}
                    </TableCell>
                    <TableCell className="px-3 py-1 font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap">
                      {ep.interval}
                    </TableCell>
                    <TableCell className="px-3 py-1 text-[12px] leading-[16px] text-muted-foreground truncate" title={ep.description}>
                      {ep.description}
                    </TableCell>
                    <TableCell className="px-3 py-1 text-right whitespace-nowrap">
                      {healthOk === true ? (
                        <Badge
                          variant="outline"
                          className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                        >
                          已就绪
                        </Badge>
                      ) : healthOk === false ? (
                        <Badge
                          variant="outline"
                          className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-amber-600 dark:text-amber-400 border-amber-500/30"
                        >
                          待连通
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-muted-foreground"
                        >
                          检测中
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
