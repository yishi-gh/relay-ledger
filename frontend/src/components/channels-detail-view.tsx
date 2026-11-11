import { DetailsView } from "@/components/details-view"
import type { ChannelRowData } from "@/components/channels-rank-view"
import type { RangeType } from "@/lib/api"

export type { ChannelRowData }

interface ChannelsDetailViewProps {
  timeRange: RangeType
  rows: ChannelRowData[]
}

export function ChannelsDetailView({ timeRange, rows }: ChannelsDetailViewProps) {
  return <DetailsView timeRange={timeRange} channels={rows} groups={[]} initialLevel="channel" />
}
