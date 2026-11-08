import { useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import type { DeckGLRef } from '@deck.gl/react'
import { OrbitView, OrthographicView } from '@deck.gl/core'
import type { Layer, PickingInfo, Viewport } from '@deck.gl/core'
import { PointCloudLayer, ScatterplotLayer } from '@deck.gl/layers'
import { Box, Center, Text } from '@mantine/core'
import { drawable } from './frame'
import { fitView } from './camera'
import { ProjectionTooltip, type TooltipAction } from './ProjectionTooltip'

export interface ProjectionCanvasProps {
  coords: Float32Array
  dims: 2 | 3
  n: number
  /** n×3 bytes. */
  colors: Uint8Array
  highlight?: Set<number>
  /** One position (dims numbers) drawn as a query marker. */
  marker?: number[]
  /** A new key refits the camera; frames of the same key keep it. */
  fitKey: string
  onPointClick(index: number): void
  onHover?(index: number | undefined): void
  onViewportChange?(viewport: Viewport): void
  tooltipActions?: TooltipAction[]
  /** The tooltip text for a point (label or uuid, colour value). */
  tooltipLines?(index: number): string[]
}

type ViewState = Record<string, unknown>
type Rgb = [number, number, number]
interface Binary {
  length: number
  attributes: Record<string, { value: Float32Array | Uint8Array; size: number }>
}

const POINT_PX = 3
const HIGHLIGHT: Rgb = [255, 255, 255]
const MARKER: Rgb = [255, 64, 129]

function viewStateOf(dims: 2 | 3, target: number[], zoom: number): ViewState {
  return dims === 2 ? { target, zoom } : { target, zoom, rotationX: 30, rotationOrbit: 30 }
}

/** Typed arrays end to end: no per-point JS objects. */
function pointLayer(id: string, dims: 2 | 3, data: Binary, px: number, pickable: boolean): Layer {
  return dims === 2
    ? new ScatterplotLayer({ id, data, pickable, radiusUnits: 'pixels', getRadius: px })
    : new PointCloudLayer({ id, data, pickable, pointSize: px, material: false })
}

function binary(dims: 2 | 3, positions: Float32Array, colors: Uint8Array, length: number): Binary {
  const colorName = dims === 2 ? 'getFillColor' : 'getColor'
  return {
    length,
    attributes: { getPosition: { value: positions, size: dims }, [colorName]: { value: colors, size: 3 } }
  }
}

function overlay(id: string, dims: 2 | 3, positions: number[], rgb: Rgb, px: number): Layer[] {
  const count = positions.length / dims
  if (count === 0) return []
  const colors = new Uint8Array(count * 3)
  for (let i = 0; i < count; i++) colors.set(rgb, i * 3)
  return [pointLayer(id, dims, binary(dims, new Float32Array(positions), colors, count), px, false)]
}

function buildLayers(
  { coords, dims, n, colors }: Pick<ProjectionCanvasProps, 'coords' | 'dims' | 'n' | 'colors'>,
  highlight: Set<number> | undefined,
  marker: number[] | undefined
): Layer[] {
  const picked = [...(highlight ?? [])].filter((i) => i >= 0 && i < n)
  const picks = picked.flatMap((i) => Array.from(coords.subarray(i * dims, i * dims + dims)))
  return [
    pointLayer(`points-${dims}d`, dims, binary(dims, coords, colors, n), POINT_PX, true),
    ...overlay(`highlight-${dims}d`, dims, picks, HIGHLIGHT, POINT_PX * 2.5),
    ...overlay(`marker-${dims}d`, dims, marker ?? [], MARKER, POINT_PX * 3)
  ]
}

export function ProjectionCanvas(props: ProjectionCanvasProps) {
  const { coords, dims, n, colors, highlight, marker, fitKey } = props
  const { onPointClick, onHover, onViewportChange, tooltipActions, tooltipLines } = props
  const box = useRef<HTMLDivElement>(null)
  const deck = useRef<DeckGLRef>(null)
  const lastViewport = useRef<Viewport>()
  const [hover, setHover] = useState<{ index: number; x: number; y: number }>()
  const [camera, setCamera] = useState<{ key?: string; view: ViewState }>({ view: {} })
  const count = useMemo(() => drawable(coords.subarray(0, n * dims), dims), [coords, n, dims])
  const view = useMemo(
    () =>
      dims === 2
        ? new OrthographicView({ id: 'ortho', controller: true })
        : new OrbitView({ id: 'orbit', controller: true }),
    [dims]
  )
  const layers = useMemo(
    () => buildLayers({ coords, dims, n, colors }, highlight, marker),
    [coords, dims, n, colors, highlight, marker]
  )

  // Refit once per run (and per dims) when the first drawable data arrives; later frames of the
  // same run keep the user's camera. Derived during render, so no effect is needed.
  const key = count > 0 ? `${fitKey}:${dims}` : undefined
  if (key !== undefined && key !== camera.key) {
    const fit = fitView(coords, n, dims, box.current?.clientWidth || 800, box.current?.clientHeight || 600)
    setCamera({ key, view: viewStateOf(dims, fit.target, fit.zoom) })
  }

  if (count === 0) {
    return (
      <Center h="100%">
        <Text c="dimmed">Nothing to draw: no point has finite coordinates.</Text>
      </Center>
    )
  }

  const handleHover = (info: PickingInfo): void => {
    const index = info.index >= 0 ? info.index : undefined
    onHover?.(index)
    if (index !== undefined) setHover({ index, x: info.x, y: info.y })
    // Actions must stay clickable, so with actions the tooltip only clears when the pointer leaves.
    else if (!tooltipActions?.length) setHover(undefined)
  }

  const handleAfterRender = (): void => {
    const vp = deck.current?.deck?.getViewports()[0]
    if (!vp || vp === lastViewport.current) return
    lastViewport.current = vp
    onViewportChange?.(vp)
  }

  return (
    <Box ref={box} pos="relative" h="100%" onMouseLeave={() => setHover(undefined)}>
      <DeckGL
        ref={deck}
        views={view}
        viewState={camera.view}
        controller
        layers={layers}
        onViewStateChange={({ viewState }) => setCamera((c) => ({ ...c, view: viewState }))}
        onHover={handleHover}
        onClick={(info) => info.index >= 0 && onPointClick(info.index)}
        onAfterRender={handleAfterRender}
        getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
      />
      {hover && (
        <ProjectionTooltip
          x={hover.x}
          y={hover.y}
          lines={tooltipLines?.(hover.index) ?? [`#${hover.index}`]}
          actions={tooltipActions}
          index={hover.index}
        />
      )}
    </Box>
  )
}
