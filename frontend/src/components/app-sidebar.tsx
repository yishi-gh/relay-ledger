import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar"
import { SiteLogo } from "@/components/site-logo"
import {
  LayoutDashboard,
  TrendingUp,
  BarChart3,
  Cpu,
  Radio,
  Layers,
  Server,
  ShieldCheck,
  Activity,
  Route,
  Settings,
  type LucideIcon,
} from "lucide-react"

export type ViewKey =
  | "overview"
  | "profit"
  | "rank"
  | "models"
  | "channels_detail"
  | "groups_detail"
  | "routes"
  | "upstreams"
  | "quality"
  | "system"
  | "settings"

export type CompatibleViewKey = ViewKey | "capital" | "health" | "details" | "ops"

interface NavItem {
  key: ViewKey
  title: string
  icon: LucideIcon
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "经营分析",
    items: [
      { key: "overview", title: "总览", icon: LayoutDashboard },
      { key: "profit", title: "盈利", icon: TrendingUp },
      { key: "rank", title: "排行", icon: BarChart3 },
      { key: "models", title: "模型", icon: Cpu },
    ],
  },
  {
    label: "运营资产",
    items: [
      { key: "channels_detail", title: "渠道", icon: Radio },
      { key: "groups_detail", title: "分组", icon: Layers },
      { key: "routes", title: "路由", icon: Route },
      { key: "upstreams", title: "上游", icon: Server },
    ],
  },
  {
    label: "系统运维",
    items: [
      { key: "quality", title: "质量", icon: ShieldCheck },
      { key: "system", title: "系统", icon: Activity },
    ],
  },
]

const SETTINGS_ITEM: NavItem = {
  key: "settings",
  title: "设置",
  icon: Settings,
}

interface AppSidebarProps {
  siteName?: string
  currentView: ViewKey
  onSelectView: (view: ViewKey) => void
}

export function AppSidebar({
  siteName = "Madfu",
  currentView,
  onSelectView,
}: AppSidebarProps) {
  const { isMobile, setOpenMobile } = useSidebar()

  const handleSelect = (key: ViewKey) => {
    onSelectView(key)
    if (isMobile) {
      setOpenMobile(false)
    }
  }

  return (
    <Sidebar collapsible="icon">
      {/* 侧栏顶标：站点名与简短定位 */}
      <SidebarHeader className="border-b border-sidebar-border px-3 py-3">
        <div className="flex items-center gap-2.5 overflow-hidden">
          <SiteLogo kind="site" id="current" label={siteName} size={32} className="rounded-lg shadow-xs" />
          <div className="flex flex-col min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="text-[14px] leading-[20px] font-medium tracking-tight text-sidebar-foreground truncate capitalize">
              {siteName}
            </span>
            <span className="text-[12px] leading-[16px] text-muted-foreground font-mono">
              Relay Ledger
            </span>
          </div>
        </div>
      </SidebarHeader>

      {/* 侧栏导航分组：经营分析 / 运营资产 / 系统运维 */}
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="py-2">
            <SidebarGroupLabel className="text-[12px] leading-[16px] font-medium text-muted-foreground px-3">
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon
                  const isActive =
                    currentView === item.key ||
                    (item.key === "channels_detail" && (currentView as string) === "details") ||
                    (item.key === "system" && (currentView as string) === "ops")
                  return (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        isActive={isActive}
                        tooltip={item.title}
                        onClick={() => handleSelect(item.key)}
                        className={`cursor-pointer transition-colors min-h-[44px] h-11 ${
                          isActive
                            ? "font-medium text-sidebar-accent-foreground bg-sidebar-accent"
                            : "text-sidebar-foreground/80 hover:text-sidebar-foreground"
                        }`}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="text-[14px] leading-[20px] font-medium">{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      {/* 侧栏置底：设置 */}
      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={currentView === SETTINGS_ITEM.key}
              tooltip={SETTINGS_ITEM.title}
              onClick={() => handleSelect(SETTINGS_ITEM.key)}
              className={`cursor-pointer transition-colors min-h-[44px] h-11 ${
                currentView === SETTINGS_ITEM.key
                  ? "font-medium text-sidebar-accent-foreground bg-sidebar-accent"
                  : "text-sidebar-foreground/80 hover:text-sidebar-foreground"
              }`}
            >
              <SETTINGS_ITEM.icon className="size-4 shrink-0" />
              <span className="text-[14px] leading-[20px] font-medium">{SETTINGS_ITEM.title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
