import type { ClosureResult, Station } from './station'
import type { SegmentType } from './segment'

/** 洞段交接快照：交下班前固化的洞段数据凭证 */
export interface HandoverSnapshot {
  id: string
  segmentId: string
  /** 交接版本号，同一洞段从 v1 起逐次递增 */
  version: number
  /** 洞段编号冗余，洞段被删除后仍可辨认 */
  segmentCode: string
  // —— 固化的洞段关键字段 ——
  startStake: string
  endStake: string
  type: SegmentType
  closed: boolean
  /** 草图锚点（按草图 id 固化桩号对齐锚点） */
  sketchAnchors: HandoverSketchAnchor[]
  /** 全部测点读数（脱离 stations 表的完整副本） */
  stations: Station[]
  /** 确认时刻的闭合差结果 */
  closure: ClosureResult
  /** 交班测量员 */
  handedBy: string
  note: string
  confirmedAt: string
}

/** 快照中的草图锚点记录 */
export interface HandoverSketchAnchor {
  sketchId: string
  sketchCode: string
  anchorStake: string
}

/** 字段变更：快照值 → 当前值 */
export interface HandoverFieldChange {
  field: string
  label: string
  snapshotValue: string
  currentValue: string
}

/** 测点变更：新增 / 删除 / 修改 */
export interface HandoverStationChange {
  kind: 'added' | 'removed' | 'modified'
  stationId: string
  code: string
  changes: HandoverFieldChange[]
}

/** 草图锚点变更 */
export interface HandoverAnchorChange {
  kind: 'added' | 'removed' | 'modified'
  sketchId: string
  sketchCode: string
  changes: HandoverFieldChange[]
}

/** 快照与当前数据的偏差对比结果 */
export interface HandoverDiff {
  /** 洞段本体是否已被删除 */
  segmentMissing: boolean
  segmentChanges: HandoverFieldChange[]
  stationChanges: HandoverStationChange[]
  anchorChanges: HandoverAnchorChange[]
  /** 是否存在任何偏差 */
  hasChanges: boolean
  /** 当前测点重算的闭合差 */
  currentClosure: ClosureResult | null
}
