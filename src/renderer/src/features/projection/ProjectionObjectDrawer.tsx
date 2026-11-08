import { Alert } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { ObjectDrawer } from '../data/ObjectDrawer'

interface Props {
  connectionId: string
  collection: string
  tenant?: string
  uuid: string
  onClose(): void
  onChanged(): void
}

/** Fetches the clicked point's object; a deleted one is said so instead of opening empty. */
export function ProjectionObjectDrawer({ connectionId, collection, tenant, uuid, onClose, onChanged }: Props) {
  const object = useQuery({
    queryKey: queryKeys.object(connectionId, collection, uuid, tenant),
    queryFn: () => api.data.getObject(connectionId, collection, uuid, tenant),
    enabled: !!uuid
  })
  if (object.data === null) {
    return (
      <Alert color="gray" withCloseButton onClose={onClose}>
        This object no longer exists
      </Alert>
    )
  }
  if (!object.data) return null
  return (
    <ObjectDrawer
      connectionId={connectionId}
      collection={collection}
      tenant={tenant}
      object={object.data}
      onClose={onClose}
      onChanged={onChanged}
    />
  )
}
