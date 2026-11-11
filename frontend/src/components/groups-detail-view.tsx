import { DetailsView } from "@/components/details-view"
import type { GroupRowData } from "@/components/groups-rank-view"
import type { RangeType } from "@/lib/api"

export type { GroupRowData }

interface GroupsDetailViewProps {
  timeRange: RangeType
  groups: GroupRowData[]
}

export function GroupsDetailView({ timeRange, groups }: GroupsDetailViewProps) {
  return <DetailsView timeRange={timeRange} channels={[]} groups={groups} initialLevel="group" />
}
