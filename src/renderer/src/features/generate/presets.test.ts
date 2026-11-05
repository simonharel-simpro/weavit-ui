import { describe, expect, it } from 'vitest'
import { buildGenerativeConfig } from '../../../../main/weaviate/generate'
import { findPreset, OPENROUTER } from './presets'

describe('provider presets', () => {
  it('finds the OpenRouter preset by its select value and nothing else', () => {
    expect(findPreset('preset:openrouter')).toBe(OPENROUTER)
    expect(findPreset('openAI')).toBeUndefined()
    expect(findPreset(null)).toBeUndefined()
  })

  it('turns into an OpenAI-module config pointed at OpenRouter', () => {
    const config = buildGenerativeConfig({
      search: { connectionId: 'c', collection: 'C', type: 'bm25' },
      provider: OPENROUTER.provider,
      baseUrl: OPENROUTER.baseUrl,
      model: OPENROUTER.model
    } as Parameters<typeof buildGenerativeConfig>[0])

    // The SDK takes `baseURL` and re-emits it as `baseUrl` on the wire config.
    expect(config).toMatchObject({
      name: 'generative-openai',
      config: { baseUrl: 'https://openrouter.ai/api', model: 'deepseek/deepseek-v4-flash' }
    })
  })
})
