import { describe, expect, it } from 'vitest'
import { collectionFromSearch } from './deepLink'

describe('collectionFromSearch', () => {
  it('reads a valid collection name', () => {
    expect(collectionFromSearch('?collection=MiniRag_t2v_x_6f5bda78')).toBe('MiniRag_t2v_x_6f5bda78')
  })

  it.each(['', '?other=1', '?collection=', '?collection=miniRag', '?collection=Mini-Rag', '?collection=%3Cscript%3E'])(
    'ignores a missing or invalid name (%s)',
    (search) => {
      expect(collectionFromSearch(search)).toBeUndefined()
    }
  )
})
