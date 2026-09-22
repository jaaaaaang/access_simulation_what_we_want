/**
 * Flask(python) API 클라이언트 — playground-daily-tmap-data-querying-l
 * ---------------------------------------------------------------------------
 * 이 React 앱은 정적 빌드(nginx)로 사내 배포되어 python 실행/사내 DB 접속을 할 수 없다.
 * 그래서 DB 조회·CAD 추출 같은 작업은 별도 Flask 앱에 위임하고, 결과만 JSON으로 받는다.
 *
 * [주소 결정 규칙]
 *  1) VITE_PY_API_BASE 가 설정되어 있으면 그 절대 URL 사용
 *     → 두 앱이 다른 도메인으로 분리될 경우의 대비책. 현재는 설정하지 않는다.
 *  2) 없으면 같은 도메인의 /daily-tmap-data-querying-l 경로로 상대 호출  ← 현재 동작
 *
 *  ※ 사내 확인 완료(2026-08-28): 두 앱은 같은 도메인에 path로만 갈린다.
 *      https://playground.idcube.sktelecom.com/eng-apt-cover-windows/       (이 앱)
 *      https://playground.idcube.sktelecom.com/daily-tmap-data-querying-l/  (Flask)
 *    따라서 상대경로만 쓰면 브라우저가 현재 도메인을 붙여 same-origin으로 요청하므로
 *    CORS 설정이 전혀 필요 없다. VITE_PY_API_BASE 는 비워둘 것.
 *
 *  로컬 개발에서는 vite.config.ts 의 proxy 설정이 이 경로를 localhost:8080 으로 넘겨준다.
 *
 * [긴 작업 처리]
 *  DB 조회는 수 분이 걸릴 수 있어 HTTP 응답을 끝까지 붙잡으면 프록시/브라우저가 끊는다.
 *  그래서 job 방식을 쓴다: 시작하면 jobId를 즉시 받고, 상태를 폴링하다가, 완료되면 결과를 받는다.
 */

export const PY_API_PREFIX =
  ((import.meta as any).env?.VITE_PY_API_BASE as string | undefined)?.replace(/\/$/, '') ||
  '/daily-tmap-data-querying-l';

/** Flask API의 전체 URL을 만든다. path는 '/los/...' 형식. */
export function getPyApiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${PY_API_PREFIX}${p}`;
}

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

export type PyTarget = { rapaKey: string; lat: number; lng: number };

export type PyJobStatus = 'pending' | 'running' | 'done' | 'error';

export type PyJob = {
  jobId: string;
  kind: string;
  status: PyJobStatus;
  progress: { done: number; total: number; message: string };
  meta?: Record<string, any>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  errorTrace?: string;
  hasResult: boolean;
};

export type PyPingResult = {
  result: string;
  service: string;
  contextPath: string;
  capabilities: {
    idcube_hive_connector: boolean;
    pandas: boolean;
    shapely: boolean;
    rapa_dxf_extract: boolean;
    cv2: boolean;
  };
  cadDir: string;
  cadFiles: number;
  defaultNeighborMeters: number;
};

export type CadFileItem = {
  rapaKey: string;
  fileName: string;
  sizeBytes: number;
  modifiedAt: number;
};

// ---------------------------------------------------------------------------
// 기본 호출 헬퍼
// ---------------------------------------------------------------------------

async function pyFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(getPyApiUrl(path), init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Flask 응답을 JSON으로 해석할 수 없습니다 (HTTP ${res.status}). ` +
      `Flask 서버가 떠 있는지, 주소(${PY_API_PREFIX})가 맞는지 확인하세요. 응답: ${text.slice(0, 200)}`
    );
  }
  if (!res.ok && res.status !== 202) {
    throw new Error(json?.error || `Flask API 실패 (HTTP ${res.status})`);
  }
  return json;
}

