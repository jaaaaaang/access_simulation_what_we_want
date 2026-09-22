import { getApiUrl } from './api';

// MOIRA(Athena) 단지/건물 폴리곤 조회 클라이언트 헬퍼.
// athena/query_moira.py(서버의 /api/moira-polygon)가 반환하는 JSON과,
// 배치로 미리 뽑아둔 public/complex_polygons.json 캐시 파일 양쪽을 같은 타입으로 다룬다.

export type MoiraBuilding = {
  ciss_bld_cd: string | null;
  bld_nm: string | null;
  floors_above: number | null;
  floors_below: number | null;
  height: number | null;
  /** [lng, lat] */
  center: [number, number];
  /** [[lng, lat], ...] — 없을 수 있음 (WKT 파싱 실패 등) */
  polygon: [number, number][] | null;
  /** CAD(배치도 설치 심볼)로 판정한 관로동 여부 — rapa_v3 추출 결과에만 있다 */
  is_duct_building?: boolean;
  /** 관로동 판정 근거 (rooftop-marker 등) */
  duct_evidence?: string | null;
  equipment_install_method?: string | null;
};

export type MoiraComplexPolygonResult = {
  rapaKey: string;
  queriedAt: string;
  complex: {
    bld_cplx_inf_id: number | null;
    cplx_scl_nm: string | null;
    /** [[lng, lat], ...] */
    polygon: [number, number][];
  } | null;
  buildingSource: 'complex_polygon' | 'bbox_fallback' | null;
  buildings: MoiraBuilding[];
};

export type MoiraBatchExport = {
  generatedAt: string;
  sourceCsv: string;
  failed: string[];
  targets: Record<string, MoiraComplexPolygonResult>;
};

export type MoiraLiveResponse = {
  ok: boolean;
  status: number;
  data?: MoiraComplexPolygonResult;
  error?: string;
  rawJson?: any;
};

/** 서버 /api/moira-polygon 를 통해 실시간 Athena 조회 (디버그 정보 포함) */
export async function fetchMoiraPolygonLiveDetailed(rapaKey: string, lat: number, lng: number): Promise<MoiraLiveResponse> {
  try {
    const url = getApiUrl(`/api/moira-polygon?rapaKey=${encodeURIComponent(rapaKey)}&lat=${lat}&lng=${lng}`);
    const res = await fetch(url);
    let data: any;
    try {
      data = await res.json();
    } catch {
      return {
        ok: false,
        status: res.status,
        error: `서버 응답 파싱 실패 (HTTP ${res.status})`,
      };
    }
    if (!res.ok || data?.error) {
      return {
        ok: false,
        status: res.status,
        error: data?.error || `HTTP ${res.status}`,
        rawJson: data,
      };
    }
    return {
      ok: true,
      status: res.status,
      data: data as MoiraComplexPolygonResult,
      rawJson: data,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err.message || '네트워크 요청 실패',
    };
  }
}

/** 서버 /api/moira-polygon 를 통해 실시간 Athena 조회 (기존 호환용) */
export async function fetchMoiraPolygonLive(rapaKey: string, lat: number, lng: number): Promise<MoiraComplexPolygonResult> {
  const resp = await fetchMoiraPolygonLiveDetailed(rapaKey, lat, lng);
  if (!resp.ok || !resp.data) {
    throw new Error(resp.error || `HTTP ${resp.status}`);
  }
  return resp.data;
}

/** 분할된 temps/<rapa_key>.json 또는 polygons/<rapa_key>.json 파일에서 특정 아파트 캐시 1건 로드 */
export async function fetchMoiraPolygonFromCache(rapaKey: string): Promise<MoiraComplexPolygonResult | null> {
  const base = (import.meta as any).env?.BASE_URL || '/';
  const encodedKey = encodeURIComponent(rapaKey);

  // 1) temps/<rapaKey>.json 확인
  try {
    const res = await fetch(`${base}temps/${encodedKey}.json`);
    if (res.ok) {
      const data = await res.json();
      if (data && (data.buildings || data.complex)) {
        return data as MoiraComplexPolygonResult;
      }
    }
  } catch { }

  // 2) polygons/<rapaKey>.json 확인
  try {
    const res = await fetch(`${base}polygons/${encodedKey}.json`);
    if (res.ok) {
      const data = await res.json();
      if (data && (data.buildings || data.complex)) {
        return data as MoiraComplexPolygonResult;
      }
    }
  } catch { }

  return null;
}

