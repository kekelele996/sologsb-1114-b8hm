import { createStore } from 'zustand/vanilla'
import type { Cave } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

export interface CaveState {
  caves: Cave[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (cave: Cave) => Promise<void>
  setArchived: (id: string, archived: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const caveStore = createStore<CaveState>((set, get) => ({
  caves: [],
  loaded: false,
  hydrate: async () => {
    const caves = await syncAll<Cave>(db.caves)
    caves.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    set({ caves, loaded: true })
  },
  save: async (cave) => {
    await syncPut<Cave>(db.caves, cave)
    await get().hydrate()
  },
  setArchived: async (id, archived) => {
    const target = get().caves.find((item) => item.id === id)
    if (!target) return
    await syncPut<Cave>(db.caves, { ...target, archived })
    await get().hydrate()
  },
  remove: async (id) => {
    // 级联清理洞穴下的洞段、测点、草图与交接快照
    const segments = await db.segments.where('caveId').equals(id).toArray()
    const segmentIds = segments.map((segment) => segment.id)
    if (segmentIds.length > 0) {
      const stations = await db.stations.where('segmentId').anyOf(segmentIds).toArray()
      await db.stations.bulkDelete(stations.map((station) => station.id))
      const sketches = await db.sketches.where('segmentId').anyOf(segmentIds).toArray()
      await db.sketches.bulkDelete(sketches.map((sketch) => sketch.id))
      const snapshots = await db.handoverSnapshots.where('segmentId').anyOf(segmentIds).toArray()
      await db.handoverSnapshots.bulkDelete(snapshots.map((snapshot) => snapshot.id))
      await db.segments.bulkDelete(segmentIds)
    }
    await syncDelete<Cave>(db.caves, id)
    await get().hydrate()
  }
}))
