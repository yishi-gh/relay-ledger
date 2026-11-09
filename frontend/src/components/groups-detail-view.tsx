import { DetailsView } from "@/components/details-view"
import type { GroupRowData } from "@/components/groups-rank-view"

export type { GroupRowData }

interface GroupsDetailViewProps {
  timeRange: "24h" | "7d"
  groups: GroupRowData[]
}

export function GroupsDetailView({ timeRange, groups }: GroupsDetailViewProps) {
  return <DetailsView timeRange={timeRange} channels={[]} groups={groups} initialLevel="group" />
}
