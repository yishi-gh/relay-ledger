import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Server,
  Info,
  HardDrive,
  Clock,
  Palette,
  Globe,
  Coins,
} from "lucide-react"
import { formatNumber } from "@/lib/formatters"
import { useTheme } from "@/components/theme-provider"
import type { Meta } from "@/lib/api"

interface SettingsViewProps {
  meta: Meta | null
  lastRefreshTime?: number
}

export function SettingsView({ meta }: SettingsViewProps) {
  const { theme } = useTheme()

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

      {/* 2. 实例基本信息卡片（只读） */}
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
    </div>
  )
}
