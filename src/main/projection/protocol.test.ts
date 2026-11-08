import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeF32, MAX_CELLS, NN_DEFAULT } from '@shared/projection'
import {
  encodeF32,
  encodeHeader,
  HEADER_DEFAULTS,
  LineSplitter,
  parseMessage,
  PROTOCOL,
  ProtocolError
} from './protocol'

const FIXTURES = fileURLToPath(
  new URL('../../../native/projector/fixtures/protocol-v1/', import.meta.url)
)
const fixture = (name: string): string => readFileSync(FIXTURES + name, 'utf8')
const lines = (): string[] => fixture('messages.ndjson').split('\n').filter((l) => l.length > 0)
const expected = JSON.parse(fixture('messages.expected.json')) as Record<
  string,
  Record<string, number[]>
>
const b64 = (values: number[]): string =>
  Buffer.from(new Float32Array(values).buffer).toString('base64')
const decoded = (s: string): number[] => Array.from(decodeF32(s))

describe('protocol v1 fixtures', () => {
  it('protocol: parses every fixture message', () => {
    const msgs = lines().map(parseMessage)
    const by = <T extends string>(t: T) => msgs.filter((m) => m.type === t)
    const basis = by('basis')[0]
    const pcaChunk = by('pcaChunk')[0]
    const pca50 = by('pca50')[0]
    const frame = by('frame')[0]
    if (basis.type !== 'basis' || pcaChunk.type !== 'pcaChunk') throw new Error('fixture shape')
    if (pca50.type !== 'pca50' || frame.type !== 'frame') throw new Error('fixture shape')
    expect(decoded(basis.mean)).toEqual(expected.basis.mean)
    expect(decoded(basis.components)).toEqual(expected.basis.components)
    expect(decoded(pcaChunk.coords)).toEqual(expected.pcaChunk.coords)
    expect(decoded(pca50.coords)).toEqual(expected.pca50.coords)
    expect(decoded(frame.coords)).toEqual(expected.frame.coords)
    expect(msgs.map((m) => m.type)).toContain('done')
    expect(msgs.map((m) => m.type)).toContain('error')
    expect(msgs.map((m) => m.type)).toContain('notice')
  })

  it('protocol: encodeHeader(defaults) deep-equals header.valid.json', () => {
    const header = encodeHeader({
      ...HEADER_DEFAULTS,
      nMax: 100000,
      dim: 384,
      method: 'umap',
      dims: 3
    })
    expect(header.endsWith('\n')).toBe(true)
    expect(JSON.parse(header)).toEqual(JSON.parse(fixture('header.valid.json')))
  })

  it('protocol: fixture hello matches PROTOCOL', () => {
    expect(parseMessage(lines()[0])).toEqual({ type: 'hello', protocol: PROTOCOL })
  })

  it('protocol: MAX_CELLS matches the Rust cap', () => {
    const atLimit = JSON.parse(fixture('header.valid.at-limit.json'))
    const tooLarge = JSON.parse(fixture('header.invalid.too-large.json'))
    expect(atLimit.nMax * atLimit.dim).toBe(MAX_CELLS)
    expect(tooLarge.nMax * tooLarge.dim).toBeGreaterThan(MAX_CELLS)
    expect(HEADER_DEFAULTS.nNeighbors).toBe(NN_DEFAULT)
  })

  it('protocol: progress samples cover every stage', () => {
    const progress = lines()
      .filter((l) => l.includes('"progress"'))
      .map(parseMessage)
    expect(progress).toHaveLength(4)
    expect(progress.map((m) => (m.type === 'progress' ? m.stage : m.type))).toEqual([
      'pca',
      'knn',
      'graph',
      'epochs'
    ])
  })
})

describe('LineSplitter', () => {
  it('F-10: should reassemble a frame split across 3 chunks', () => {
    const coords = b64([1, 2, 3, 4, 5, 6, 7, 8])
    const line = `{"type":"frame","stage":"umap","epoch":10,"epochs":200,"dims":2,"n":4,"coords":"${coords}"}\n`
    const buf = Buffer.from(line)
    const splitter = new LineSplitter()
    const out = [
      ...splitter.push(buf.subarray(0, 20)),
      ...splitter.push(buf.subarray(20, 60)),
      ...splitter.push(buf.subarray(60))
    ]
    expect(out).toHaveLength(1)
    const msg = parseMessage(out[0])
    if (msg.type !== 'frame') throw new Error('expected a frame')
    expect(decodeF32(msg.coords)).toHaveLength(msg.n * msg.dims)
  })

  it('keeps a multi-byte character split across chunks intact', () => {
    const buf = Buffer.from('{"type":"notice","message":"héllo"}\n')
    const cut = buf.indexOf(0xa9) // second byte of é
    const splitter = new LineSplitter()
    const out = [...splitter.push(buf.subarray(0, cut)), ...splitter.push(buf.subarray(cut))]
    expect(parseMessage(out[0])).toEqual({ type: 'notice', message: 'héllo' })
  })

  it('yields several lines from one chunk and holds back the partial tail', () => {
    const splitter = new LineSplitter()
    expect(splitter.push(Buffer.from('a\nb\nc'))).toEqual(['a', 'b'])
    expect(splitter.push(Buffer.from('d\n'))).toEqual(['cd'])
  })

  it('rejects a line over 64 MB', () => {
    const splitter = new LineSplitter()
    expect(() => splitter.push(Buffer.alloc(64 * 1024 * 1024 + 1, 0x61))).toThrow(ProtocolError)
  })
})

describe('parseMessage', () => {
  it('F-10: should fail when a frame coords length is not n*dims', () => {
    const line = `{"type":"frame","stage":"umap","epoch":1,"epochs":2,"dims":2,"n":4,"coords":"${b64([1, 2, 3, 4, 5, 6, 7])}"}`
    expect(() => parseMessage(line)).toThrow(ProtocolError)
  })

  it.each([
    ['non-JSON', 'oops'],
    ['an unknown type', '{"type":"bogus"}'],
    ['a negative count', '{"type":"done","n":-1}'],
    ['a pcaChunk of the wrong length', `{"type":"pcaChunk","offset":0,"count":2,"coords":"${b64([1, 2, 3])}"}`],
    ['a pca50 of the wrong length', `{"type":"pca50","n":2,"pcaDims":2,"coords":"${b64([1, 2, 3])}"}`],
    ['a basis of the wrong length', `{"type":"basis","mean":"${b64([1, 2])}","components":"${b64([1])}","pcaDims":2}`],
    ['a non-base64 payload', '{"type":"pca50","n":0,"pcaDims":2,"coords":"%%%"}']
  ])('rejects %s', (_label, line) => {
    expect(() => parseMessage(line)).toThrow(ProtocolError)
  })
})

describe('encodeF32', () => {
  it('round-trips through decodeF32 as little-endian bytes', () => {
    const values = [1.5, -2, 0, 3.25e-7, 65504]
    const s = encodeF32(new Float32Array(values))
    expect(s).toBe(b64(values))
    expect(decoded(s)).toEqual(values.map(Math.fround))
  })
})
