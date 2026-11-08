import { QueryOverlay } from './QueryOverlay'
import { SelectionLayer, type SelectionLayerProps } from './SelectionLayer'
import type { useOverlay } from './useOverlay'

export interface ProjectionOverlaysProps extends SelectionLayerProps {
  overlay: ReturnType<typeof useOverlay>
  vectorDim: number
}

/** What sits over the canvas: the lasso (2D) and the query overlay. */
export function ProjectionOverlays({ overlay, vectorDim, ...selection }: ProjectionOverlaysProps) {
  return (
    <>
      <SelectionLayer {...selection} />
      <QueryOverlay o={overlay} dim={vectorDim} />
    </>
  )
}