function postJson(path: string, body: any) {
  return pyFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 연결 확인
// ---------------------------------------------------------------------------

/** Flask 서버가 살아있는지 + 사내 라이브러리를 쓸 수 있는지 확인. 실패해도 예외 대신 null. */
export async function pingPyApi(): Promise<PyPingResult | null> {
  try {
    return (await pyFetch('/los/ping')) as PyPingResult;
  } catch (err) {
    console.warn('[PY] Flask API 연결 실패 — python 연동 기능은 비활성화됩니다.', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// job 폴링
// ---------------------------------------------------------------------------

export async function getPyJob(jobId: string): Promise<PyJob> {
  const json = await pyFetch(`/los/jobs/${encodeURIComponent(jobId)}`);
  return json.job as PyJob;
}

export async function getPyJobResult<T = any>(jobId: string): Promise<T> {
  const json = await pyFetch(`/los/jobs/${encodeURIComponent(jobId)}/result`);
  if (json?.result !== 'success') {
    throw new Error('아직 완료되지 않은 작업입니다.');
  }
  return json.data as T;
}

export type WaitOptions = {
  /** 폴링 주기(ms). 기본 2초 */
  intervalMs?: number;
  /** 최대 대기(ms). 기본 30분 */
  timeoutMs?: number;
  /** 진행률 콜백 — 진행바 표시용 */
  onProgress?: (job: PyJob) => void;
  /** 취소 신호 */
  signal?: AbortSignal;
};

/** jobId를 받아 완료될 때까지 폴링하고 최종 결과를 반환한다. */
export async function waitForPyJob<T = any>(jobId: string, opts: WaitOptions = {}): Promise<T> {
  const interval = opts.intervalMs ?? 2000;
  const timeout = opts.timeoutMs ?? 30 * 60 * 1000;
  const started = Date.now();

  for (;;) {
    if (opts.signal?.aborted) throw new Error('사용자가 취소했습니다.');
    const job = await getPyJob(jobId);
    opts.onProgress?.(job);

    if (job.status === 'done') return await getPyJobResult<T>(jobId);
    if (job.status === 'error') {
      throw new Error(job.error || '작업이 실패했습니다.');
    }
    if (Date.now() - started > timeout) {
      throw new Error(`작업이 제한 시간(${Math.round(timeout / 60000)}분)을 넘겼습니다. jobId=${jobId}`);
    }
    await new Promise(r => setTimeout(r, interval));
  }
}

// ---------------------------------------------------------------------------
// [1-1] geo 조회 — 단지 폴리곤 + 건물(단지 내 + 주변 65m)
// ---------------------------------------------------------------------------

/** 단건 동기 조회 — 빠른 확인용. 오래 걸릴 수 있으면 fetchGeoDataJob 사용. */
export async function fetchGeoDataSingle(
  target: PyTarget,
  neighborMeters?: number   // 미지정 시 서버 기본값(167m) 사용
): Promise<any> {
  const json = await postJson('/los/geo', { ...target, neighborMeters });
  return json.data;
}

export type GeoBatchResult = {
  generatedAt: string;
  neighborMeters: number;
  failed: Array<{ rapaKey: string; reason: string }>;
  targets: Record<string, any>;
};

/** 여러 건 비동기 조회 — 완료까지 폴링해서 결과 반환. */
export async function fetchGeoDataJob(
  targets: PyTarget[],
  opts: WaitOptions & { neighborMeters?: number } = {}
): Promise<GeoBatchResult> {
  // neighborMeters 를 넘기지 않으면 서버 기본값(167m ≈ bufferDeg 0.0015)을 쓴다.
  // 화면 표시 반경(65m)은 scenePrep.ts 가 따로 적용하므로 여기서 좁히면 안 된다.
  const start = await postJson('/los/geo/job', {
    targets,
    ...(opts.neighborMeters !== undefined ? { neighborMeters: opts.neighborMeters } : {}),
  });
  return await waitForPyJob<GeoBatchResult>(start.jobId, opts);
}

// ---------------------------------------------------------------------------
// [1-2] 자사 안테나 조회 (65m)
// ---------------------------------------------------------------------------

export type AntennaQueryResult = {
  generatedAt: string;
  sourceTable: string;
  dt: string;
  radiusMeters: number;
  filterRule: string;
  targets: Record<string, any[]>;
};

export async function fetchAntennasJob(
  targets: PyTarget[],
  opts: WaitOptions & { radiusMeters?: number; dt?: string } = {}
): Promise<AntennaQueryResult> {
  // radiusMeters 미지정 시 서버 기본값(557m ≈ 0.005도). 화면 배치 시 65m로 걸러진다.
  const start = await postJson('/los/antenna/job', {
    targets,
    ...(opts.radiusMeters !== undefined ? { radiusMeters: opts.radiusMeters } : {}),
    dt: opts.dt,
  });
  return await waitForPyJob<AntennaQueryResult>(start.jobId, opts);
}

// ---------------------------------------------------------------------------
// [1-3] CAD 업로드 & 추출
// ---------------------------------------------------------------------------

/** 업로드된 CAD 파일 목록 */
export async function listCadFiles(): Promise<CadFileItem[]> {
  const json = await pyFetch('/los/cad/list');
  return (json.items || []) as CadFileItem[];
}

/** DXF 업로드 — 서버에 <rapaKey>.dxf 로 저장된다. */
export async function uploadCadFile(
  rapaKey: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ rapaKey: string; fileName: string; sizeBytes: number }> {
  const form = new FormData();
  form.append('rapaKey', rapaKey);
  form.append('file', file);

  // 업로드 진행률을 보려면 XHR이 필요하다 (fetch는 업로드 진행률 미지원)
  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', getPyApiUrl('/los/cad/upload'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      let json: any = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error(`업로드 응답 해석 실패 (HTTP ${xhr.status})`));
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.result === 'success') {
        resolve(json);
      } else {
        reject(new Error(json?.error || `업로드 실패 (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('업로드 중 네트워크 오류가 발생했습니다.'));
    xhr.send(form);
  });
}

/** 업로드된 CAD에서 단지/건물 폴리곤 생성 (+주변 건물 65m). 완료까지 폴링. */
export async function extractFromCadJob(
  rapaKey: string,
  opts: WaitOptions & {
    neighborMeters?: number;
    withNeighbors?: boolean;
    complexName?: string;
    addrPrefix?: string;
    floorsBelow?: number | null;
    /** 단지 대표 좌표 — v3 파이프라인의 앵커. 없으면 서버가 구버전으로 폴백한다 */
    lat?: number | null;
    lng?: number | null;
    engine?: 'v3' | 'v6';
  } = {}
): Promise<any> {
  const start = await postJson('/los/cad/extract', {
    rapaKey,
    ...(opts.neighborMeters !== undefined ? { neighborMeters: opts.neighborMeters } : {}),
    withNeighbors: opts.withNeighbors ?? true,
    complexName: opts.complexName ?? '',
    addrPrefix: opts.addrPrefix ?? '',
    floorsBelow: opts.floorsBelow ?? null,
    lat: opts.lat ?? null,
    lng: opts.lng ?? null,
    engine: opts.engine ?? 'v3',
  });
  return await waitForPyJob(start.jobId, opts);
}

// ---------------------------------------------------------------------------
// 통합: geo + antenna (+ CAD 폴백) 한 번에
// ---------------------------------------------------------------------------

export type BundleResult = {
  geo: GeoBatchResult;
  cadUsed: string[];
  cadFailed: Array<{ rapaKey: string; reason: string }>;
  antenna: AntennaQueryResult | null;
  antennaError?: string;
};

export async function fetchBundleJob(
  targets: PyTarget[],
  opts: WaitOptions & {
    neighborMeters?: number;
    radiusMeters?: number;
    useCadFallback?: boolean;
    withAntenna?: boolean;
  } = {}
): Promise<BundleResult> {
  const start = await postJson('/los/bundle/job', {
    targets,
    ...(opts.neighborMeters !== undefined ? { neighborMeters: opts.neighborMeters } : {}),
    ...(opts.radiusMeters !== undefined ? { radiusMeters: opts.radiusMeters } : {}),
    useCadFallback: opts.useCadFallback ?? true,
    withAntenna: opts.withAntenna ?? true,
  });
  return await waitForPyJob<BundleResult>(start.jobId, opts);
}

// ---------------------------------------------------------------------------
// 전체 자동화 배치 — 기존 주피터 수동 절차 대체
// ---------------------------------------------------------------------------

export type BatchSummary = {
  startedAt: string;
  finishedAt: string;
  targetCount: number;
  csvSkipped: string[];
  outputDir: string;
  geo: { ok: number; failed: Array<{ rapaKey: string; reason: string }>; neighborMeters: number } | null;
  antenna: { dt: string; radiusMeters: number; targetCount: number; antennaCount: number;
             file?: string; sizeBytes?: number } | null;
  antennaError?: string;
  cadUsed: string[];
  cadFailed: Array<{ rapaKey: string; reason: string }>;
  written: Array<{ rapaKey: string; sizeBytes: number }>;
  writeFailed: Array<{ rapaKey: string; reason: string }>;
  /** gitlab 10MB 제한 초과 파일 — 있으면 커밋 전에 처리해야 한다 */
  largeFiles: Array<{ file: string; sizeMB: number }>;
};

/** apt_list 전체를 조회해 temps/*.json + antenna_assets.json 을 서버에 생성한다.
 *  targets 를 주면 그 대상만, 안 주면 서버의 apt_list.csv 전체. */
export async function runFullBatch(
  opts: WaitOptions & {
    targets?: PyTarget[];
    withGeo?: boolean;
    withAntenna?: boolean;
    useCadFallback?: boolean;
    neighborMeters?: number;
    radiusMeters?: number;
    dt?: string;
  } = {}
): Promise<BatchSummary> {
  const start = await postJson('/los/batch/run', {
    ...(opts.targets ? { targets: opts.targets } : {}),
    withGeo: opts.withGeo ?? true,
    withAntenna: opts.withAntenna ?? true,
    useCadFallback: opts.useCadFallback ?? true,
    ...(opts.neighborMeters !== undefined ? { neighborMeters: opts.neighborMeters } : {}),
    ...(opts.radiusMeters !== undefined ? { radiusMeters: opts.radiusMeters } : {}),
    ...(opts.dt ? { dt: opts.dt } : {}),
  });
  // 전체 배치는 오래 걸리므로 기본 타임아웃을 2시간으로 늘린다
  return await waitForPyJob<BatchSummary>(start.jobId, { timeoutMs: 2 * 60 * 60 * 1000, ...opts });
}

export type BatchOutputs = {
  outputDir: string;
  tempsCount: number;
  temps: Array<{ rapaKey: string; sizeBytes: number; modifiedAt: number }>;
  antennaFile: { sizeBytes: number; modifiedAt: number } | null;
  largeFiles: Array<{ file: string; sizeMB: number }>;
};

export async function getBatchOutputs(): Promise<BatchOutputs> {
  const json = await pyFetch('/los/batch/outputs');
  return json as BatchOutputs;
}

/** 산출물 zip 다운로드 URL — 브라우저로 받아 로컬에서 git commit 한다. */
export function getBatchDownloadUrl(keys?: string[], includeAntenna = true): string {
  const q = new URLSearchParams();
  if (keys?.length) q.set('keys', keys.join(','));
  if (!includeAntenna) q.set('antenna', '0');
  const qs = q.toString();
  return getPyApiUrl(`/los/batch/download${qs ? `?${qs}` : ''}`);
}
