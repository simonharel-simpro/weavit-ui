import { Alert, Badge, Group, Text } from '@mantine/core'
import type { ProjectionStatus, ProjectionStatusKnown } from '@shared/types'
import { isKnown } from './frame'
import { capBanner, cancelledBadge, progressText, skippedBanner } from './progress'

export interface ProjectionStatusLineProps {
  status: ProjectionStatus | undefined
  /** False when the run belongs to another collection/tenant than the open view (U-6). */
  matches: boolean
  edited: boolean
  /** "Re-run for 3D": the dims the controls want, set when a UMAP frame was run at others. */
  rerunDims?: 2 | 3
  locale?: string
}

function runText(s: ProjectionStatusKnown, locale?: string): string | null {
  if (s.state !== 'reading' && s.state !== 'computing') return null
  if (!s.stage) return s.state === 'reading' ? 'Reading' : 'Computing'
  return progressText(s.stage, s.progress?.done ?? 0, s.progress?.total, locale)
}

export function ProjectionStatusLine({ status, matches, edited, rerunDims, locale }: ProjectionStatusLineProps) {
  if (!status) return null
  if (!isKnown(status)) {
    return <Text size="xs" c="dimmed">This run was replaced — Run again</Text>
  }
  if (!matches) return <Text size="xs" c="dimmed">Projection running on {status.scope.collection}</Text>
  const text = runText(status, locale)
  const banners = [
    status.cap && capBanner(status.cap, locale),
    status.skipped && skippedBanner(status.skipped, status.scope.vector, locale),
    status.notice
  ].filter((b): b is string => !!b)

  return (
    <Group gap="xs" wrap="wrap">
      {text && <Text size="xs">{text}</Text>}
      {status.state === 'cancelled' && <Badge color="gray" variant="light">{cancelledBadge(status, locale)}</Badge>}
      {status.state === 'superseded' && <Text size="xs" c="dimmed">This run was replaced — Run again</Text>}
      {status.state === 'empty' && <Text size="xs" c="dimmed">No object had a usable vector.</Text>}
      {edited && <Badge color="yellow" variant="light">edited — Run to apply</Badge>}
      {rerunDims && <Badge color="yellow" variant="light">Re-run for {rerunDims}D</Badge>}
      {banners.map((b) => <Text key={b} size="xs" c="dimmed">{b}</Text>)}
      {status.state === 'failed' && status.error && (
        <Alert color="red" p="xs" w="100%">{status.error}</Alert>
      )}
    </Group>
  )
}
