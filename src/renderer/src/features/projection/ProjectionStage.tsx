import { useMemo, type ReactNode } from 'react'
import type { Viewport } from '@deck.gl/core'
import { Box, Center, Loader, Text } from '@mantine/core'
import type { Frame } from './frame'
import type { LegendEntry } from './colors'
import { ProjectionCanvas } from './ProjectionCanvas'
import { mergeHighlight } from './overlay'
import { ProjectionLegend } from './ProjectionLegend'
import type { TooltipAction } from './ProjectionTooltip'

export interface ProjectionStageProps {
  frame?: Pick<Frame, 'coords' | 'dims' | 'n'>
  colors: Uint8Array
  legend: LegendEntry[]
  legendTitle: string
  selectedIndex?: number
  /** The overlay's hits (local indices) and query marker. */
  highlight?: Set<number>
  marker?: number[]
  fitKey: string
  isRunning: boolean
  onPointClick(index: number): void
  onViewportChange?(viewport: Viewport): void
  tooltipActions?: TooltipAction[]
  tooltipLines?(index: number): string[]
  /** Drawn over the canvas: the lasso and the query overlay. */
  children?: ReactNode
}

/** The drawing surface: the cloud with its legend, or a placeholder while there is nothing to draw. */
export function ProjectionStage(props: ProjectionStageProps) {
  const { frame, colors, legend, legendTitle, selectedIndex, fitKey, isRunning } = props
  const highlight = useMemo(() => mergeHighlight(props.highlight, selectedIndex), [props.highlight, selectedIndex])
  return (
    <Box pos="relative" flex={1} mih={0} bg="dark.8" style={{ borderRadius: 4, overflow: 'hidden' }}>
      {frame ? (
        <>
          <ProjectionCanvas
            coords={frame.coords}
            dims={frame.dims}
            n={frame.n}
            colors={colors}
            highlight={highlight}
            marker={props.marker}
            fitKey={fitKey}
            onPointClick={props.onPointClick}
            onViewportChange={props.onViewportChange}
            tooltipActions={props.tooltipActions}
            tooltipLines={props.tooltipLines}
          />
          <ProjectionLegend legend={legend} title={legendTitle} />
          {props.children}
        </>
      ) : (
        <Center h="100%">
          {isRunning ? <Loader size="sm" /> : <Text c="dimmed" size="sm">Pick a vector space and press Run.</Text>}
        </Center>
      )}
    </Box>
  )
}
