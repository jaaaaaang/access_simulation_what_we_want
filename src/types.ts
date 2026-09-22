export type Point = { x: number; y: number; centerFactor?: number; isCandidate?: boolean; edgeLength?: number };
export type Line = { start: Point; end: Point; bIdx?: number; normal?: Point; isSecond?: boolean };
export type Polygon = Point[];
export type Equipment = {
  id: string;
  x: number;
  y: number;
  angle: number;
  bIdx?: number;
  coveredPoints?: Point[];
  isManual?: boolean;
  /** 인접 무선시설(o_iam.celp_fgru_antenna)에서 불러온 기존 안테나 — 다이어트/Rank 삭감 대상 제외 */
  isExisting?: boolean;
  /** 기존 안테나 메타 (표시/툴팁용) */
  txAnt?: string;
  enbId?: string;
  sectorId?: string;
  hBeamwidth?: number;
};

export type SimulationMode = 'pure_manual' | 'manual_second_veranda' | 'full_auto';

export type SimulationParams = {
  beamWidth: number;
  maxRange: number;
  targetCoverage: number;
  pixelsPerMeter: number;
  strictCoLocation: boolean;
  preventAutoSectors?: boolean;
  simulationMode?: SimulationMode;
  analysisArea?: Point[];
  adjacentBuildingBuffer?: number; // 단지 외곽 인접 건물 유효 반경 (m, 기본값: 65)
  facilitySearchRadius?: number;   // 인접 자사 Access 시설정보 검색 반경 (m, 기본값: 150)
  candidateStepMeters?: number;    // 옥상 테두리 후보점 간격 (m, 기본값: 2.5) — 축척과 무관하게 균등 샘플링
  // [관로동 추천 모드] 단지 폴리곤 밖 건물은 차폐물로만 쓰고 장비 설치 후보·커버리지 모수에서 제외
  hostInsideOnly?: boolean;
  // [관로동 추천 모드] 자동 사이트 최대 개수 (기준 분석 대비 N배수 상한). 0/미지정이면 제한 없음
  maxSites?: number;
};

export type LogEntry = {
    id: string;
    x: number;
    y: number;
    angle: number;
    score: number;
    coveredCount: number;
    message: string;
};

export type CandidateSite = {
    iterationIdx: number; // SITE-N 번호와 매핑
    rank: number;         // 1 = 선택됨, 2~5 = 탈락 후보
    x: number;
    y: number;
    bIdx: number;
    angles: number[];
    jointScore: number;
    coveredCount: number;
    isChosen: boolean;
};

export type RankResult = {
  rank: number;
  equipments: Equipment[];
  coverageRatio: number;
  coveredSamples: Point[];
  secondCoveredSamples?: Point[];
  buildingCoverages?: { 
    bIdx: number; 
    ratio: number; 
    covered: number; 
    total: number;
    secondCovered?: number;
    secondTotal?: number;
  }[];
};

export type SimulationResult = {
  equipments: Equipment[];
  coverageRatio: number;
  /** 기존 안테나(isExisting)만으로 확보된 커버율 (%) — 총 커버율(coverageRatio)에 이미 포함되어 있다 */
  existingCoverageRatio?: number;
  /** 커버리지에 반영된 기존 안테나 섹터 수 */
  existingAntennaCount?: number;
  coveredSamples: Point[];
  secondCoveredSamples?: Point[];
  logs: LogEntry[];
  buildingCoverages?: { 
    bIdx: number; 
    ratio: number; 
    covered: number; 
    total: number;
    secondCovered?: number;
    secondTotal?: number;
  }[];
  candidateSites?: CandidateSite[]; // 이터레이션별 평가된 후보 Top5
  rankResults?: Record<number, RankResult>; // Rank 1~5별 결과 세트
  /** 탐색 규모 요약 — "X개 포인트 × N회 × 36방향 = Z개 케이스" (RESULTS 카드 표시용) */
  searchSummary?: {
    buildings: number;   // 후보점을 놓은 건물 수
    points: number;      // 옥상 테두리 후보 포인트 수
    iterations: number;  // 사이트 탐색 이터레이션 수 (= 포인트별 시뮬레이션 횟수)
    directions: number;  // 방향 수 (36, 10° 단계)
    cases: number;       // 실제 평가된 포인트-방향 케이스 수 (points×iterations×36에서 제약으로 제외된 포인트 제외)
    rays: number;        // evaluateRay 호출 수
    stepMeters: number;  // 후보점 간격 (m)
  };
};

