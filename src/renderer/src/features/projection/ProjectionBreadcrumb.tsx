import { ActionIcon, Anchor, Breadcrumbs, Group, Text, Tooltip } from '@mantine/core'
import { IconArrowLeft } from '@tabler/icons-react'
import type { BreadcrumbLevel } from '../../store'

export interface ProjectionBreadcrumbProps {
  levels: BreadcrumbLevel[]
  onBack(steps: number): void
}

const MARK: Record<BreadcrumbLevel['status'], string> = {
  running: ' …',
  done: '',
  failed: ' (failed)',
  cancelled: ' (cancelled)'
}

function crumbText(l: BreadcrumbLevel): string {
  const count = l.indices?.length ?? l.n
  const size = count === undefined ? '' : ` (${count.toLocaleString(navigator.language)})`
  return `${l.label}${size}${MARK[l.status]}`
}

/** "All (100 000) › Selection 1 (8 214)": a parent crumb steps back to it. Hidden at the root. */
export function ProjectionBreadcrumb({ levels, onBack }: ProjectionBreadcrumbProps) {
  if (levels.length <= 1) return null
  const last = levels.length - 1
  return (
    <Group gap="xs" wrap="nowrap">
      <Tooltip label="Back">
        <ActionIcon size="sm" variant="light" aria-label="Back" onClick={() => onBack(1)}>
          <IconArrowLeft size={14} />
        </ActionIcon>
      </Tooltip>
      <Breadcrumbs separatorMargin={6}>
        {levels.map((l, i) =>
          i === last ? (
            <Text key={l.runId} size="xs" fw={600}>{crumbText(l)}</Text>
          ) : (
            <Anchor key={l.runId} size="xs" component="button" type="button" onClick={() => onBack(last - i)}>
              {crumbText(l)}
            </Anchor>
          )
        )}
      </Breadcrumbs>
    </Group>
  )
}
