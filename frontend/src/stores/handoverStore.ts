import { createStore } from 'zustand/vanilla'
import type { HandoverSnapshot, Sketch, Station } from '@/types'
import { db, syncAll } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'

export class EmptyStationError extends Error {
  constructor() {
    super('没有测点的洞段不能确认交接')
    this.name = 'EmptyStationError'
  }
}

export interface HandoverState {
  snapshots: HandoverSnapshot[]
  loaded: boolean
  hydrate: () => Promise<void>
  confirm: (segmentId: string, confirmedBy: string) => Promise<HandoverSnapshot>
  restore: (snapshotId: string, restoredBy?: string) => Promise<HandoverSnapshot | undefined>
  removeBySegment: (segmentId: string) => Promise<void>
}

export const handoverStore = createStore<HandoverState>((set, get) => ({
  snapshots: [],
  loaded: false,
  hydrate: async () => {
    const snapshots = await syncAll<HandoverSnapshot>(db.handoverSnapshots)
    snapshots.sort((a, b) => a.version - b.version || a.confirmedAt.localeCompare(b.confirmedAt))
    set({ snapshots, loaded: true })
  },
  confirm: async (segmentId, confirmedBy) => {
    const segment = await db.segments.get(segmentId)
    if (!segment) throw new Error('洞段不存在或已删除')

    const stations = await db.stations.where('segmentId').equals(segmentId).toArray()
    if (stations.length === 0) throw new EmptyStationError()

    const sketches = await db.sketches.where('segmentId').equals(segmentId).toArray()
    const previous = await db.handoverSnapshots.where('segmentId').equals(segmentId).toArray()
    const snapshot: HandoverSnapshot = {
      id: uid('hs'),
      segmentId,
      version: previous.reduce((max, item) => Math.max(max, item.version), 0) + 1,
      startStake: segment.startStake,
      endStake: segment.endStake,
      type: segment.type,
      closed: segment.closed,
      sketchAnchors: sketches.map((sketch) => ({
        sketchId: sketch.id,
        sketchCode: sketch.code,
        anchorStake: sketch.anchorStake,
        mergeOrder: sketch.mergeOrder
      })),
      stations: stations.map((station) => ({ ...station })),
      confirmedBy: confirmedBy.trim(),
      confirmedAt: new Date().toISOString()
    }

    await db.handoverSnapshots.put(snapshot)
    await get().hydrate()
    return snapshot
  },
  restore: async (snapshotId, restoredBy = '') => {
    const snapshot = await db.handoverSnapshots.get(snapshotId)
    if (!snapshot) throw new Error('交接快照不存在')

    const allSnapshots = await db.handoverSnapshots.where('segmentId').equals(snapshot.segmentId).toArray()
    const latestVersion = allSnapshots.reduce((max, item) => Math.max(max, item.version), 0)
    let nextSnapshot: HandoverSnapshot | undefined

    await db.transaction(
      'rw',
      [db.segments, db.stations, db.sketches, db.handoverSnapshots],
      async () => {
        const segment = await db.segments.get(snapshot.segmentId)
        if (!segment) throw new Error('洞段不存在，无法恢复')

        await db.segments.put({
          ...segment,
          startStake: snapshot.startStake,
          endStake: snapshot.endStake,
          type: snapshot.type,
          closed: snapshot.closed
        })

        const snapshotStationIds = new Set(snapshot.stations.map((station) => station.id))
        const currentStations = await db.stations.where('segmentId').equals(snapshot.segmentId).toArray()
        await Promise.all(
          currentStations
            .filter((station) => !snapshotStationIds.has(station.id))
            .map((station) => db.stations.delete(station.id))
        )
        await Promise.all(
          snapshot.stations.map((station: Station) =>
            db.stations.put({ ...station, segmentId: snapshot.segmentId })
          )
        )

        const snapshotSketchIds = new Set(snapshot.sketchAnchors.map((anchor) => anchor.sketchId))
        const currentSketches = await db.sketches.where('segmentId').equals(snapshot.segmentId).toArray()
        await Promise.all(
          currentSketches
            .filter((sketch) => !snapshotSketchIds.has(sketch.id))
            .map((sketch) => db.sketches.delete(sketch.id))
        )
        await Promise.all(
          snapshot.sketchAnchors.map(async (anchor): Promise<void> => {
            const existing = await db.sketches.get(anchor.sketchId)
            const sketch: Sketch = existing
              ? {
                  ...existing,
                  segmentId: snapshot.segmentId,
                  code: anchor.sketchCode,
                  anchorStake: anchor.anchorStake,
                  mergeOrder: anchor.mergeOrder
                }
              : {
                  id: anchor.sketchId,
                  segmentId: snapshot.segmentId,
                  code: anchor.sketchCode,
                  gridCount: 0,
                  scale: 100,
                  author: '',
                  mergeOrder: anchor.mergeOrder,
                  anchorStake: anchor.anchorStake,
                  imageNote: ''
                }
            await db.sketches.put(sketch)
          })
        )

        if (snapshot.version < latestVersion) {
          nextSnapshot = {
            ...snapshot,
            id: uid('hs'),
            version: latestVersion + 1,
            restoredFromVersion: snapshot.version,
            confirmedBy: restoredBy.trim() || snapshot.confirmedBy,
            restoredBy: restoredBy.trim(),
            confirmedAt: new Date().toISOString()
          }
          await db.handoverSnapshots.put(nextSnapshot)
        }
      }
    )
    await get().hydrate()
    return nextSnapshot
  },
  removeBySegment: async (segmentId) => {
    const ids = get()
      .snapshots.filter((snapshot) => snapshot.segmentId === segmentId)
      .map((snapshot) => snapshot.id)
    await db.handoverSnapshots.bulkDelete(ids)
    await get().hydrate()
  }
}))
