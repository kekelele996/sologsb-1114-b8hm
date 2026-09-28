<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { HandoverDeviation, HandoverSnapshot, Segment, SegmentType, Sketch, Station } from '@/types'
import { SEGMENT_TYPES, segmentLength } from '@/types'
import SegmentTag from '@/components/common/SegmentTag.vue'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { EmptyStationError, handoverStore } from '@/stores/handoverStore'
import { stakeRangeOverlap, stakeToNumber } from '@/utils/survey'
import { diffHandoverSnapshot, formatHandoverValue, HANDOVER_DEVIATION_KIND_LABEL } from '@/utils/handover'
import { uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)
const handoverState = useStore(handoverStore)

const filterCaveId = ref<string>('')
const filterType = ref<SegmentType | ''>('')
const rangeStart = ref<number | undefined>(undefined)
const rangeEnd = ref<number | undefined>(undefined)
const selectedIds = ref<string[]>([])
const batchType = ref<SegmentType>('廊道')

const dialogVisible = ref(false)
const handoverDialogVisible = ref(false)
const editingId = ref<string | null>(null)
const handoverSegmentId = ref('')
const handoverSurveyor = ref('')
const confirming = ref(false)
const restoring = ref(false)

const form = reactive({
  caveId: '',
  code: '',
  startStake: 'K0+000',
  endStake: 'K0+050',
  type: '廊道' as SegmentType,
  avgWidth: 1.5,
  avgHeight: 2,
  slopeTrend: '',
  closed: false,
  sketchNo: ''
})

const filtered = computed(() =>
  segmentState.segments.filter((segment) => {
    if (filterCaveId.value && segment.caveId !== filterCaveId.value) return false
    if (filterType.value && segment.type !== filterType.value) return false
    if (rangeStart.value !== undefined || rangeEnd.value !== undefined) {
      const lo = rangeStart.value ?? Number.NEGATIVE_INFINITY
      const hi = rangeEnd.value ?? Number.POSITIVE_INFINITY
      if (!stakeRangeOverlap(stakeToNumber(segment.startStake), stakeToNumber(segment.endStake), lo, hi)) return false
    }
    return true
  })
)

const totalLength = computed(() =>
  Math.round(filtered.value.reduce((sum, segment) => sum + segmentLength(segment), 0) * 10) / 10
)

const snapshotsForSegment = computed(() =>
  handoverState.snapshots
    .filter((snapshot) => snapshot.segmentId === handoverSegmentId.value)
    .sort((a, b) => b.version - a.version)
)
const latestSnapshot = computed<HandoverSnapshot | undefined>(() => snapshotsForSegment.value[0])

const handoverSegment = computed<Segment | undefined>(() =>
  segmentState.segments.find((segment) => segment.id === handoverSegmentId.value)
)

const handoverStations = computed<Station[]>(() =>
  stationState.stations
    .filter((station) => station.segmentId === handoverSegmentId.value)
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
)

const handoverSketches = computed<Sketch[]>(() =>
  sketchState.sketches
    .filter((sketch) => sketch.segmentId === handoverSegmentId.value)
    .sort((a, b) => a.mergeOrder - b.mergeOrder)
)

const handoverClosureInput = computed(() => handoverStations.value)
const { result: handoverClosure } = useClosureCheck(handoverClosureInput)

const handoverDeviations = computed<HandoverDeviation[]>(() => {
  const snapshot = latestSnapshot.value
  if (!snapshot || !handoverSegment.value) return []
  return diffHandoverSnapshot(snapshot, handoverSegment.value, handoverStations.value, handoverSketches.value)
})
const hasDeviation = computed(() => handoverDeviations.value.length > 0)

const segmentLatestSnapshot = (segmentId: string): HandoverSnapshot | undefined =>
  handoverState.snapshots
    .filter((snapshot) => snapshot.segmentId === segmentId)
    .sort((a, b) => b.version - a.version)[0]

function diffCurrentSnapshot(segment: Segment): HandoverDeviation[] {
  const snapshot = segmentLatestSnapshot(segment.id)
  if (!snapshot) return []
  return diffHandoverSnapshot(
    snapshot,
    segment,
    stationState.stations.filter((station) => station.segmentId === segment.id),
    sketchState.sketches.filter((sketch) => sketch.segmentId === segment.id)
  )
}

function caveName(caveId: string): string {
  return caveState.caves.find((cave) => cave.id === caveId)?.name ?? '未归属洞穴'
}

function stationCount(segmentId: string): number {
  return stationState.stations.filter((station) => station.segmentId === segmentId).length
}

