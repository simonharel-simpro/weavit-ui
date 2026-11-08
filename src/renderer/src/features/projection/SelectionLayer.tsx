import type { Viewport } from '@deck.gl/core'
import { Button, Group, Paper, Text, Tooltip } from '@mantine/core'
import { MIN_SELECTION } from '@shared/projection'
import { IconLasso, IconX } from '@tabler/icons-react'
import { toRootIndices } from './lasso'
import { useLasso } from './useLasso'

export interface SelectionLayerProps {
  dims: 2 | 3
  coords: Float32Array
  n: number
  /** The canvas's latest viewport, read on release only. */
  getViewport(): Viewport | undefined
  /** Root indices of the level on screen; absent at the root. */
  levelIndices?: number[]
  can: { canSelect: boolean; hint?: string }
  onSelect(rootIndices: number[]): void
}

/** Lasso on top of the 2D canvas. The SVG only captures the pointer while the lasso is armed. */
export function SelectionLayer({ dims, coords, n, getViewport, levelIndices, can, onSelect }: SelectionLayerProps) {
  const { state, arm, clear, handlers } = useLasso(coords, n, getViewport)
  if (dims === 3) {
    return <Text size="xs" c="dimmed" style={{ position: 'absolute', left: 8, bottom: 8 }}>switch to 2D to select</Text>
  }
  const count = state.picked?.length ?? 0
  const tooFew = state.picked !== undefined && count < MIN_SELECTION
  const blocked = !can.canSelect || tooFew
  const why = !can.canSelect ? can.hint : tooFew ? `needs at least ${MIN_SELECTION} points` : undefined
  const handleSelect = (): void => {
    if (!state.picked) return
    onSelect(toRootIndices(state.picked, levelIndices))
    arm(false)
  }
  return (
    <>
      {state.armed && (
        <svg
          tabIndex={0}
          {...handlers}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'crosshair', zIndex: 3, outline: 'none' }}
        >
          <polygon
            points={state.path.map((p) => p.join(',')).join(' ')}
            fill="rgba(77,171,247,0.15)"
            stroke="#4dabf7"
            strokeWidth={1.5}
          />
        </svg>
      )}
      <Paper withBorder p={4} style={{ position: 'absolute', left: 8, bottom: 8, zIndex: 5 }}>
        <Group gap="xs" wrap="nowrap">
          <Button size="compact-xs" variant={state.armed ? 'filled' : 'light'} leftSection={<IconLasso size={14} />}
            onClick={() => arm(!state.armed)}>
            Lasso
          </Button>
          {state.picked !== undefined && (
            <>
              <Tooltip label={why} disabled={!blocked} multiline maw={240}>
                <Button size="compact-xs" disabled={blocked} onClick={handleSelect}>
                  UMAP on selection ({count.toLocaleString(navigator.language)} points)
                </Button>
              </Tooltip>
              <Button size="compact-xs" variant="subtle" aria-label="Clear selection" onClick={clear}><IconX size={14} /></Button>
            </>
          )}
        </Group>
        {!can.canSelect && can.hint && <Text size="xs" c="dimmed">{can.hint}</Text>}
      </Paper>
    </>
  )
}
