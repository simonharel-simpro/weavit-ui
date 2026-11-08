import { Box, Center, Loader, Text } from '@mantine/core'
import type { Frame } from './frame'
import type { LegendEntry } from './colors'
import { ProjectionCanvas } from './ProjectionCanvas'
import { ProjectionLegend } from './ProjectionLegend'

export interface ProjectionStageProps {
  frame?: Pick<Frame, 'coords' | 'dims' | 'n'>
  colors: Uint8Array
  legend: LegendEntry[]
  legendTitle: string
  selectedIndex?: number
  fitKey: string
  isRunning: boolean
  onPointClick(index: number): void
  tooltipLines?(index: number): string[]
}

/** The drawing surface: the cloud with its legend, or a placeholder while there is nothing to draw. */
export function ProjectionStage(props: ProjectionStageProps) {
  const { frame, colors, legend, legendTitle, selectedIndex, fitKey, isRunning } = props
  return (
    <Box pos="relative" flex={1} mih={0} bg="dark.8" style={{ borderRadius: 4, overflow: 'hidden' }}>
      {frame ? (
        <>
          <ProjectionCanvas
            coords={frame.coords}
            dims={frame.dims}
            n={frame.n}
            colors={colors}
            highlight={selectedIndex !== undefined && selectedIndex >= 0 ? new Set([selectedIndex]) : undefined}
            fitKey={fitKey}
            onPointClick={props.onPointClick}
            tooltipLines={props.tooltipLines}
          />
          <ProjectionLegend legend={legend} title={legendTitle} />
        </>
      ) : (
        <Center h="100%">
          {isRunning ? <Loader size="sm" /> : <Text c="dimmed" size="sm">Pick a vector space and press Run.</Text>}
        </Center>
      )}
    </Box>
  )
}
