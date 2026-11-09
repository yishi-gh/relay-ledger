import { DetailsView } from "@/components/details-view"
import type { ChannelRowData } from "@/components/channels-rank-view"

export type { ChannelRowData }

interface ChannelsDetailViewProps {
  timeRange: "24h" | "7d"
  rows: ChannelRowData[]
}

export function ChannelsDetailView({ timeRange, rows }: ChannelsDetailViewProps) {
  return <DetailsView timeRange={timeRange} channels={rows} groups={[]} initialLevel="channel" />
}