/** athena/query_moira.py batch 모드로 미리 만들어둔 public/complex_polygons.json 캐시 로드 (통짜 파일 호환용).
 *  파일이 없으면(아직 배치를 안 돌린 경우) 조용히 null 반환 — 404는 정상 상황. */
export async function loadMoiraBatchCache(): Promise<MoiraBatchExport | null> {
  try {
    const base = (import.meta as any).env?.BASE_URL || '/';
    const res = await fetch(`${base}complex_polygons.json`);
    if (!res.ok) return null;
    return (await res.json()) as MoiraBatchExport;
  } catch {
    return null;
  }
}


// ============================================================================
// [DB 저장] 화면에서 교정한 건물 폴리곤을 원본 소스 JSON에 되돌려 쓰기 위한 유틸.
// ----------------------------------------------------------------------------
// Save Topology(세션 스냅샷 export)와 달리, 여기서 다루는 것은 "마스터 데이터 교정"이다.
// App.tsx의 applyMoiraResult()가 쓰는 toCanvas() 정규화 공식과 정확히 역/정방향 쌍을
// 이루어야 하므로, 두 변환을 이 파일에 함께 둔다.
// ============================================================================

/** App.tsx applyMoiraResult()가 만드는 캔버스 매핑 정보 (geoMapping 상태와 동일 구조) */
export type CanvasMapping = {
  minLon: number;
  minLat: number;
  lonRange: number;
  latRange: number;
  cWidth: number;
  cHeight: number;
};

/** 폴리곤이 없는 건물의 대체 사각형 반경(도). App.tsx FALLBACK_HALF_DEG와 동일해야 함. */
export const FALLBACK_HALF_DEG = 0.00007;

/** 위경도 -> 캔버스 픽셀 (App.tsx toCanvas와 동일 공식) */
export function lonLatToCanvas(lon: number, lat: number, m: CanvasMapping): { x: number; y: number } {
  return {
    x: ((lon - m.minLon) / m.lonRange) * (m.cWidth * 0.8) + (m.cWidth * 0.1),
    y: m.cHeight - (((lat - m.minLat) / m.latRange) * (m.cHeight * 0.8) + (m.cHeight * 0.1)),
  };
}

/** 캔버스 픽셀 -> 위경도 (lonLatToCanvas의 역변환) */
export function canvasToLonLat(x: number, y: number, m: CanvasMapping): [number, number] {
  const lon = m.minLon + ((x - m.cWidth * 0.1) / (m.cWidth * 0.8)) * m.lonRange;
  const lat = m.minLat + (((m.cHeight - y) - m.cHeight * 0.1) / (m.cHeight * 0.8)) * m.latRange;
  return [round8(lon), round8(lat)];
}

function round8(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}

export type BuildingEditSummary = {
  /** 원본 그대로 유지 (좌표 왕복 오차 없이 원본 위경도 보존) */
  kept: number;
  /** 형상이 바뀌어 캔버스 좌표에서 재변환 */
  edited: number;
  /** 화면에서 새로 그린 건물 */
  added: number;
  /** 화면에서 지워진 건물 (지우개) */
  removed: number;
};

type XY = { x: number; y: number };

function centroid(pts: XY[]): XY {
  let cx = 0, cy = 0;
  pts.forEach(p => { cx += p.x; cy += p.y; });
  return { x: cx / pts.length, y: cy / pts.length };
}