function resetForm(): void {
  editingId.value = null
  form.caveId = caveState.caves[0]?.id ?? ''
  form.code = `C-${String(segmentState.segments.length + 1).padStart(2, '0')}`
  form.startStake = 'K0+000'
  form.endStake = 'K0+050'
  form.type = '廊道'
  form.avgWidth = 1.5
  form.avgHeight = 2
  form.slopeTrend = ''
  form.closed = false
  form.sketchNo = ''
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(segment: Segment): void {
  editingId.value = segment.id
  form.caveId = segment.caveId
  form.code = segment.code
  form.startStake = segment.startStake
  form.endStake = segment.endStake
  form.type = segment.type
  form.avgWidth = segment.avgWidth
  form.avgHeight = segment.avgHeight
  form.slopeTrend = segment.slopeTrend
  form.closed = segment.closed
  form.sketchNo = segment.sketchNo
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!form.caveId) {
    ElMessage.warning('请选择归属洞穴')
    return
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写洞段编号')
    return
  }
  if (stakeToNumber(form.endStake) <= stakeToNumber(form.startStake)) {
    ElMessage.warning('结束桩号必须大于起始桩号')
    return
  }
  const existing = segmentState.segments.find((item) => item.id === editingId.value)
  const segment: Segment = {
    id: existing?.id ?? uid('seg'),
    caveId: form.caveId,
    code: form.code.trim(),
    startStake: form.startStake.trim(),
    endStake: form.endStake.trim(),
    type: form.type,
    avgWidth: Number(form.avgWidth) || 0,
    avgHeight: Number(form.avgHeight) || 0,
    slopeTrend: form.slopeTrend.trim(),
    closed: form.closed,
    sketchNo: form.sketchNo.trim()
  }
  await segmentStore.getState().save(segment)
  dialogVisible.value = false
  ElMessage.success(existing ? '洞段已更新' : '洞段已建立')
}

async function applyBatchType(): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要调整的洞段')
    return
  }
  await segmentStore.getState().bulkSetType(selectedIds.value, batchType.value)
  ElMessage.success(`已把 ${selectedIds.value.length} 个洞段调整为「${batchType.value}」`)
}

async function applyBatchClosed(closed: boolean): Promise<void> {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要调整的洞段')
    return
  }
  await segmentStore.getState().bulkSetClosed(selectedIds.value, closed)
  ElMessage.success(closed ? '已标记为闭合' : '已取消闭合标记')
}

function formatSnapshotTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function openHandover(segment: Segment): void {
  handoverSegmentId.value = segment.id
  handoverSurveyor.value = segmentLatestSnapshot(segment.id)?.confirmedBy
    ?? caveState.caves.find((cave) => cave.id === segment.caveId)?.surveyor
    ?? ''
  handoverDialogVisible.value = true
}

async function confirmHandover(): Promise<void> {
  const segment = handoverSegment.value
  if (!segment) return
  if (!handoverSurveyor.value.trim()) {
    ElMessage.warning('请填写交接确认测量员')
    return
  }
  confirming.value = true
  try {
    const snapshot = await handoverStore.getState().confirm(segment.id, handoverSurveyor.value)
    ElMessage.success(`交接快照 v${snapshot.version} 已保存`)
  } catch (error) {
    if (error instanceof EmptyStationError) {
      ElMessage.error(error.message)
    } else {
      ElMessage.error(error instanceof Error ? error.message : '交接快照保存失败')
    }
  } finally {
    confirming.value = false
  }
}

