import type { Segment, SegmentType, Station } from '@/types'

/** 交接时保存的草图锚点 */
export interface HandoverSketchAnchor {
  sketchId: string
  sketchCode: string
  anchorStake: string
  mergeOrder: number
}

/** 洞段交接快照：冻结交给下一班时的纸面/系统关键数据 */
export interface HandoverSnapshot {
  id: string
  segmentId: string
  /** 同一洞段每次确认递增，从 v1 开始 */
  version: number
  startStake: string
  endStake: string
  type: SegmentType
  closed: boolean
  sketchAnchors: HandoverSketchAnchor[]
  stations: Station[]
  confirmedBy: string
  confirmedAt: string
  /** 从历史版本恢复并另存为新版本时，记录来源版本 */
  restoredFromVersion?: number
  /** 从历史版本恢复并另存为新版本时，执行恢复的测量员 */
  restoredBy?: string
}

export type HandoverDeviationKind = 'segment' | 'station' | 'sketch'
export type HandoverDeviationStatus = 'changed' | 'added' | 'removed'

export interface HandoverDeviation {
  id: string
  kind: HandoverDeviationKind
  status: HandoverDeviationStatus
  target: string
  field: string
  snapshotValue?: unknown
  currentValue?: unknown
}

export interface HandoverSnapshotData {
  segment: Pick<Segment, 'startStake' | 'endStake' | 'type' | 'closed'>
  stations: Station[]
  sketchAnchors: HandoverSketchAnchor[]
}
