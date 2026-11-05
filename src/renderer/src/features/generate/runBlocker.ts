// Why the Generate button is disabled, in words: a greyed-out button with no
// reason reads as "broken". Pure, so the node tests can load it.

export interface RunState {
  hasProvider: boolean
  hasPrompt: boolean
  hasQueryTerm: boolean
  groupByConflict: boolean
}

/** The first thing missing before a run can start, or undefined when it can. */
export function runBlocker(s: RunState): string | undefined {
  if (!s.hasProvider) return 'Pick a generative provider'
  if (!s.hasQueryTerm) return 'Enter what to retrieve (search query, vector, object or media)'
  if (!s.hasPrompt) return 'Write a per-object prompt or a grouped task'
  if (s.groupByConflict) return 'Group by only works with a grouped task: clear the per-object prompt'
  return undefined
}
