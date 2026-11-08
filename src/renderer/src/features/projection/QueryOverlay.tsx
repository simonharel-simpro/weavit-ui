import { Button, Group, NumberInput, Paper, SegmentedControl, Stack, Text, TextInput, Textarea } from '@mantine/core'
import { OVERLAY_K } from '@shared/projection'
import { IconSearch } from '@tabler/icons-react'
import { approximateBadge, type OverlayInput } from './overlay'
import type { useOverlay } from './useOverlay'

type Overlay = ReturnType<typeof useOverlay>

const MODES: { value: OverlayInput['mode']; label: string }[] = [
  { value: 'nearText', label: 'nearText' },
  { value: 'bm25', label: 'BM25' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'vector', label: 'Vector' },
  { value: 'point', label: 'From point' }
]

/** Compact search box over the projection; the searches stay in the run's tenant, vector and filter (U-5). */
export function QueryOverlay({ o, dim }: { o: Overlay; dim: number }) {
  const { form, patch, placement, highlight } = o
  const badge = placement ? approximateBadge(placement) : null
  return (
    <Paper withBorder p="xs" w={320} style={{ position: 'absolute', left: 8, top: 8, zIndex: 5 }}>
      <Stack gap={6}>
        <SegmentedControl size="xs" fullWidth data={MODES} value={form.mode}
          onChange={(v) => patch({ mode: v as OverlayInput['mode'] })} />
        {form.mode === 'vector' && (
          <Textarea size="xs" autosize minRows={2} maxRows={4} placeholder={`[${dim} numbers]`} value={form.vectorText}
            onChange={(e) => patch({ vectorText: e.currentTarget.value })} />
        )}
        {form.mode === 'point' && (
          <Text size="xs" c="dimmed">
            {form.pointUuid ? `Point ${form.pointUuid}` : 'Hover a point and choose "Use as query".'}
          </Text>
        )}
        {form.mode !== 'vector' && form.mode !== 'point' && (
          <TextInput size="xs" placeholder="search text" value={form.text}
            onChange={(e) => patch({ text: e.currentTarget.value })}
            onKeyDown={(e) => e.key === 'Enter' && o.search()} />
        )}
        <Group gap="xs" wrap="nowrap">
          <NumberInput size="xs" w={70} aria-label="Hits (k)" min={OVERLAY_K.min} max={OVERLAY_K.max} allowDecimal={false}
            value={form.k} onChange={(v) => typeof v === 'number' && patch({ k: v })} />
          <Button size="xs" loading={o.busy} leftSection={<IconSearch size={14} />} onClick={o.search}>Search</Button>
          <Button size="xs" variant="subtle" onClick={o.clear}>Clear</Button>
        </Group>
        {o.error && <Text size="xs" c="red">{o.error}</Text>}
        {highlight && <Text size="xs">{highlight.inView} / {highlight.total} hits in view</Text>}
        {badge && <Text size="xs" c="pink">{badge}</Text>}
        {placement && !placement.placed && <Text size="xs" c="dimmed">{placement.reason ?? 'could not be placed'}</Text>}
      </Stack>
    </Paper>
  )
}
