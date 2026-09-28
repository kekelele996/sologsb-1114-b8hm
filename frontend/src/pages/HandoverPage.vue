<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { HandoverDiff, HandoverSnapshot, Segment, Station } from '@/types'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { handoverStore } from '@/stores/handoverStore'
import { diffSnapshot, formatConfirmedAt, versionLabel } from '@/utils/handover'
import { segmentLength } from '@/types'

const route = useRoute()
const router = useRouter()
const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)
const handoverState = useStore(handoverStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const selectedSegmentId = ref<string>('')

const confirmVisible = ref(false)
const detailVisible = ref(false)
const detailSnapshot = ref<HandoverSnapshot | null>(null)

const confirmForm = reactive({
  handedBy: '',
  note: ''
})

const segmentOptions = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)
const currentSegment = computed<Segment | undefined>(() =>
  segmentState.segments.find((segment) => segment.id === selectedSegmentId.value)
)
const segmentStations = computed<Station[]>(() =>
  stationState.stations
    .filter((station) => station.segmentId === selectedSegmentId.value)
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
)
const segmentSketches = computed(() =>
  sketchState.sketches.filter((sketch) => sketch.segmentId === selectedSegmentId.value)
)
const segmentSnapshots = computed(() =>
  handoverState.snapshots
    .filter((snapshot) => snapshot.segmentId === selectedSegmentId.value)
    .sort((a, b) => b.version - a.version)
)
const latestSnapshot = computed<HandoverSnapshot | null>(() => segmentSnapshots.value[0] ?? null)
const latestVersion = computed(() => latestSnapshot.value?.version ?? 0)

/** 某条快照与当前数据的偏差（当前洞段存在时才计算） */
function diffOf(snapshot: HandoverSnapshot): HandoverDiff | null {
  const segment = segmentState.segments.find((item) => item.id === snapshot.segmentId)
  if (!segment) {
    return {
      segmentMissing: true,
      segmentChanges: [],
      stationChanges: [],
      anchorChanges: [],
      hasChanges: true,
      currentClosure: null
    }
  }
  const stations = stationState.stations.filter((station) => station.segmentId === snapshot.segmentId)
  const sketches = sketchState.sketches.filter((sketch) => sketch.segmentId === snapshot.segmentId)
  return diffSnapshot(snapshot, segment, stations, sketches)
}

const latestDiff = computed<HandoverDiff | null>(() =>
  latestSnapshot.value ? diffOf(latestSnapshot.value) : null
)

const changeCount = (diff: HandoverDiff | null): number =>
  diff
    ? diff.segmentChanges.length +
      diff.stationChanges.length +
      diff.anchorChanges.length +
      (diff.segmentMissing ? 1 : 0)
    : 0

// IndexedDB 异步水合后自动选中第一条洞穴
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

watch(
  () => [selectedCaveId.value, segmentOptions.value.length] as const,
  () => {
    const list = segmentOptions.value
    if (!list.some((segment) => segment.id === selectedSegmentId.value)) {
      selectedSegmentId.value = list[0]?.id ?? ''
    }
  },
  { immediate: true }
)

// 支持从洞段编目表带参跳入
watch(
  () => route.query.segment,
  (segmentId) => {
    if (typeof segmentId === 'string' && segmentId) {
      const target = segmentState.segments.find((segment) => segment.id === segmentId)
      if (target) {
        selectedCaveId.value = target.caveId
        selectedSegmentId.value = target.id
      }
    }
  },
  { immediate: true }
)

function openConfirm(): void {
  if (!currentSegment.value) return
  if (segmentStations.value.length === 0) {
    ElMessage.warning('该洞段还没有任何测点，不能确认交接')
    return
  }
  confirmForm.handedBy =
    caveState.caves.find((cave) => cave.id === currentSegment.value?.caveId)?.surveyor ?? ''
  confirmForm.note = ''
  confirmVisible.value = true
}

async function submitConfirm(): Promise<void> {
  if (!currentSegment.value) return
  if (!confirmForm.handedBy.trim()) {
    ElMessage.warning('请填写交班测量员')
    return
  }
  try {
    const version = await handoverStore.getState().confirm({
      segment: currentSegment.value,
      stations: segmentStations.value,
      sketches: segmentSketches.value,
      handedBy: confirmForm.handedBy,
      note: confirmForm.note
    })
    confirmVisible.value = false
    ElMessage.success(`已保存交接快照 ${versionLabel(version)}，洞段已交下一班`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '确认交接失败')
  }
}

