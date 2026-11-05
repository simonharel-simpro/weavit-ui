import { afterEach, describe, expect, it } from 'vitest'
import { mergedHeaders, setExtraHeaders } from './extraHeaders'

afterEach(() => setExtraHeaders({}))

describe('mergedHeaders', () => {
  it('returns undefined when there is nothing to send', () => {
    expect(mergedHeaders(undefined)).toBeUndefined()
    expect(mergedHeaders({})).toBeUndefined()
  })

  it('adds host headers to a profile without any', () => {
    setExtraHeaders({ 'X-OpenAI-Api-Key': 'from-env' })
    expect(mergedHeaders(undefined)).toEqual({ 'X-OpenAI-Api-Key': 'from-env' })
  })

  it("lets the profile's own header win", () => {
    setExtraHeaders({ 'X-OpenAI-Api-Key': 'from-env', 'X-Other': 'a' })
    expect(mergedHeaders({ 'X-OpenAI-Api-Key': 'mine' })).toEqual({ 'X-OpenAI-Api-Key': 'mine', 'X-Other': 'a' })
  })
})
