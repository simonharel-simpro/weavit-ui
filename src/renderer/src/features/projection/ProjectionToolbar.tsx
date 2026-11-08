import { Group, SegmentedControl } from '@mantine/core'
import type { ProjectionMethod, ProjectionStatus } from '@shared/types'
import type { BreadcrumbLevel } from '../../store'
import { ProjectionBreadcrumb } from './ProjectionBreadcrumb'
import { ProjectionStatusLine } from './ProjectionStatusLine'

export interface ProjectionToolbarProps {
  status: ProjectionStatus | undefined
  matches: boolean
  edited: boolean
  rerunDims?: 2 | 3
  levels: BreadcrumbLevel[]
  onBack(steps: number): void
  view: ProjectionMethod
  onView(view: ProjectionMethod): void
}

/** Status line, breadcrumb and the PCA/UMAP view switch. */
export function ProjectionToolbar(p: ProjectionToolbarProps) {
  return (
    <Group justify="space-between">
      <ProjectionStatusLine
        status={p.status}
        matches={p.matches}
        edited={p.edited}
        rerunDims={p.rerunDims}
        locale={navigator.language}
      />
      <ProjectionBreadcrumb levels={p.levels} onBack={p.onBack} />
      <SegmentedControl
        size="xs"
        data={[{ value: 'pca', label: 'PCA view' }, { value: 'umap', label: 'UMAP view' }]}
        value={p.view}
        onChange={(x) => p.onView(x as ProjectionMethod)}
      />
    </Group>
  )
}