function openDetail(snapshot: HandoverSnapshot): void {
  detailSnapshot.value = snapshot
  detailVisible.value = true
}

const detailDiff = computed<HandoverDiff | null>(() =>
  detailSnapshot.value ? diffOf(detailSnapshot.value) : null
)

async function restoreSnapshot(snapshot: HandoverSnapshot): Promise<void> {
  const diff = diffOf(snapshot)
  const count = changeCount(diff)
  const message =
    count === 0
      ? `当前数据与快照 ${versionLabel(snapshot.version)} 一致，仍要重新套用该快照吗？`
      : `将按快照 ${versionLabel(
          snapshot.version
        )} 还原洞段起止桩号、类型、闭合标记、草图锚点与全部测点，当前的 ${count} 处偏差会被覆盖。确认恢复？`
  await ElMessageBox.confirm(message, '恢复交接快照', {
    type: 'warning',
    confirmButtonText: '恢复快照',
    cancelButtonText: '取消'
  })
  try {
    await handoverStore.getState().restore(snapshot.id)
    // 恢复后重新水合相关 store，闭合差与拼合视图随恢复结果重算
    await Promise.all([
      segmentStore.getState().hydrate(),
      stationStore.getState().hydrate(),
      sketchStore.getState().hydrate()
    ])
    detailVisible.value = false
    detailSnapshot.value = null
    ElMessage.success(`已恢复到 ${versionLabel(snapshot.version)}，闭合差与拼合视图已重算`)
  } catch (error) {
    if (error === 'cancel' || (error as { message?: string })?.message?.includes('cancel')) return
    ElMessage.error(error instanceof Error ? error.message : '恢复快照失败')
  }
}