async function restoreSnapshot(snapshot: HandoverSnapshot): Promise<void> {
  await ElMessageBox.confirm(
    `确认恢复交接快照 v${snapshot.version}？当前洞段字段、全部测点和草图锚点会回到确认时状态，新增记录将被移除；闭合差与拼合视图随后自动重算。`,
    '恢复交接快照',
    { type: 'warning' }
  )
  restoring.value = true
  try {
    const restored = await handoverStore.getState().restore(snapshot.id, handoverSurveyor.value)
    await Promise.all([
      segmentStore.getState().hydrate(),
      stationStore.getState().hydrate(),
      sketchStore.getState().hydrate()
    ])
    ElMessage.success(restored ? `已恢复并另存为交接快照 v${restored.version}` : `已恢复到交接快照 v${snapshot.version}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复交接快照失败')
  } finally {
    restoring.value = false
  }
}

function deviationStatusLabel(status: HandoverDeviation['status']): string {
  return status === 'changed' ? '已修改' : status === 'added' ? '已新增' : '已删除'
}

function deviationStatusType(status: HandoverDeviation['status']): 'warning' | 'success' | 'danger' {
  return status === 'changed' ? 'warning' : status === 'added' ? 'success' : 'danger'
}

function anchorText(snapshot: HandoverSnapshot): string {
  return snapshot.sketchAnchors.length > 0
    ? snapshot.sketchAnchors.map((anchor) => `${anchor.sketchCode}:${anchor.anchorStake}`).join(' / ')
    : '无草图锚点'
}

async function removeSegment(segment: Segment): Promise<void> {
  const count = stationCount(segment.id)
  if (count > 0) {
    ElMessage.error(`洞段「${segment.code}」下仍有 ${count} 个测点，请先清理`)
    return
  }
  await ElMessageBox.confirm(`确认删除洞段「${segment.code}」？`, '删除确认', { type: 'warning' })
  await segmentStore.getState().remove(segment.id)
  ElMessage.success('洞段已删除')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">洞段编目表</h2>
        <p class="page-sub">
          按桩号区间筛选洞段、批量调整洞段类型；洞段长度由起止桩号自动计算，并累计为洞穴实测总长。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建洞段
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="filterCaveId" placeholder="全部洞穴" clearable style="width: 200px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-select v-model="filterType" placeholder="全部类型" clearable style="width: 140px">
        <el-option v-for="type in SEGMENT_TYPES" :key="type" :label="type" :value="type" />
      </el-select>
      <div class="range">
        <span class="muted">桩号区间筛选（米）</span>
        <el-input-number v-model="rangeStart" :min="0" :controls="false" placeholder="起" style="width: 110px" />
        <span>—</span>
        <el-input-number v-model="rangeEnd" :min="0" :controls="false" placeholder="止" style="width: 110px" />
      </div>
      <el-select v-model="batchType" style="width: 140px">
        <el-option v-for="type in SEGMENT_TYPES" :key="type" :label="type" :value="type" />
      </el-select>
      <el-button type="primary" plain @click="applyBatchType">批量调整类型</el-button>
      <el-button @click="applyBatchClosed(true)">标记闭合</el-button>
      <el-button @click="applyBatchClosed(false)">取消闭合</el-button>
      <el-tag type="info" effect="plain">命中共 {{ filtered.length }} 段 · 合计 {{ totalLength }} m</el-tag>
    </div>

    <el-table
      :data="filtered"
      border
      stripe
      row-key="id"
      @selection-change="(rows: Segment[]) => (selectedIds = rows.map((row) => row.id))"
    >
      <el-table-column type="selection" width="46" />
      <el-table-column label="洞段" width="120">
        <template #default="{ row }: { row: Segment }">
          <span class="mono">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column label="归属洞穴" min-width="150">
        <template #default="{ row }: { row: Segment }">{{ caveName(row.caveId) }}</template>
      </el-table-column>
      <el-table-column label="类型" width="170">
        <template #default="{ row }: { row: Segment }">
          <SegmentTag :type="row.type" :closed="row.closed" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="桩号区间" min-width="200">
        <template #default="{ row }: { row: Segment }">
          <span class="mono">{{ row.startStake }} → {{ row.endStake }}</span>
          <div class="muted">长度 {{ segmentLength(row) }} m</div>
        </template>
      </el-table-column>
      <el-table-column label="平均宽×高(m)" width="140">
        <template #default="{ row }: { row: Segment }">{{ row.avgWidth }} × {{ row.avgHeight }}</template>
      </el-table-column>
      <el-table-column prop="slopeTrend" label="坡度趋势" width="120" />
      <el-table-column label="测点数" width="90">
        <template #default="{ row }: { row: Segment }">{{ stationCount(row.id) }}</template>
      </el-table-column>
      <el-table-column prop="sketchNo" label="草图序号" width="100" />
      <el-table-column label="交接版本" width="150">
        <template #default="{ row }: { row: Segment }">
          <template v-if="segmentLatestSnapshot(row.id)">
            <el-tag type="success" size="small" effect="dark">
              v{{ segmentLatestSnapshot(row.id)?.version }}
            </el-tag>
            <el-tag
              v-if="diffCurrentSnapshot(row).length > 0"
              type="warning"
              size="small"
              effect="plain"
              class="deviation-tag"
            >
              {{ diffCurrentSnapshot(row).length }} 项偏差
            </el-tag>
          </template>
          <el-tooltip v-else :content="stationCount(row.id) > 0 ? '尚未确认交接' : '没有测点的洞段不能确认'" placement="top">
            <el-tag :type="stationCount(row.id) > 0 ? 'info' : 'danger'" size="small" effect="plain">未交接</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="230" fixed="right">
        <template #default="{ row }: { row: Segment }">
          <el-button link type="primary" size="small" @click="openHandover(row)">交接快照</el-button>
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="removeSegment(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑洞段' : '新建洞段'" width="620px">
      <el-form label-width="110px">
        <el-form-item label="归属洞穴" required>
          <el-select v-model="form.caveId" style="width: 100%">
            <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="洞段编号" required>
              <el-input v-model="form.code" placeholder="如 C-03" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="洞段类型">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="type in SEGMENT_TYPES" :key="type" :label="type" :value="type" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="起始桩号">
              <el-input v-model="form.startStake" placeholder="K0+000" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="结束桩号">
              <el-input v-model="form.endStake" placeholder="K0+050" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="平均宽(m)">
              <el-input-number v-model="form.avgWidth" :min="0" :step="0.1" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="平均高(m)">
              <el-input-number v-model="form.avgHeight" :min="0" :step="0.1" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="坡度趋势">
          <el-input v-model="form.slopeTrend" placeholder="如 缓升 3°" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="草图序号">
              <el-input v-model="form.sketchNo" placeholder="如 S-03" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="是否已闭合">
              <el-switch v-model="form.closed" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="handoverDialogVisible"
      :title="handoverSegment ? `洞段交接 · ${handoverSegment.code}` : '洞段交接'"
      width="980px"
      top="6vh"
    >
      <el-alert
        v-if="handoverStations.length === 0"
        type="error"
        :closable="false"
        show-icon
        title="没有测点的洞段不能确认交接"
        description="请先到「测点读数」录入至少一条测点，再保存交接快照。"
        class="handover-alert"
      />
      <el-alert
        v-else-if="latestSnapshot && hasDeviation"
        type="warning"
        :closable="false"
        show-icon
        :title="`当前数据相对 v${latestSnapshot.version} 有 ${handoverDeviations.length} 项偏差`"
        description="测量员可查看下表并恢复快照；恢复后闭合差和图幅拼合视图会基于快照测点与锚点重算。"
        class="handover-alert"
      />

      <div v-if="handoverSegment" class="handover-head">
        <el-descriptions :column="4" border size="small">
          <el-descriptions-item label="洞段">{{ handoverSegment.code }}</el-descriptions-item>
          <el-descriptions-item label="桩号">{{ handoverSegment.startStake }} → {{ handoverSegment.endStake }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ handoverSegment.type }}</el-descriptions-item>
          <el-descriptions-item label="闭合标记">{{ handoverSegment.closed ? '已闭合' : '未闭合' }}</el-descriptions-item>
          <el-descriptions-item label="测点">{{ handoverStations.length }} 个</el-descriptions-item>
          <el-descriptions-item label="草图锚点">{{ handoverSketches.length }} 个</el-descriptions-item>
          <el-descriptions-item label="当前交接版本" :span="2">
            {{ latestSnapshot ? `v${latestSnapshot.version} · ${formatSnapshotTime(latestSnapshot.confirmedAt)} · ${latestSnapshot.confirmedBy || '未记录测量员'}` : '尚无快照' }}
          </el-descriptions-item>
        </el-descriptions>
        <ClosureBadge
          class="handover-closure"
          :closure="handoverClosure.closure"
          :threshold="handoverClosure.threshold"
          :level="handoverClosure.level"
          :detail="handoverClosure.detail"
          :count="handoverStations.length"
        />
      </div>

      <el-form label-width="104px" class="confirm-form">
        <el-form-item label="确认测量员" required>
          <el-input v-model="handoverSurveyor" placeholder="交给下一班的确认测量员" style="width: 260px" />
          <el-button
            type="primary"
            :disabled="handoverStations.length === 0 || confirming"
            :loading="confirming"
            @click="confirmHandover"
          >
            确认并保存快照
          </el-button>
          <span class="muted">保存起止桩号、类型、闭合标记、草图锚点和全部测点</span>
        </el-form-item>
      </el-form>

      <el-table v-if="latestSnapshot" :data="handoverDeviations" border stripe size="small" max-height="220" empty-text="当前数据与最新交接快照一致">
        <el-table-column label="类别" width="90">
          <template #default="{ row }: { row: HandoverDeviation }">
            {{ HANDOVER_DEVIATION_KIND_LABEL[row.kind] }}
          </template>
        </el-table-column>
        <el-table-column prop="target" label="对象" width="110" />
        <el-table-column prop="field" label="字段" width="120" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }: { row: HandoverDeviation }">
            <el-tag :type="deviationStatusType(row.status)" size="small">{{ deviationStatusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="快照值" min-width="150">
          <template #default="{ row }: { row: HandoverDeviation }">{{ formatHandoverValue(row.snapshotValue) }}</template>
        </el-table-column>
        <el-table-column label="当前值" min-width="150">
          <template #default="{ row }: { row: HandoverDeviation }">{{ formatHandoverValue(row.currentValue) }}</template>
        </el-table-column>
      </el-table>

      <template v-if="latestSnapshot">
        <h4 class="history-title">v{{ latestSnapshot.version }} 冻结的全部测点</h4>
        <el-table :data="latestSnapshot.stations" border stripe size="small" max-height="220">
          <el-table-column prop="code" label="桩号" width="80" />
          <el-table-column label="方位角" width="110">
            <template #default="{ row }: { row: Station }">{{ row.bearing }}°</template>
          </el-table-column>
          <el-table-column label="倾角" width="90">
            <template #default="{ row }: { row: Station }">{{ row.dip }}°</template>
          </el-table-column>
          <el-table-column prop="slopeDistance" label="斜距" width="80" />
          <el-table-column prop="horizontalDistance" label="水平距" width="90" />
          <el-table-column prop="verticalDistance" label="垂距" width="80" />
          <el-table-column prop="surveyor" label="测量人" width="90" />
          <el-table-column label="闭合点" width="80">
            <template #default="{ row }: { row: Station }">
              <el-tag v-if="row.isClosurePoint" type="success" size="small">是</el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>

        <h4 class="history-title">v{{ latestSnapshot.version }} 冻结的草图锚点</h4>
        <el-table :data="latestSnapshot.sketchAnchors" border stripe size="small" empty-text="确认时暂无草图锚点">
          <el-table-column prop="sketchCode" label="草图" width="130" />
          <el-table-column prop="anchorStake" label="锚点桩号" width="180" />
          <el-table-column prop="mergeOrder" label="拼合顺序" width="120" />
        </el-table>
      </template>

      <h4 class="history-title">交接版本历史</h4>
      <el-timeline v-if="snapshotsForSegment.length > 0">
        <el-timeline-item
          v-for="snapshot in snapshotsForSegment"
          :key="snapshot.id"
          :type="snapshot.id === latestSnapshot?.id ? 'success' : 'info'"
          :timestamp="`v${snapshot.version} · ${formatSnapshotTime(snapshot.confirmedAt)} · ${snapshot.confirmedBy || '未记录测量员'}`"
        >
          <div class="history-card">
            <div>
              <el-tag size="small" effect="plain">{{ snapshot.type }}</el-tag>
              <el-tag size="small" :type="snapshot.closed ? 'success' : 'info'" effect="plain">
                {{ snapshot.closed ? '已闭合' : '未闭合' }}
              </el-tag>
              <span class="mono snapshot-stake">{{ snapshot.startStake }} → {{ snapshot.endStake }}</span>
            </div>
            <div class="muted">测点 {{ snapshot.stations.length }} 个 · {{ anchorText(snapshot) }}</div>
            <div v-if="snapshot.restoredFromVersion" class="muted">
              由 v{{ snapshot.restoredFromVersion }} 恢复后另存{{ snapshot.restoredBy ? ` · 操作人 ${snapshot.restoredBy}` : '' }}
            </div>
            <el-button
              type="warning"
              plain
              size="small"
              :disabled="restoring"
              :loading="restoring && snapshot.id === latestSnapshot?.id"
              @click="restoreSnapshot(snapshot)"
            >
              恢复此版本
            </el-button>
          </div>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-else description="尚未确认交接，保存第一版快照后在此显示" :image-size="70" />
    </el-dialog>
  </div>
</template>

<style scoped>
.range {
  display: flex;
  align-items: center;
  gap: 6px;
}
.deviation-tag {
  margin-left: 4px;
}
.handover-alert {
  margin-bottom: 14px;
}
.handover-head {
  margin-bottom: 14px;
}
.handover-closure {
  margin-top: 10px;
}
.confirm-form {
  margin-top: 14px;
}
.history-title {
  margin: 18px 0 12px;
}
.history-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid #e2e9f0;
  border-radius: 8px;
  background: #fbfdfe;
}
.snapshot-stake {
  margin-left: 8px;
}
</style>