function fallbackRing(center: [number, number]): [number, number][] {
  const [lon, lat] = center;
  return [
    [lon - FALLBACK_HALF_DEG, lat - FALLBACK_HALF_DEG],
    [lon + FALLBACK_HALF_DEG, lat - FALLBACK_HALF_DEG],
    [lon + FALLBACK_HALF_DEG, lat + FALLBACK_HALF_DEG],
    [lon - FALLBACK_HALF_DEG, lat + FALLBACK_HALF_DEG],
  ];
}

/**
 * 화면(캔버스)에서 편집된 건물 목록을 원본 MOIRA 결과와 병합한다.
 *
 * 매칭 전략 (건물 배열 인덱스에 의존하지 않음 — 지우개로 중간이 삭제되면 인덱스가 밀리므로):
 *  1) 정확 일치: 정점 수가 같고 모든 정점이 0.5px 이내 → 원본 위경도를 그대로 보존 (kept)
 *  2) 근접 일치: 중심점이 임계 거리 이내인 미매칭 원본과 짝지음 → 폴리곤만 교체 (edited)
 *  3) 미매칭 화면 건물 → 신규 추가 (added)
 *  4) 미매칭 원본 건물 → 삭제됨 (removed)
 *
 * 출력 순서는 원본 순서를 유지하고, 신규 건물만 뒤에 덧붙인다 (파일 diff 최소화).
 */
export function mergeEditedBuildings(
  source: MoiraComplexPolygonResult,
  currentBuildings: XY[][],
  mapping: CanvasMapping
): { data: MoiraComplexPolygonResult; summary: BuildingEditSummary } {
  const srcBuildings = source.buildings || [];

  // 원본 건물을 캔버스 좌표로 투영 (applyMoiraResult가 화면에 그린 것과 동일한 형상)
  const srcCanvas: XY[][] = srcBuildings.map(b => {
    const ring = (b.polygon && b.polygon.length >= 3) ? b.polygon : fallbackRing(b.center);
    return ring.map(([lon, lat]) => lonLatToCanvas(lon, lat, mapping));
  });
  const srcCentroids = srcCanvas.map(centroid);

  const usedSrc = new Array(srcBuildings.length).fill(false);
  /** 화면 건물 index -> 원본 index */
  const assignedSrc: (number | null)[] = new Array(currentBuildings.length).fill(null);
  /** 화면 건물 index -> 정확 일치 여부 */
  const exactMatch: boolean[] = new Array(currentBuildings.length).fill(false);

  // --- pass 1: 정확 일치 ---
  for (let ci = 0; ci < currentBuildings.length; ci++) {
    const cur = currentBuildings[ci];
    for (let si = 0; si < srcCanvas.length; si++) {
      if (usedSrc[si]) continue;
      const sc = srcCanvas[si];
      if (sc.length !== cur.length) continue;
      let maxD = 0;
      for (let k = 0; k < sc.length; k++) {
        const d = Math.hypot(sc[k].x - cur[k].x, sc[k].y - cur[k].y);
        if (d > maxD) maxD = d;
        if (maxD > 0.5) break;
      }
      if (maxD <= 0.5) {
        assignedSrc[ci] = si;
        exactMatch[ci] = true;
        usedSrc[si] = true;
        break;
      }
    }
  }

  // --- pass 2: 중심점 근접 일치 (형상이 수정된 건물) ---
  const nearThreshold = Math.min(mapping.cWidth, mapping.cHeight) * 0.05;
  for (let ci = 0; ci < currentBuildings.length; ci++) {
    if (assignedSrc[ci] !== null) continue;
    if (currentBuildings[ci].length < 3) continue;
    const cc = centroid(currentBuildings[ci]);
    let best = -1;
    let bestD = nearThreshold;
    for (let si = 0; si < srcCentroids.length; si++) {
      if (usedSrc[si]) continue;
      const d = Math.hypot(srcCentroids[si].x - cc.x, srcCentroids[si].y - cc.y);
      if (d < bestD) { bestD = d; best = si; }
    }
    if (best >= 0) {
      assignedSrc[ci] = best;
      usedSrc[best] = true;
    }
  }

  // --- 병합 결과 조립 ---
  const summary: BuildingEditSummary = { kept: 0, edited: 0, added: 0, removed: 0 };
  /** 원본 index -> 화면 index */
  const srcToCur = new Map<number, number>();
  assignedSrc.forEach((si, ci) => { if (si !== null) srcToCur.set(si, ci); });

  const merged: MoiraBuilding[] = [];
  for (let si = 0; si < srcBuildings.length; si++) {
    const ci = srcToCur.get(si);
    if (ci === undefined) {
      summary.removed++;
      continue; // 화면에서 삭제된 건물 → 저장 대상에서 제외
    }
    const original = srcBuildings[si];
    if (exactMatch[ci]) {
      summary.kept++;
      merged.push(original); // 좌표 왕복 오차 방지 — 원본 그대로
      continue;
    }
    summary.edited++;
    const ring = currentBuildings[ci].map(p => canvasToLonLat(p.x, p.y, mapping));
    const cLon = ring.reduce((s, r) => s + r[0], 0) / ring.length;
    const cLat = ring.reduce((s, r) => s + r[1], 0) / ring.length;
    merged.push({
      ...original,
      center: [round8(cLon), round8(cLat)],
      polygon: ring,
    });
  }

  // 화면에서 새로 그린 건물
  for (let ci = 0; ci < currentBuildings.length; ci++) {
    if (assignedSrc[ci] !== null) continue;
    if (currentBuildings[ci].length < 3) continue;
    summary.added++;
    const ring = currentBuildings[ci].map(p => canvasToLonLat(p.x, p.y, mapping));
    const cLon = ring.reduce((s, r) => s + r[0], 0) / ring.length;
    const cLat = ring.reduce((s, r) => s + r[1], 0) / ring.length;
    merged.push({
      ciss_bld_cd: null,
      bld_nm: null,
      floors_above: null,
      floors_below: null,
      height: null,
      center: [round8(cLon), round8(cLat)],
      polygon: ring,
    });
  }

  return {
    data: { ...source, buildings: merged },
    summary,
  };
}

