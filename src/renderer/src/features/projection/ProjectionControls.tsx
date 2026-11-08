import { Button, Group, NumberInput, Select, SegmentedControl, Stack, Tooltip } from '@mantine/core'
import { IconPlayerPlay, IconPlayerStop } from '@tabler/icons-react'
import { MAX_ROWS } from '@shared/projection'
import type { CollectionConfig, ProjectionMethod } from '@shared/types'
import { FilterBuilder } from '../query/FilterBuilder'
import { canRun, type Controls } from './defaults'

export interface ProjectionControlsProps {
  config: CollectionConfig | undefined
  controls: Controls
  onChange(patch: Partial<Controls>): void
  /** The Label / Colour options (the run's prefetched props) and their current values. */
  roleOptions: string[]
  labelProp?: string
  colourProp?: string
  onLabel(prop: string | null): void
  onColour(prop: string | null): void
  isRunning: boolean
  onRun(): void
  onCancel(): void
}

/** Run inputs on the first row; view-only Label and Colour below, which never start a run. */
export function ProjectionControls(p: ProjectionControlsProps) {
  const { config, controls, onChange } = p
  const verdict = canRun(controls)
  const vectors = (config?.namedVectors ?? []).map((v) => ({
    value: v.name,
    label: v.multiVector ? `${v.name} (multi-vector)` : v.name,
    disabled: v.multiVector === true
  }))

  return (
    <Stack gap="xs">
      <Group align="flex-end" gap="sm" wrap="wrap">
        <Select
          size="xs"
          label="Vector"
          w={190}
          data={vectors}
          value={controls.vector ?? null}
          onChange={(v) => onChange({ vector: v ?? undefined })}
          renderOption={({ option }) => (
            <Tooltip label="Multi-vector spaces cannot be projected (#32)" disabled={!option.disabled}>
              <span>{option.label}</span>
            </Tooltip>
          )}
        />
        <NumberInput
          size="xs"
          label="Limit"
          w={110}
          min={1}
          max={MAX_ROWS}
          allowDecimal={false}
          value={controls.limit}
          onChange={(v) => typeof v === 'number' && onChange({ limit: v })}
        />
        <SegmentedControl
          size="xs"
          data={[{ value: 'pca', label: 'PCA' }, { value: 'umap', label: 'UMAP' }]}
          value={controls.method}
          onChange={(v) => onChange({ method: v as ProjectionMethod })}
        />
        <SegmentedControl
          size="xs"
          data={[{ value: '2', label: '2D' }, { value: '3', label: '3D' }]}
          value={String(controls.dims)}
          onChange={(v) => onChange({ dims: v === '3' ? 3 : 2 })}
        />
        {p.isRunning ? (
          <Button size="xs" color="red" variant="light" leftSection={<IconPlayerStop size={14} />} onClick={p.onCancel}>
            Cancel
          </Button>
        ) : (
          <Tooltip label={verdict.ok ? '' : verdict.hint} disabled={verdict.ok}>
            <Button size="xs" disabled={!verdict.ok} leftSection={<IconPlayerPlay size={14} />} onClick={p.onRun}>
              Run
            </Button>
          </Tooltip>
        )}
        <Select size="xs" label="Label" w={160} clearable placeholder="uuid" data={p.roleOptions}
          disabled={p.roleOptions.length === 0} value={p.labelProp ?? null} onChange={(v) => p.onLabel(v)} />
        <Select size="xs" label="Colour" w={160} clearable placeholder="single colour" data={p.roleOptions}
          disabled={p.roleOptions.length === 0} value={p.colourProp ?? null} onChange={(v) => p.onColour(v)} />
      </Group>
      <FilterBuilder
        value={controls.filters}
        onChange={(filters) => onChange({ filters })}
        properties={(config?.properties ?? []).map((x) => x.name)}
        references={config?.references}
      />
    </Stack>
  )
}
