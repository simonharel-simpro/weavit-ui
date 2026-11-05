import { describe, expect, it } from 'vitest'
import { decodeArgs, encodeArgs } from './webProtocol'

describe('web protocol args', () => {
  it('drops trailing undefined so optional parameters stay undefined', () => {
    expect(encodeArgs(['id', undefined, undefined])).toEqual(['id'])
  })

  it('keeps a middle undefined distinct from null across JSON', () => {
    const wire = JSON.parse(JSON.stringify(encodeArgs(['a', undefined, null, 'b'])))
    expect(decodeArgs(wire)).toEqual(['a', undefined, null, 'b'])
    expect(decodeArgs(wire)[1]).toBeUndefined()
    expect(decodeArgs(wire)[2]).toBeNull()
  })

  it('leaves look-alike objects untouched', () => {
    const lookAlike = { __weavitUndefined: true, extra: 1 }
    expect(decodeArgs([lookAlike, { __weavitUndefined: 'yes' }])).toEqual([
      lookAlike,
      { __weavitUndefined: 'yes' }
    ])
  })
})
