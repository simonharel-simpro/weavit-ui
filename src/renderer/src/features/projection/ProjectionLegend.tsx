import { Box, ColorSwatch, Group, Paper, Stack, Text } from '@mantine/core'
import type { LegendEntry } from './colors'

/** The colour key; hidden for a single colour, where it would say nothing. */
export function ProjectionLegend({ legend, title }: { legend: LegendEntry[]; title: string }) {
  if (legend.length <= 1) return null
  return (
    <Paper withBorder p="xs" style={{ position: 'absolute', right: 8, top: 8, maxWidth: 220, zIndex: 4 }}>
      <Text size="xs" fw={600} mb={4}>{title}</Text>
      <Stack gap={2}>
        {legend.map((e) => (
          <Group key={e.label} gap={6} wrap="nowrap">
            <ColorSwatch size={10} color={`rgb(${e.color.join(',')})`} />
            <Box style={{ minWidth: 0 }}>
              <Text size="xs" truncate>{e.label}{e.count !== undefined && ` (${e.count})`}</Text>
            </Box>
          </Group>
        ))}
      </Stack>
    </Paper>
  )
}
