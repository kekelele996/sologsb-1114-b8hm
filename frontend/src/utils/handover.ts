import type { Segment, Sketch, Station } from '@/types'
import type {
  HandoverDeviation,
  HandoverDeviationKind,
  HandoverSketchAnchor,
  HandoverSnapshot
} from '@/types/handover'

const SEGMENT_FIELDS: { key: keyof Pick<Segment, 'startStake' | 'endStake' | 'type' | 'closed'>; label: string }[] = [
  { key: 'startStake', label: '起始桩号' },
  { key: 'endStake', label: '结束桩号' },
  { key: 'type', label: '类型' },
  { key: 'closed', label: '闭合标记' }
]

const STATION_FIELDS: { key: keyof Station; label: string }[] = [
  { key: 'code', label: '测点桩号' },
  { key: 'bearing', label: '前视方位角' },
  { key: 'dip', label: '倾角' },
  { key: 'slopeDistance', label: '斜距' },
  { key: 'horizontalDistance', label: '水平距' },
  { key: 'verticalDistance', label: '垂距' },
  { key: 'instrumentNo', label: '仪器号' },
  { key: 'surveyor', label: '测量人' },
  { key: 'date', label: '测量日期' },
  { key: 'isClosurePoint', label: '闭合点' },
  { key: 'note', label: '备注' }
]

const SKETCH_FIELDS: { key: keyof HandoverSketchAnchor; label: string }[] = [
  { key: 'anchorStake', label: '草图锚点' },
  { key: 'mergeOrder', label: '拼合顺序' }
]

function isDifferent(snapshotValue: unknown, currentValue: unknown): boolean {
  if (snapshotValue === currentValue) return false
  return snapshotValue !== snapshotValue && currentValue !== currentValue
    ? false
    : String(snapshotValue ?? '') !== String(currentValue ?? '')
}

function pushChanged<TSnapshot extends object, TCurrent extends object>(
  deviations: HandoverDeviation[],
  kind: HandoverDeviationKind,
  target: string,
  fields: { key: keyof TSnapshot & keyof TCurrent; label: string }[],
  snapshot: TSnapshot,
  current: TCurrent
): void {
  fields.forEach(({ key, label }) => {
    const snapshotValue = snapshot[key]
    const currentValue = current[key]
    if (isDifferent(snapshotValue, currentValue)) {
      deviations.push({
        id: `${kind}-${String(key)}-${target}`,
        kind,
        status: 'changed',
        target,
        field: label,
        snapshotValue,
        currentValue
      })
    }
  })
}

/** 对比当前洞段、测点和草图锚点与交接快照之间的偏差 */
export function diffHandoverSnapshot(
  snapshot: HandoverSnapshot,
  currentSegment: Segment | undefined,
  stations: Station[],
  sketches: Sketch[]
): HandoverDeviation[] {
  const deviations: HandoverDeviation[] = []

  if (currentSegment) {
    pushChanged(deviations, 'segment', currentSegment.code, SEGMENT_FIELDS, snapshot, currentSegment)
  } else {
    deviations.push({
      id: 'segment-removed',
      kind: 'segment',
      status: 'removed',
      target: snapshot.startStake,
      field: '洞段',
      snapshotValue: `${snapshot.startStake} → ${snapshot.endStake}`,
      currentValue: undefined
    })
  }

  const snapshotStationMap = new Map(snapshot.stations.map((station) => [station.id, station]))
  const currentStationMap = new Map(stations.map((station) => [station.id, station]))

  snapshot.stations.forEach((snapshotStation) => {
    const currentStation = currentStationMap.get(snapshotStation.id)
    if (!currentStation) {
      deviations.push({
        id: `station-removed-${snapshotStation.id}`,
        kind: 'station',
        status: 'removed',
        target: snapshotStation.code,
        field: '测点',
        snapshotValue: '已交接',
        currentValue: '已删除'
      })
      return
    }
    pushChanged(deviations, 'station', snapshotStation.code, STATION_FIELDS, snapshotStation, currentStation)
  })

  stations.forEach((station) => {
    if (!snapshotStationMap.has(station.id)) {
      deviations.push({
        id: `station-added-${station.id}`,
        kind: 'station',
        status: 'added',
        target: station.code,
        field: '测点',
        snapshotValue: '无',
        currentValue: '新增'
      })
    }
  })

  const snapshotSketchMap = new Map(snapshot.sketchAnchors.map((sketch) => [sketch.sketchId, sketch]))
  const currentSketchMap = new Map(sketches.map((sketch) => [sketch.id, sketch]))

  snapshot.sketchAnchors.forEach((snapshotSketch) => {
    const currentSketch = currentSketchMap.get(snapshotSketch.sketchId)
    if (!currentSketch) {
      deviations.push({
        id: `sketch-removed-${snapshotSketch.sketchId}`,
        kind: 'sketch',
        status: 'removed',
        target: snapshotSketch.sketchCode,
        field: '草图',
        snapshotValue: `锚点 ${snapshotSketch.anchorStake}`,
        currentValue: '已删除'
      })
      return
    }
    const currentAnchor: HandoverSketchAnchor = {
      sketchId: currentSketch.id,
      sketchCode: currentSketch.code,
      anchorStake: currentSketch.anchorStake,
      mergeOrder: currentSketch.mergeOrder
    }
    pushChanged(deviations, 'sketch', snapshotSketch.sketchCode, SKETCH_FIELDS, snapshotSketch, currentAnchor)
  })

  sketches.forEach((sketch) => {
    if (!snapshotSketchMap.has(sketch.id)) {
      deviations.push({
        id: `sketch-added-${sketch.id}`,
        kind: 'sketch',
        status: 'added',
        target: sketch.code,
        field: '草图',
        snapshotValue: '无',
        currentValue: `锚点 ${sketch.anchorStake}`
      })
    }
  })

  return deviations
}

export function formatHandoverValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return String(value)
}

export const HANDOVER_DEVIATION_KIND_LABEL: Record<HandoverDeviationKind, string> = {
  segment: '洞段',
  station: '测点',
  sketch: '草图锚点'
}
