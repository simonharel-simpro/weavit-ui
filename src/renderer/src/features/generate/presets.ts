// Provider presets for the RAG panel. Pure: no React or api imports, so the
// node tests can load it.
import type { GenerativeProvider } from '@shared/types'

export interface ProviderPreset {
  value: string
  label: string
  provider: GenerativeProvider
  baseUrl: string
  model: string
}

/** OpenRouter through Weaviate's OpenAI module: Weaviate appends /v1/chat/completions.
 *  Not the Anthropic module: it reads only the first content block, and reasoning
 *  models (deepseek) put a thinking block first, so the answer comes back empty.
 *  The key travels as the X-OpenAI-Api-Key connection header. */
export const OPENROUTER: ProviderPreset = {
  value: 'preset:openrouter',
  label: 'OpenRouter (deepseek-v4-flash)',
  provider: 'openAI',
  baseUrl: 'https://openrouter.ai/api',
  model: 'deepseek/deepseek-v4-flash'
}

export const PRESETS: readonly ProviderPreset[] = [OPENROUTER]

export function findPreset(value: string | null): ProviderPreset | undefined {
  return PRESETS.find((p) => p.value === value)
}
