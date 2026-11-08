import { create } from 'zustand'
import { back, pushLevel, rerunLevel, settleLevel, type Outcome } from './features/projection/breadcrumb'

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'error'
/** Tabs within a selected collection. */
export type MainTab = 'data' | 'schema' | 'query' | 'rag' | 'stats' | 'projection' | 'tenants'
/** Instance-wide views, shown when no collection is selected. */
export type AdminView = 'overview' | 'aliases' | 'backup' | 'rbac' | 'cluster'

/** One level of the projection drill-down (root = All, then one per selection). */
export interface BreadcrumbLevel {
  jobId: string
  runId: string
  label: string
  /** Root-relative; absent at the root. */
  indices?: number[]
  /** Points in the level, known once it is done. */
  n?: number
  pcaFrame?: string
  umapFrame?: string
  dims: 2 | 3
  status: 'running' | 'done' | 'failed' | 'cancelled'
}

/**
 * The run and the view-only roles live here so a tab switch (panels unmount) does not
 * lose them. labelProp/colourProp never trigger a run (D-21).
 */
export interface ProjectionSlice {
  jobId?: string
  runId?: string
  view: 'pca' | 'umap'
  dims: 2 | 3
  /** undefined = never chosen (the schema default applies); null = explicitly cleared. */
  labelProp?: string | null
  colourProp?: string | null
  breadcrumb: BreadcrumbLevel[]
}

interface AppState {
  activeConnectionId?: string
  status: Record<string, ConnStatus>
  selectedCollection?: string
  selectedTenant?: string
  mainTab: MainTab
  adminView: AdminView
  projection: ProjectionSlice

  setActiveConnection: (id?: string) => void
  setStatus: (id: string, status: ConnStatus) => void
  selectCollection: (name?: string) => void
  setSelectedTenant: (tenant?: string) => void
  setMainTab: (tab: MainTab) => void
  setAdminView: (view: AdminView) => void
  setProjectionRun: (jobId: string, runId: string) => void
  setProjectionView: (view: 'pca' | 'umap') => void
  setProjectionDims: (dims: 2 | 3) => void
  setProjectionLabel: (prop: string | null) => void
  setProjectionColour: (prop: string | null) => void
  setProjectionBreadcrumb: (breadcrumb: BreadcrumbLevel[]) => void
  pushBreadcrumb: (level: BreadcrumbLevel) => void
  settleBreadcrumb: (
    runId: string,
    outcome: Outcome,
    extra?: { pcaFrame?: string; umapFrame?: string; n?: number }
  ) => void
  /** Pops `steps` levels; returns the jobId of an in-flight level the caller must cancel. */
  backBreadcrumb: (steps?: number) => string | undefined
  rerunBreadcrumb: (index: number, runId: string, dims: 2 | 3) => void
  resetProjection: () => void
}

const INITIAL_PROJECTION: ProjectionSlice = { view: 'pca', dims: 2, breadcrumb: [] }

type Set = (fn: (s: AppState) => Partial<AppState>) => void
function setCrumbs(set: Set, next: (levels: BreadcrumbLevel[]) => BreadcrumbLevel[]): void {
  set((s) => ({ projection: { ...s.projection, breadcrumb: next(s.projection.breadcrumb) } }))
}

export const useApp = create<AppState>((set, get) => ({
  status: {},
  mainTab: 'data',
  adminView: 'overview',
  projection: INITIAL_PROJECTION,

  setActiveConnection: (id) =>
    set({
      activeConnectionId: id,
      selectedCollection: undefined,
      selectedTenant: undefined,
      adminView: 'overview'
    }),
  setStatus: (id, status) => set((s) => ({ status: { ...s.status, [id]: status } })),
  selectCollection: (name) =>
    set({ selectedCollection: name, selectedTenant: undefined, mainTab: 'data' }),
  setSelectedTenant: (tenant) => set({ selectedTenant: tenant }),
  setMainTab: (tab) => set({ mainTab: tab }),
  // Choosing an instance-wide view means leaving whatever collection was open.
  setAdminView: (view) => set({ adminView: view, selectedCollection: undefined }),

  setProjectionRun: (jobId, runId) =>
    set((s) => ({ projection: { ...s.projection, jobId, runId } })),
  setProjectionView: (view) => set((s) => ({ projection: { ...s.projection, view } })),
  setProjectionDims: (dims) => set((s) => ({ projection: { ...s.projection, dims } })),
  setProjectionLabel: (labelProp) => set((s) => ({ projection: { ...s.projection, labelProp } })),
  setProjectionColour: (colourProp) => set((s) => ({ projection: { ...s.projection, colourProp } })),
  setProjectionBreadcrumb: (breadcrumb) => set((s) => ({ projection: { ...s.projection, breadcrumb } })),
  pushBreadcrumb: (level) => setCrumbs(set, (l) => pushLevel(l, level)),
  settleBreadcrumb: (runId, outcome, extra) => setCrumbs(set, (l) => settleLevel(l, runId, outcome, extra)),
  backBreadcrumb: (steps = 1) => {
    let levels = get().projection.breadcrumb
    let cancelJobId: string | undefined
    for (let i = 0; i < steps; i++) {
      const popped = back(levels)
      levels = popped.levels
      cancelJobId ??= popped.cancelJobId
    }
    setCrumbs(set, () => levels)
    return cancelJobId
  },
  rerunBreadcrumb: (index, runId, dims) => setCrumbs(set, (l) => rerunLevel(l, index, runId, dims)),
  resetProjection: () => set({ projection: INITIAL_PROJECTION })
}))
