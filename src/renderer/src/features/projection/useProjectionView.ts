import { useMemo } from 'react'
import { LABEL_MAX_CHARS } from '@shared/projection'
import type { CollectionConfig, ProjectionMethod, ProjectionStatusKnown } from '@shared/types'
import { colorScale, toColorAttribute, type ColorScale } from './colors'
import { defaultRoles, resolveRole, roleColumn, scalarType } from './defaults'
import { chooseFrame, decodeCoords, type Frame } from './frame'

type Points = NonNullable<ProjectionStatusKnown['points']>

export interface ProjectionViewInput {
  known: ProjectionStatusKnown | undefined
  points: Points | undefined
  config: CollectionConfig | undefined
  view: ProjectionMethod
  dims: 2 | 3
  /** `null` = explicitly cleared, `undefined` = never chosen (the default applies). */
  labelProp?: string | null
  colourProp?: string | null
  deleted: ReadonlySet<string>
}

/** React glue: decodes the frame once per payload and derives colours and tooltip text. */
export function useProjectionView(input: ProjectionViewInput) {
  const { known, points, config, view, dims, deleted } = input
  const pcaB64 = known?.pca
  const umapB64 = known?.umap?.coords
  const umapDims = known?.umap?.dims
  const pca = useMemo(() => (pcaB64 ? decodeCoords(pcaB64) : undefined), [pcaB64])
  const umap = useMemo(
    () => (umapB64 && umapDims ? { coords: decodeCoords(umapB64), dims: umapDims } : undefined),
    [umapB64, umapDims]
  )
  const frame: Frame | undefined = useMemo(() => chooseFrame({ pca, umap }, view, dims), [pca, umap, view, dims])

  const props = known?.scope.props ?? []
  const defaults = defaultRoles(config?.properties ?? [])
  const labelProp = resolveRole(input.labelProp, defaults.labelProp, props)
  const colourProp = resolveRole(input.colourProp, defaults.colourProp, props)
  const labelCol = points ? roleColumn(points, labelProp) : undefined
  const colourCol = points ? roleColumn(points, colourProp) : undefined
  const colourType = scalarType(config?.properties.find((p) => p.name === colourProp) ?? { name: '', dataType: [] })

  const scale: ColorScale = useMemo(() => colorScale(colourType, colourCol ?? []), [colourType, colourCol])
  const n = frame?.n ?? 0
  const colors = useMemo(() => toColorAttribute(scale, n), [scale, n])

  const tooltipLines = (i: number): string[] => {
    const uuid = points?.uuids[i]
    const label = labelCol?.[i]
    const lines = [label === null || label === undefined ? (uuid ?? `#${i}`) : String(label).slice(0, LABEL_MAX_CHARS)]
    if (colourProp !== undefined) lines.push(`${colourProp}: ${String(colourCol?.[i] ?? 'missing').slice(0, LABEL_MAX_CHARS)}`)
    if (uuid !== undefined && deleted.has(uuid)) lines.push('deleted since this run')
    return lines
  }
  return { frame, colors, scale, labelProp, colourProp, tooltipLines, roleOptions: props }
}
