export type Xy = [number, number]

export interface LassoState {
  armed: boolean
  drawing: boolean
  path: Xy[]
  /** View-relative indices of the finished lasso. */
  picked?: number[]
}

export type LassoAction =
  | { type: 'arm'; on: boolean }
  | { type: 'down'; at: Xy }
  | { type: 'move'; at: Xy }
  /** `pick` runs inside the reducer so it sees every queued move, not the path of the last render. */
  | { type: 'up'; pick(path: Xy[]): number[] }
  | { type: 'clear' }

const MIN_STEP_PX = 3
export const IDLE: LassoState = { armed: false, drawing: false, path: [] }

export function reduceLasso(s: LassoState, a: LassoAction): LassoState {
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
      return s.drawing ? { ...s, drawing: false, picked: a.pick(s.path) } : s
    case 'clear':
      return { ...IDLE, armed: s.armed }
  }
}
