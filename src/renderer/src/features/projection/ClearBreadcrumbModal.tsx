import { Button, Group, Modal, Text } from '@mantine/core'

/** D-20: editing a root input below the root re-reads the collection and drops the drill-down. */
export function ClearBreadcrumbModal(p: { levels: number | undefined; onCancel(): void; onConfirm(): void }) {
  return (
    <Modal opened={p.levels !== undefined} onClose={p.onCancel} title="Run from the root?" centered>
      <Text size="sm" mb="md">
        This clears the breadcrumb ({p.levels} levels) and reads the collection again.
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={p.onCancel}>Cancel</Button>
        <Button color="red" onClick={p.onConfirm}>Clear and run</Button>
      </Group>
    </Modal>
  )
}
