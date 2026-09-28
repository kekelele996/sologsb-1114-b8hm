import type {
  ClosureResult,
  HandoverAnchorChange,
  HandoverDiff,
  HandoverFieldChange,
  HandoverSketchAnchor,
  HandoverSnapshot,
  HandoverStationChange,
  Segment,
  Sketch,
  Station
} from '@/types'
import { computeClosure } from '@/utils/survey'

/** 交接快照默认闭合差阈值（米） */
export const HANDOVER_THRESHOLD = 0.25

/** 深拷贝测点，确保快照副本与后续编辑互不影响 */
function cloneStations(stations: Station[]): Station[] {
  return stations.map((station) => ({ ...station }))
}

/** 从草图记录中提取桩号对齐锚点（含空锚点，保证恢复时可精确还原） */
export function extractSketchAnchors(sketches: Sketch[]): HandoverSketchAnchor[] {
  return sketches.map((sketch) => ({
    sketchId: sketch.id,
    sketchCode: sketch.code,
    anchorStake: sketch.anchorStake.trim()
  }))
}

export interface SnapshotInput {
  segment: Segment
  stations: Station[]
  sketches: Sketch[]
  version: number
  handedBy: string
  note: string
}

/** 构造一份交接快照（调用前须确保洞段至少有一个测点） */
export function buildSnapshot(input: SnapshotInput): HandoverSnapshot {
  const { segment, stations, sketches, version, handedBy, note } = input
  const ordered = [...stations].sort(
    (a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0])
  )
  return {
    id: `hs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    segmentId: segment.id,
    version,
    segmentCode: segment.code,
    startStake: segment.startStake,
    endStake: segment.endStake,
    type: segment.type,
    closed: segment.closed,
    sketchAnchors: extractSketchAnchors(sketches),
    stations: cloneStations(ordered),
    closure: computeClosure(ordered, HANDOVER_THRESHOLD),
    handedBy: handedBy.trim(),
    note: note.trim(),
    confirmedAt: new Date().toISOString()
  }
}

function displayClosed(value: boolean): string {
  return value ? '已闭合' : '未闭合'
}

function diffField(
  field: string,
  label: string,
  snapshotValue: unknown,
  currentValue: unknown
): HandoverFieldChange | null {
  if (snapshotValue === currentValue) return null
  return {
    field,
    label,
    snapshotValue: String(snapshotValue),
    currentValue: String(currentValue)
  }
}

/** 测点读数需要逐字段比对的列 */
const STATION_FIELDS: { key: keyof Station; label: string }[] = [
  { key: 'bearing', label: '方位角' },
  { key: 'dip', label: '倾角' },
  { key: 'slopeDistance', label: '斜距' },
  { key: 'horizontalDistance', label: '水平距' },
  { key: 'verticalDistance', label: '垂距' },
  { key: 'isClosurePoint', label: '闭合点' },
  { key: 'instrumentNo', label: '仪器号' },
  { key: 'surveyor', label: '测量人' },
  { key: 'date', label: '日期' },
  { key: 'note', label: '备注' }
]

/** 对比单条测点的读数改动 */
function diffStation(snapshotStation: Station, currentStation: Station): HandoverFieldChange[] {
  const changes: HandoverFieldChange[] = []
  for (const { key, label } of STATION_FIELDS) {
    const oldValue = snapshotStation[key]
    const newValue = currentStation[key]
    const rendered =
      key === 'isClosurePoint'
        ? diffField(key, label, displayClosed(Boolean(oldValue)), displayClosed(Boolean(newValue)))
        : diffField(key, label, oldValue, newValue)
    if (rendered) changes.push(rendered)
  }
  return changes
}

/**
 * 对比快照与当前数据，列出洞段字段、测点、草图锚点三方面的偏差，
 * 并按当前测点重算闭合差。
 */
export function diffSnapshot(
  snapshot: HandoverSnapshot,
  segment: Segment | undefined,
  currentStations: Station[],
  currentSketches: Sketch[]
): HandoverDiff {
  const segmentChanges: HandoverFieldChange[] = []
  const stationChanges: HandoverStationChange[] = []
  const anchorChanges: HandoverAnchorChange[] = []

  if (segment) {
    const checks: (HandoverFieldChange | null)[] = [
      diffField('startStake', '起始桩号', snapshot.startStake, segment.startStake),
      diffField('endStake', '结束桩号', snapshot.endStake, segment.endStake),
      diffField('type', '类型', snapshot.type, segment.type),
      diffField('closed', '闭合标记', displayClosed(snapshot.closed), displayClosed(segment.closed))
    ]
    for (const change of checks) if (change) segmentChanges.push(change)
  }

  // —— 测点：以 id 对齐，区分新增 / 删除 / 修改 ——
  const snapshotMap = new Map(snapshot.stations.map((station) => [station.id, station]))
  const currentMap = new Map(currentStations.map((station) => [station.id, station]))

  for (const station of currentStations) {
    const oldStation = snapshotMap.get(station.id)
    if (!oldStation) {
      stationChanges.push({ kind: 'added', stationId: station.id, code: station.code, changes: [] })
      continue
    }
    const changes = diffStation(oldStation, station)
    if (changes.length > 0) {
      stationChanges.push({ kind: 'modified', stationId: station.id, code: station.code, changes })
    }
  }
  for (const station of snapshot.stations) {
    if (!currentMap.has(station.id)) {
      stationChanges.push({ kind: 'removed', stationId: station.id, code: station.code, changes: [] })
    }
  }

  // —— 草图锚点：以草图 id 对齐 ——
  const snapshotAnchors = new Map(snapshot.sketchAnchors.map((anchor) => [anchor.sketchId, anchor]))
  const currentAnchors = new Map(
    currentSketches.map((sketch) => [
      sketch.id,
      { sketchId: sketch.id, sketchCode: sketch.code, anchorStake: sketch.anchorStake.trim() }
    ])
  )

  for (const anchor of currentAnchors.values()) {
    const oldAnchor = snapshotAnchors.get(anchor.sketchId)
    if (!oldAnchor) {
      // 新增草图且未设锚点不算偏差，避免草图记录本身的增删干扰锚点对比
      if (anchor.anchorStake) {
        anchorChanges.push({ kind: 'added', sketchId: anchor.sketchId, sketchCode: anchor.sketchCode, changes: [] })
      }
      continue
    }
    const change = diffField('anchorStake', '锚点桩号', oldAnchor.anchorStake, anchor.anchorStake)
    if (change) {
      anchorChanges.push({ kind: 'modified', sketchId: anchor.sketchId, sketchCode: anchor.sketchCode, changes: [change] })
    }
  }
  for (const anchor of snapshotAnchors.values()) {
    if (!currentAnchors.has(anchor.sketchId)) {
      anchorChanges.push({ kind: 'removed', sketchId: anchor.sketchId, sketchCode: anchor.sketchCode, changes: [] })
    }
  }

  const hasChanges =
    !segment || segmentChanges.length > 0 || stationChanges.length > 0 || anchorChanges.length > 0
  const currentClosure: ClosureResult | null = segment
    ? computeClosure(currentStations, snapshot.closure.threshold)
    : null

  return { segmentMissing: !segment, segmentChanges, stationChanges, anchorChanges, hasChanges, currentClosure }
}

/** 交接版本标签，如 v3 */
export function versionLabel(version: number): string {
  return `v${version}`
}

/** 格式化确认时间 */
export function formatConfirmedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