// ============================================================================
// [대량 배치 분석 & 결과 저장 스키마 (TODOLIST.md §3, los_batch_spec.md Step 4)]
// ============================================================================

export type BatchSiteSector = {
  id: string;
  angle: number;
  type: 'auto' | 'manual';
};

export type BatchSite = {
  siteIdx: number;
  x: number;
  y: number;
  lng: number;
  lat: number;
  bIdx?: number;
  sectors: BatchSiteSector[];
};

export type Rank1Detail = {
  coverageRatio: number;
  /** 2차 베란다 커버된 조밀 샘플 수 (1m 간격 샘플링이므로 대략 m 환산치와 대응) */
  secondCoveredSamples: number;
  /** @deprecated secondCoveredSamples 와 동일한 값 유지 (하위 호환) */
  secondCoverage?: number;
  /** 화면 상태 복원용 1차 베란다 커버된 샘플 좌표 (0.1px 반올림) */
  coveredSamples?: Point[];
  /** 화면 상태 복원용 2차 베란다 커버된 샘플 좌표 (0.1px 반올림) */
  secondCoveredSamplesPoints?: Point[];
  sites: BatchSite[];
  buildingCoverages: {
    bIdx: number;
    ratio: number;
    covered: number;
    total: number;
    secondCovered?: number;
    secondTotal?: number;
  }[];
  logs: LogEntry[];
};

export type TopRankSummary = {
  rank: number;
  coverageRatio: number;
  siteCount: number;
  sectorCount: number;
  sites: {
    siteIdx?: number;
    x: number;
    y: number;
    lng: number;
    lat: number;
    bIdx?: number;
    angles: number[];
  }[];
};

export type BatchStepKey =
  | '2.1_polygon_fetch'
  | '2.2_nearby_sites'
  | '2.3_kanro_check'
  | '2.4_veranda_setup'
  | '2.5_polygon_filter'
  | '2.6_los_simulation'
  | '2.7_ailayer_prep'
  | '3_ailayer_update';

export type StepStatus = 'OK' | 'NOK' | 'SKIP';

export type BatchResultStatus = 'OK' | 'WARN' | 'NOK';

export type BatchStepReport = {
  ina_no: string;
  apt_name?: string;
  steps: Record<BatchStepKey, StepStatus>;
  overall: BatchResultStatus;
  error_msg: string | null;
  warning_msg?: string | null;
  los_pct?: number;
  site_cnt?: number;
};

export type BatchResult = {
  rapaKey: string;
  analyzedAt: string;
  durationSec: number;
  status: BatchResultStatus;
  errorMsg: string | null;
  warningMsg?: string | null;
  source?: 'batch' | 'manual';
  params: SimulationParams;
  scene: {
    buildingCount: number;
    verandaSource: string;
    pixelsPerMeter: number;
  };
  rank1?: Rank1Detail;
  topRanks?: TopRankSummary[];
  stepReport?: BatchStepReport;
};

export type ResultIndexItem = {
  status: BatchResultStatus;
  coverageRatio?: number;
  siteCount?: number;
  sectorCount?: number;
  analyzedAt: string;
  durationSec: number;
  buildingCount?: number;
  errorMsg?: string | null;
  warningMsg?: string | null;
  source?: 'batch' | 'manual';
};

export type ResultIndex = {
  updatedAt: string;
  items: Record<string, ResultIndexItem>;
};

export type BatchJobItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type BatchJobItem = {
  rapaKey: string;
  aptName?: string;
  status: BatchJobItemStatus;
  startTime?: string;
  endTime?: string;
  durationSec?: number;
  elapsedSec?: number;
  progress?: number;
  error?: string | null;
  coverageRatio?: number;
  siteCount?: number;
  sectorCount?: number;
  steps?: Partial<Record<BatchStepKey, StepStatus>>;
};

export type BatchStatus = 'idle' | 'running' | 'paused' | 'cancelled' | 'completed';

export type BatchJobStatus = {
  status: BatchStatus;
  concurrency: number;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  activeWorkers: number;
  currentRapaKeys: string[];
  startedAt?: string;
  finishedAt?: string;
  estimatedRemainingSec?: number;
  items: BatchJobItem[];
};

export type BatchStartParams = {
  rapaKeys: string[];
  params?: Partial<SimulationParams>;
  concurrency?: number;
  skipAnalyzed?: boolean;
  forceRerun?: boolean;
};

export type PolygonStatusItem = {
  hasComplex: boolean;
  buildingCount: number;
  source: string | null;
  hasPlan: boolean;
};


