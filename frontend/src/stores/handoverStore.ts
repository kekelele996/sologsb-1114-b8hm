import { createStore } from 'zustand/vanilla'
import type { HandoverSnapshot, Segment, Sketch, Station } from '@/types'
import { db, syncAll } from '@/hooks/usePersistentStore'
import { buildSnapshot, HANDOVER_THRESHOLD } from '@/utils/handover'

export interface ConfirmInput {
  segment: Segment
  stations: Station[]
  sketches: Sketch[]
  handedBy: string
  note: string
}

export interface HandoverState {
  snapshots: HandoverSnapshot[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 确认交接：无测点的洞段拒绝确认；返回新版本号 */
  confirm: (input: ConfirmInput) => Promise<number>
  remove: (id: string) => Promise<void>
  removeBySegment: (segmentId: string) => Promise<void>
  removeByCave: (caveId: string) => Promise<void>
  /**
   * 恢复快照：在一个事务内还原洞段关键字段、全部测点与草图锚点。
   * 恢复后闭合差与拼合视图依赖的各 store 由调用方统一重新水合。
   */
  restore: (snapshotId: string) => Promise<void>
}

function sortSnapshots(list: HandoverSnapshot[]): HandoverSnapshot[] {
  return [...list].sort((a, b) => {
    const seg = a.segmentCode.localeCompare(b.segmentCode, 'zh-Hans-CN')
    return seg !== 0 ? seg : a.version - b.version
  })
}

export const handoverStore = createStore<HandoverState>((set, get) => ({
  snapshots: [],
  loaded: false,
  hydrate: async () => {
    const snapshots = await syncAll<HandoverSnapshot>(db.handoverSnapshots)
    set({ snapshots: sortSnapshots(snapshots), loaded: true })
  },
  confirm: async ({ segment, stations, sketches, handedBy, note }) => {
    if (stations.length === 0) {
      throw new Error('该洞段还没有任何测点，无法确认交接')
    }
    const existing = await db.handoverSnapshots.where('segmentId').equals(segment.id).toArray()
    const nextVersion = existing.reduce((max, item) => Math.max(max, item.version), 0) + 1
    const snapshot = buildSnapshot({
      segment,
      stations,
      sketches,
      version: nextVersion,
      handedBy,
      note
    })
    await db.handoverSnapshots.put(snapshot)
    await get().hydrate()
    return nextVersion
  },
  remove: async (id) => {
    await db.handoverSnapshots.delete(id)
    await get().hydrate()
  },
  removeBySegment: async (segmentId) => {
    const rows = await db.handoverSnapshots.where('segmentId').equals(segmentId).toArray()
    await db.handoverSnapshots.bulkDelete(rows.map((row) => row.id))
    await get().hydrate()
  },
  removeByCave: async (caveId) => {
    const segments = await db.segments.where('caveId').equals(caveId).toArray()
    const segmentIds = new Set(segments.map((segment) => segment.id))
    const rows = (await db.handoverSnapshots.toArray()).filter((row) => segmentIds.has(row.segmentId))
    await db.handoverSnapshots.bulkDelete(rows.map((row) => row.id))
    await get().hydrate()
  },
  restore: async (snapshotId) => {
    await db.transaction(
      'rw',
      [db.segments, db.stations, db.sketches, db.handoverSnapshots],
      async () => {
        const snapshot = await db.handoverSnapshots.get(snapshotId)
        if (!snapshot) throw new Error('交接快照不存在或已被删除')
        const segment = await db.segments.get(snapshot.segmentId)
        if (!segment) throw new Error('洞段已被删除，无法恢复快照')

        // 1. 还原洞段起止桩号 / 类型 / 闭合标记，其余编目字段保持现状
        await db.segments.put({
          ...segment,
          startStake: snapshot.startStake,
          endStake: snapshot.endStake,
          type: snapshot.type,
          closed: snapshot.closed
        })

        // 2. 以快照测点集整体替换当前洞段测点
        const currentStationIds = (await db.stations.where('segmentId').equals(segment.id).toArray()).map(
          (station) => station.id
        )
        await db.stations.bulkDelete(currentStationIds)
        const restoredStations: Station[] = snapshot.stations.map((station) => ({
          ...station,
          segmentId: segment.id
        }))
        await db.stations.bulkPut(restoredStations)

        // 3. 还原仍存在草图的桩号对齐锚点（快照之后新建的草图不受影响）
        const currentSketches = await db.sketches.where('segmentId').equals(segment.id).toArray()
        const anchorMap = new Map(snapshot.sketchAnchors.map((anchor) => [anchor.sketchId, anchor.anchorStake]))
        await Promise.all(
          currentSketches.map((sketch) => {
            if (!anchorMap.has(sketch.id)) return Promise.resolve()
            return db.sketches.put({ ...sketch, anchorStake: anchorMap.get(sketch.id) ?? '' })
          })
        )
      }
    )
    await get().hydrate()
  }
}))

/** 闭合差阈值，供界面复用 */
export { HANDOVER_THRESHOLD }
