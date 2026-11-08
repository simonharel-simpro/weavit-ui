import { describe, expect, it } from 'vitest'
import { decodeF32 } from './projection'

function b64Of(values: number[]): string {
  const bytes = new Uint8Array(new Float32Array(values).buffer)
  return Buffer.from(bytes).toString('base64')
}

describe('decodeF32', () => {
  it('decodeF32: round-trips little-endian bytes', () => {
    expect(Array.from(decodeF32(b64Of([1.5, -2, 3])))).toEqual([1.5, -2, 3])
  })

  it('decodes the explicit little-endian byte order', () => {
    // 1.0f = 0x3F800000, little-endian bytes 00 00 80 3F
    expect(Array.from(decodeF32(Buffer.from([0, 0, 0x80, 0x3f]).toString('base64')))).toEqual([1])
  })

  it('rejects a byte length that is not a multiple of 4', () => {
    expect(() => decodeF32(Buffer.from([1, 2, 3]).toString('base64'))).toThrow(/multiple of 4/)
  })

  it('decodes an empty string to an empty array', () => {
    expect(decodeF32('')).toHaveLength(0)
  })
})