export type MoiraSaveResponse = {
  ok: boolean;
  rapaKey?: string;
  path?: string;
  backedUp?: boolean;
  buildingCount?: number;
  editedAt?: string;
  error?: string;
};

/** 교정된 단지 데이터를 public/temps/<rapaKey>.json 에 저장 (서버 경유) */
export async function saveMoiraPolygonToCache(
  rapaKey: string,
  data: MoiraComplexPolygonResult
): Promise<MoiraSaveResponse> {
  try {
    const url = getApiUrl('/api/moira-polygon/save');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rapaKey, data }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      return { ok: false, error: json?.error || `HTTP ${res.status}` };
    }
    return json as MoiraSaveResponse;
  } catch (err: any) {
    return { ok: false, error: err.message || '저장 요청 실패' };
  }
}

/** DB 저장 이전 원본으로 복원 */
export async function restoreMoiraPolygonFromBackup(rapaKey: string): Promise<MoiraSaveResponse> {
  try {
    const url = getApiUrl('/api/moira-polygon/restore');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rapaKey }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      return { ok: false, error: json?.error || `HTTP ${res.status}` };
    }
    return json as MoiraSaveResponse;
  } catch (err: any) {
    return { ok: false, error: err.message || '복원 요청 실패' };
  }
}

export type CachedRapaKeyItem = {
  rapaKey: string;
  complexName: string | null;
  buildingCount: number;
  /** DB 저장으로 교정된 적이 있으면 ISO 타임스탬프 */
  editedAt: string | null;
};

/** RAPA Key 부분 문자열로 temps 캐시 목록 조회 (서버 미가동 시 빈 배열) */
export async function listCachedRapaKeys(q: string): Promise<CachedRapaKeyItem[]> {
  try {
    const url = getApiUrl(`/api/temps/list?q=${encodeURIComponent(q)}`);
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.items) ? (json.items as CachedRapaKeyItem[]) : [];
  } catch {
    return [];
  }
}
