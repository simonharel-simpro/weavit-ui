import { useReducer, type KeyboardEvent, type PointerEvent } from 'react'
import type { Viewport } from '@deck.gl/core'
import { pointsInPolygon } from './lasso'

type Xy = [number, number]
interface LassoState {
  armed: boolean
  drawing: boolean
  path: Xy[]
  /** View-relative indices of the finished lasso. */
  picked?: number[]
}
type Action =
  | { type: 'arm'; on: boolean }
  | { type: 'down'; at: Xy }
  | { type: 'move'; at: Xy }
  | { type: 'up'; picked: number[] }
  | { type: 'clear' }

const MIN_STEP_PX = 3
const IDLE: LassoState = { armed: false, drawing: false, path: [] }

function reduce(s: LassoState, a: Action): LassoState {
  switch (a.type) {
    case 'arm':
      return a.on ? { ...IDLE, armed: true } : IDLE
    case 'down':
      return { armed: true, drawing: true, path: [a.at] }
    case 'move': {
      const last = s.path[s.path.length - 1]
      if (!s.drawing || (last && Math.hypot(a.at[0] - last[0], a.at[1] - last[1]) < MIN_STEP_PX)) return s
      return { ...s, path: [...s.path, a.at] }
    }
    case 'up':
      return { ...s, drawing: false, picked: a.picked }
    case 'clear':
      return { ...IDLE, armed: s.armed }
  }
}

/** Pointer glue for the lasso: screen coordinates of the view are computed once, on release. */
export function useLasso(coords: Float32Array, n: number, getViewport: () => Viewport | undefined) {
  const [state, dispatch] = useReducer(reduce, IDLE)
  const at = (e: PointerEvent<SVGSVGElement>): Xy => {
    const box = e.currentTarget.getBoundingClientRect()
    return [e.clientX - box.left, e.clientY - box.top]
  }
  const pick = (): number[] => {
    const viewport = getViewport()
    if (!viewport) return []
    const xy = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      const p = viewport.project([coords[i * 2] as number, coords[i * 2 + 1] as number, 0])
      xy[i * 2] = p[0] as number
      xy[i * 2 + 1] = p[1] as number
    }
    return pointsInPolygon(xy, n, state.path)
  }
  return {
    state,
    arm: (on: boolean) => dispatch({ type: 'arm', on }),
    clear: () => dispatch({ type: 'clear' }),
    handlers: {
      onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.focus()
        dispatch({ type: 'down', at: at(e) })
      },
      onPointerMove: (e: PointerEvent<SVGSVGElement>) => dispatch({ type: 'move', at: at(e) }),
      onPointerUp: () => state.drawing && dispatch({ type: 'up', picked: pick() }),
      onKeyDown: (e: KeyboardEvent<SVGSVGElement>) => e.key === 'Escape' && dispatch({ type: 'arm', on: false })
    }
  }
}