async function removeSnapshot(snapshot: HandoverSnapshot): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除交接快照 ${versionLabel(snapshot.version)}？删除后无法据此恢复。`,
    '删除快照',
    { type: 'warning' }
  )
  await handoverStore.getState().remove(snapshot.id)
  if (detailSnapshot.value?.id === snapshot.id) {
    detailSnapshot.value = null
    detailVisible.value = false
  }
  ElMessage.success('交接快照已删除')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">洞段交接快照</h2>
        <p class="page-sub">
          确认交接时固化起止桩号、类型、闭合标记、草图锚点与全部测点，并保存当时的闭合结果作为交接版本；交后若读数被改动会逐条列出偏差，测量员可恢复快照，闭合差与拼合视图随之重算。
        </p>
      </div>
      <el-button type="primary" :disabled="!currentSegment" @click="openConfirm">
        <el-icon><Promotion /></el-icon>确认交接
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 200px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-select v-model="selectedSegmentId" placeholder="选择洞段" style="width: 240px">
        <el-option
          v-for="segment in segmentOptions"
          :key="segment.id"
          :label="`${segment.code}（${segment.startStake} → ${segment.endStake}）`"
          :value="segment.id"
        />
      </el-select>
      <template v-if="currentSegment">
        <SegmentTag :type="currentSegment.type" :closed="currentSegment.closed" size="small" />
        <el-tag effect="plain">桩号长度 {{ segmentLength(currentSegment) }} m</el-tag>
        <el-tag effect="plain">当前测点 {{ segmentStations.length }} 个</el-tag>
        <el-tag :type="latestVersion > 0 ? 'success' : 'info'" effect="plain">
          交接版本 {{ latestVersion > 0 ? versionLabel(latestVersion) : '未交接' }}
        </el-tag>
      </template>
    </div>

    <el-alert
      v-if="currentSegment && segmentStations.length === 0"
      class="alert"
      type="warning"
      :closable="false"
      show-icon
      title="该洞段还没有测点，不能确认交接"
      description="请先到「测点读数」为本洞段录入至少一个测点，再进行交接确认。"
    >
      <el-button type="primary" size="small" @click="router.push('/stations')">前往测点读数</el-button>
    </el-alert>

    <template v-if="currentSegment">
      <!-- 当前版本 + 最新偏差概览 -->
      <el-card v-if="latestSnapshot && latestDiff" shadow="never" class="overview">
        <div class="overview-head">
          <div>
            <div class="overview-title">
              最新交接版本 {{ versionLabel(latestSnapshot.version) }}
              <el-tag :type="latestDiff.hasChanges ? 'danger' : 'success'" size="small" effect="plain">
                {{ latestDiff.hasChanges ? `检出 ${changeCount(latestDiff)} 处偏差` : '与当前数据一致' }}
              </el-tag>
            </div>
            <div class="muted">
              {{ formatConfirmedAt(latestSnapshot.confirmedAt) }} · 交班 {{ latestSnapshot.handedBy || '未署名' }}
            </div>
          </div>
          <el-button type="primary" plain size="small" @click="openDetail(latestSnapshot)">查看 / 恢复</el-button>
        </div>
        <div class="closure-grid">
          <div class="closure-cell">
            <div class="cell-label">确认时闭合结果</div>
            <ClosureBadge
              :closure="latestSnapshot.closure.closure"
              :threshold="latestSnapshot.closure.threshold"
              :level="latestSnapshot.closure.level"
              :detail="latestSnapshot.closure.detail"
              :count="latestSnapshot.closure.count"
            />
          </div>
          <div class="closure-cell">
            <div class="cell-label">当前数据重算</div>
            <ClosureBadge
              v-if="latestDiff.currentClosure"
              :closure="latestDiff.currentClosure.closure"
              :threshold="latestDiff.currentClosure.threshold"
              :level="latestDiff.currentClosure.level"
              :detail="latestDiff.currentClosure.detail"
              :count="latestDiff.currentClosure.count"
            />
            <el-text v-else type="info" size="small">洞段已删除，无法重算</el-text>
          </div>
        </div>
      </el-card>

      <h3 class="section-title">交接版本记录（{{ segmentSnapshots.length }}）</h3>
      <el-table :data="segmentSnapshots" border stripe>
        <el-table-column label="版本" width="90">
          <template #default="{ row }: { row: HandoverSnapshot }">
            <span class="mono version-cell">{{ versionLabel(row.version) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="确认时间" width="170">
          <template #default="{ row }: { row: HandoverSnapshot }">{{ formatConfirmedAt(row.confirmedAt) }}</template>
        </el-table-column>
        <el-table-column prop="handedBy" label="交班测量员" width="110">
          <template #default="{ row }: { row: HandoverSnapshot }">{{ row.handedBy || '—' }}</template>
        </el-table-column>
        <el-table-column label="固化测点" width="100">
          <template #default="{ row }: { row: HandoverSnapshot }">{{ row.stations.length }} 个</template>
        </el-table-column>
        <el-table-column label="确认时闭合差" width="160">
          <template #default="{ row }: { row: HandoverSnapshot }">
            <el-tag
              :type="row.closure.over ? 'danger' : row.closure.level === '良' ? 'warning' : 'success'"
              size="small"
              effect="plain"
            >
              {{ row.closure.closure.toFixed(3) }} m · {{ row.closure.level }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型 / 闭合" width="150">
          <template #default="{ row }: { row: HandoverSnapshot }">
            {{ row.type }} · {{ row.closed ? '已闭合' : '未闭合' }}
          </template>
        </el-table-column>
        <el-table-column label="当前偏差" min-width="140">
          <template #default="{ row }: { row: HandoverSnapshot }">
            <el-tag v-if="diffOf(row)?.segmentMissing" type="info" size="small">洞段已删除</el-tag>
            <el-tag v-else-if="changeCount(diffOf(row)) > 0" type="danger" size="small">
              {{ changeCount(diffOf(row)) }} 处改动
            </el-tag>
            <el-tag v-else type="success" size="small" effect="plain">一致</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="交接备注" min-width="160" show-overflow-tooltip>
          <template #default="{ row }: { row: HandoverSnapshot }">{{ row.note || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }: { row: HandoverSnapshot }">
            <el-button link type="primary" size="small" @click="openDetail(row)">查看偏差</el-button>
            <el-button link type="danger" size="small" @click="removeSnapshot(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <el-empty v-else description="请选择一个洞段查看交接情况" />

    <!-- 确认交接对话框 -->
    <el-dialog v-model="confirmVisible" title="确认洞段交接" width="520px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="confirm-alert"
        :title="`将为「${currentSegment?.code ?? ''}」保存交接版本 ${versionLabel(latestVersion + 1)}`"
        description="快照会固化当前起止桩号、类型、闭合标记、草图锚点与全部测点读数及闭合结果，交下一班后作为核对凭证。"
      />
      <el-form label-width="100px" class="confirm-form">
        <el-form-item label="交班测量员" required>
          <el-input v-model="confirmForm.handedBy" placeholder="如 陆昀" />
        </el-form-item>
        <el-form-item label="交接备注">
          <el-input
            v-model="confirmForm.note"
            type="textarea"
            :rows="3"
            placeholder="本班进度、遗留问题、下一班注意事项"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button type="primary" @click="submitConfirm">确认并保存快照</el-button>
      </template>
    </el-dialog>

    <!-- 快照详情 / 偏差 / 恢复 -->
    <el-dialog
      v-model="detailVisible"
      :title="detailSnapshot ? `交接快照 ${versionLabel(detailSnapshot.version)} · ${detailSnapshot.segmentCode}` : ''"
      width="900px"
      top="6vh"
      @closed="detailSnapshot = null"
    >
      <template v-if="detailSnapshot">
        <el-descriptions :column="3" border size="small" class="detail-desc">
          <el-descriptions-item label="起始桩号">{{ detailSnapshot.startStake }}</el-descriptions-item>
          <el-descriptions-item label="结束桩号">{{ detailSnapshot.endStake }}</el-descriptions-item>
          <el-descriptions-item label="洞段类型">{{ detailSnapshot.type }}</el-descriptions-item>
          <el-descriptions-item label="闭合标记">
            {{ detailSnapshot.closed ? '已闭合' : '未闭合' }}
          </el-descriptions-item>
          <el-descriptions-item label="交班测量员">{{ detailSnapshot.handedBy || '—' }}</el-descriptions-item>
          <el-descriptions-item label="确认时间">
            {{ formatConfirmedAt(detailSnapshot.confirmedAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="草图锚点" :span="3">
            <span v-if="detailSnapshot.sketchAnchors.length === 0" class="muted">无草图锚点</span>
            <el-tag
              v-for="anchor in detailSnapshot.sketchAnchors"
              :key="anchor.sketchId"
              size="small"
              effect="plain"
              class="anchor-tag"
            >
              {{ anchor.sketchCode }}：{{ anchor.anchorStake || '未设锚点' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="交接备注" :span="3">{{ detailSnapshot.note || '—' }}</el-descriptions-item>
        </el-descriptions>

        <div class="detail-closure">
          <ClosureBadge
            :closure="detailSnapshot.closure.closure"
            :threshold="detailSnapshot.closure.threshold"
            :level="detailSnapshot.closure.level"
            :detail="detailSnapshot.closure.detail"
            :count="detailSnapshot.closure.count"
          />
        </div>

        <!-- 偏差列表 -->
        <div class="diff-head">
          <h4 class="block-title">交后改动偏差</h4>
          <el-tag v-if="detailDiff?.segmentMissing" type="info" size="small">对应洞段已被删除</el-tag>
          <el-tag v-else-if="detailDiff && changeCount(detailDiff) === 0" type="success" size="small" effect="plain">
            无改动，数据与快照一致
          </el-tag>
          <el-tag v-else type="danger" size="small">检出 {{ detailDiff ? changeCount(detailDiff) : 0 }} 处偏差</el-tag>
        </div>

        <template v-if="detailDiff && !detailDiff.segmentMissing">
          <div v-if="detailDiff.segmentChanges.length > 0" class="diff-block">
            <div class="diff-block-title">洞段字段（{{ detailDiff.segmentChanges.length }}）</div>
            <el-table :data="detailDiff.segmentChanges" border size="small">
              <el-table-column prop="label" label="字段" width="110" />
              <el-table-column label="快照值" min-width="140">
                <template #default="{ row }">{{ row.snapshotValue || '—' }}</template>
              </el-table-column>
              <el-table-column width="60" align="center">
                <template #default><el-icon><Right /></el-icon></template>
              </el-table-column>
              <el-table-column label="当前值" min-width="140">
                <template #default="{ row }">
                  <span class="changed">{{ row.currentValue || '—' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div v-if="detailDiff.stationChanges.length > 0" class="diff-block">
            <div class="diff-block-title">测点读数（{{ detailDiff.stationChanges.length }}）</div>
            <el-table :data="detailDiff.stationChanges" border size="small" max-height="260">
              <el-table-column label="测点" width="100">
                <template #default="{ row }">{{ row.code }}</template>
              </el-table-column>
              <el-table-column label="改动" width="90">
                <template #default="{ row }">
                  <el-tag
                    :type="row.kind === 'added' ? 'success' : row.kind === 'removed' ? 'info' : 'warning'"
                    size="small"
                  >
                    {{ row.kind === 'added' ? '新增' : row.kind === 'removed' ? '删除' : '修改' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="字段偏差" min-width="320">
                <template #default="{ row }">
                  <span v-if="row.changes.length === 0" class="muted">—</span>
                  <div v-for="change in row.changes" :key="change.field" class="change-line">
                    <b>{{ change.label }}</b>：{{ change.snapshotValue || '—' }}
                    <el-icon class="arrow"><Right /></el-icon>
                    <span class="changed">{{ change.currentValue || '—' }}</span>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div v-if="detailDiff.anchorChanges.length > 0" class="diff-block">
            <div class="diff-block-title">草图锚点（{{ detailDiff.anchorChanges.length }}）</div>
            <el-table :data="detailDiff.anchorChanges" border size="small">
              <el-table-column label="草图" width="110">
                <template #default="{ row }">{{ row.sketchCode }}</template>
              </el-table-column>
              <el-table-column label="改动" width="90">
                <template #default="{ row }">
                  <el-tag
                    :type="row.kind === 'added' ? 'success' : row.kind === 'removed' ? 'info' : 'warning'"
                    size="small"
                  >
                    {{ row.kind === 'added' ? '新增' : row.kind === 'removed' ? '删除' : '修改' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="锚点桩号" min-width="240">
                <template #default="{ row }">
                  <template v-if="row.changes.length > 0">
                    <span v-for="change in row.changes" :key="change.field">
                      {{ change.snapshotValue || '空' }} <el-icon><Right /></el-icon>
                      <span class="changed">{{ change.currentValue || '空' }}</span>
                    </span>
                  </template>
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>

        <!-- 快照固化的全部测点 -->
        <div class="diff-head">
          <h4 class="block-title">快照测点清单（{{ detailSnapshot.stations.length }}）</h4>
        </div>
        <el-table :data="detailSnapshot.stations" border size="small" max-height="240">
          <el-table-column prop="code" label="桩号" width="80" />
          <el-table-column label="方位角" width="110">
            <template #default="{ row }: { row: Station }">{{ row.bearing }}°</template>
          </el-table-column>
          <el-table-column label="倾角" width="80">
            <template #default="{ row }: { row: Station }">{{ row.dip }}°</template>
          </el-table-column>
          <el-table-column prop="slopeDistance" label="斜距(m)" width="90" />
          <el-table-column prop="horizontalDistance" label="水平距(m)" width="100" />
          <el-table-column prop="verticalDistance" label="垂距(m)" width="90" />
          <el-table-column prop="surveyor" label="测量人" width="90" />
          <el-table-column prop="date" label="日期" width="110" />
          <el-table-column label="闭合点" width="80">
            <template #default="{ row }: { row: Station }">
              <el-tag v-if="row.isClosurePoint" type="success" size="small" effect="plain">是</el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :disabled="!detailSnapshot || detailDiff?.segmentMissing"
          @click="detailSnapshot && restoreSnapshot(detailSnapshot)"
        >
          恢复此快照并重算
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alert {
  margin-bottom: 16px;
}
.overview {
  border-radius: 12px;
  margin-bottom: 18px;
}
.overview-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}
.overview-title {
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.closure-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.cell-label {
  font-size: 12px;
  color: #6b7b8c;
  margin-bottom: 6px;
}
.version-cell {
  font-weight: 600;
  color: #2f6f8f;
}
.confirm-alert {
  margin-bottom: 14px;
}
.confirm-form {
  margin-top: 4px;
}
.detail-desc {
  margin-bottom: 12px;
}
.anchor-tag {
  margin: 2px 6px 2px 0;
}
.detail-closure {
  margin-bottom: 14px;
}
.diff-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 8px;
}
.block-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.diff-block {
  margin-bottom: 12px;
}
.diff-block-title {
  font-size: 12px;
  color: #4a5b6b;
  margin-bottom: 6px;
}
.change-line {
  font-size: 12px;
  line-height: 1.9;
  color: #4a5b6b;
}
.change-line .arrow {
  vertical-align: -2px;
  margin: 0 2px;
}
.changed {
  color: #c0392b;
  font-weight: 600;
}
</style>
