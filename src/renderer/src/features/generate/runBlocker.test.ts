import { describe, expect, it } from 'vitest'
import { runBlocker, type RunState } from './runBlocker'

const ready: RunState = { hasProvider: true, hasPrompt: true, hasQueryTerm: true, groupByConflict: false }

describe('runBlocker', () => {
  it('lets a complete request run', () => {
    expect(runBlocker(ready)).toBeUndefined()
  })

  it.each([
    [{ hasProvider: false }, 'Pick a generative provider'],
    [{ hasQueryTerm: false }, 'Enter what to retrieve (search query, vector, object or media)'],
    [{ hasPrompt: false }, 'Write a per-object prompt or a grouped task'],
    [{ groupByConflict: true }, 'Group by only works with a grouped task: clear the per-object prompt']
  ])('names what is missing (%o)', (patch, reason) => {
    expect(runBlocker({ ...ready, ...patch })).toBe(reason)
  })

  it('reports the provider first when several things are missing', () => {
    expect(runBlocker({ hasProvider: false, hasPrompt: false, hasQueryTerm: false, groupByConflict: false })).toBe(
      'Pick a generative provider'
    )
  })
})
