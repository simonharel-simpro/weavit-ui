import { useReducer, type KeyboardEvent, type PointerEvent } from 'react'
import type { Viewport } from '@deck.gl/core'
import { pointsInPolygon, toScreenXY } from './lasso'
import { IDLE, reduceLasso, type Xy } from './lassoState'

/** Pointer glue for the lasso: screen coordinates of the view are computed once, on release. */
export function useLasso(coords: Float32Array, n: number, getViewport: () => Viewport | undefined) {
  const [state, dispatch] = useReducer(reduceLasso, IDLE)
  const at = (e: PointerEvent<SVGSVGElement>): Xy => {
    const box = e.currentTarget.getBoundingClientRect()
    return [e.clientX - box.left, e.clientY - box.top]
  }
  const pick = (path: Xy[]): number[] => {
    const viewport = getViewport()
    if (!viewport) return []
    const xy = toScreenXY(coords, n, (p) => viewport.project(p))
    return pointsInPolygon(xy, n, path)
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
      onPointerUp: () => dispatch({ type: 'up', pick }),
      onKeyDown: (e: KeyboardEvent<SVGSVGElement>) => e.key === 'Escape' && dispatch({ type: 'arm', on: false })
    }
  }
}
