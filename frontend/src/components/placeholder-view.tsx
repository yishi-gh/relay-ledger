import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  BarChart3,
  Radio,
  PieChart,
  Layers,
  Server,
  ShieldCheck,
  Settings,
  type LucideIcon,
} from "lucide-react"

export type PlaceholderKey =
  | "channels_rank"
  | "channels_detail"
  | "groups_rank"
  | "groups_detail"
  | "upstreams"
  | "quality"
  | "settings"

interface PlaceholderMeta {
  title: string
  icon: LucideIcon
  future: string
}

const PLACEHOLDER_CONFIGS: Record<PlaceholderKey, PlaceholderMeta> = {
  channels_rank: {
    title: "渠道排行",
    icon: BarChart3,
    future: "按调用频次与售出金额呈现 TOP 10 核心下游渠道分布及「其它」聚合，一屏清晰直观。",
  },
  channels_detail: {
    title: "渠道明细",
    icon: Radio,
    future: "多列全量渠道调用明细表，支持表内滚动、实时流控与 API Key 费率对账审计。",
  },
  groups_rank: {
    title: "分组排行",
    icon: PieChart,
    future: "按业务分组与客户层级对比核心用量、额度占比与消耗趋势分布。",
  },
  groups_detail: {
    title: "分组明细",
    icon: Layers,
    future: "业务分组多维度对账明细表，支持卡内滚动检索与额度超限异常告警。",
  },
  upstreams: {
    title: "上游账户",
    icon: Server,
    future: "未来将提供上游供应商各独立账户的实时余额流水、并发状态、充值明细与健康度追踪。",
  },
  quality: {
    title: "数据质量",
    icon: ShieldCheck,
    future: "未来将监控快照采集延迟、漏桶检测、对账差异异常告警与自动修复建议。",
  },
  settings: {
    title: "系统设置",
    icon: Settings,
    future: "未来将支持汇率基准、对账告警阈值、外部数据源同步周期及展示偏好的自定义配置。",
  },
}

export function PlaceholderView({ viewKey }: { viewKey: PlaceholderKey }) {
  const meta = PLACEHOLDER_CONFIGS[viewKey] || {
    title: "未定义视图",
    icon: Settings,
    future: "该模块正在规划中。",
  }

  const Icon = meta.icon

  return (
    <div className="flex flex-1 items-center justify-center p-4 md:p-8 min-h-[420px]">
      <Card className="w-full max-w-lg border-border/80 shadow-xs bg-card">
        <CardContent className="flex flex-col items-center text-center p-8 space-y-4">
          <div className="size-12 rounded-xl bg-muted/80 text-muted-foreground flex items-center justify-center ring-1 ring-border">
            <Icon className="size-6 text-foreground/80" />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                {meta.title}
              </h2>
              <Badge variant="secondary" className="text-[12px] h-5 px-2 font-normal">
                此页尚未接入
              </Badge>
            </div>
            <p className="text-[12px] leading-[16px] text-muted-foreground max-w-sm pt-1">
              {meta.future}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
