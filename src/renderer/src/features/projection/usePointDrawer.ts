import { useState } from 'react'
import { api } from '../../lib/api'
import { notifyErr } from '../../lib/notify'
import { afterDelete, type Frame } from './frame'

const NO_DELETED: ReadonlySet<string> = new Set()

interface Args {
  connectionId: string
  collection: string
  tenant?: string
  runId?: string
  uuids?: string[]
}

/** The object drawer's state: the opened uuid and the points marked deleted since the run (U-18). */
export function usePointDrawer({ connectionId, collection, tenant, runId, uuids }: Args) {
  const [uuid, setUuid] = useState<string>()
  const [deletedIn, setDeletedIn] = useState<{ runId?: string; set: ReadonlySet<string> }>({ set: NO_DELETED })
  const deleted = deletedIn.runId === runId ? deletedIn.set : NO_DELETED

  // The frame is a snapshot: after the drawer changed the object, a missing object is only marked.
  const handleChanged = async (frame: Pick<Frame, 'coords' | 'n'> | undefined): Promise<void> => {
    const id = uuid
    setUuid(undefined)
    if (!id || !frame) return
    try {
      if ((await api.data.getObject(connectionId, collection, id, tenant)) === null) {
        const next = afterDelete({ coords: frame.coords, n: frame.n, deleted }, id)
        setDeletedIn({ runId, set: next.deleted })
      }
    } catch (e) {
      notifyErr(e)
    }
  }
  const selectedIndex = uuid ? uuids?.indexOf(uuid) : undefined
  return { uuid, setUuid, deleted, selectedIndex, handleChanged }
}
