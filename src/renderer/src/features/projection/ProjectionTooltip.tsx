import { Button, Paper, Stack, Text } from '@mantine/core'

export interface TooltipAction {
  label: string
  onClick(index: number): void
}

interface Props {
  x: number
  y: number
  index: number
  lines: string[]
  actions?: TooltipAction[]
}

export function ProjectionTooltip({ x, y, index, lines, actions }: Props) {
  return (
    <Paper
      shadow="md"
      p="xs"
      withBorder
      style={{ position: 'absolute', left: x + 12, top: y + 12, maxWidth: 320, zIndex: 5 }}
    >
      <Stack gap={2}>
        {lines.map((line, i) => (
          <Text key={i} size="xs" style={{ wordBreak: 'break-word' }}>
            {line}
          </Text>
        ))}
        {actions?.map((a) => (
          <Button key={a.label} size="compact-xs" variant="light" onClick={() => a.onClick(index)}>
            {a.label}
          </Button>
        ))}
      </Stack>
    </Paper>
  )
}
