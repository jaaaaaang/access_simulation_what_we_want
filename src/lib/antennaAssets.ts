// ============================================================================
// 인접 무선 시설(안테나 자산) 로딩 — o_iam.celp_fgru_antenna
// ----------------------------------------------------------------------------
// 규격서: public/guide/ant_remote_asset.md (v2)
//
// 앱 런타임에서 Athena 직결이 불가하므로(DIY 앱서버에 idcube_hive_connector 없음),
// 배치로 미리 뽑아둔 public/antenna_assets.json 캐시를 읽어 쓴다.
// 공간 필터(단지 폴리곤 + 65m)는 건물 로딩과 동일한 기준을 그대로 적용한다.
// ============================================================================

import { Equipment, Point, Polygon } from '../types';
import { CanvasMapping, lonLatToCanvas } from './moiraPolygon';
import { getApiUrl } from './api';
import { pointInPolygon, distToPolygon } from './simulation';
import { STANDARD_SIM_PARAMS } from './standardParams';

/** 배치 캐시 1건 — 안테나 1개(위치 + 방위각 단위로 dedup된 섹터) */
export type AntennaAsset = {
  lat: number;
  lon: number;
  /** 방위각 (0=정북, 시계방향). simulation.ts 각도 규약과 동일하므로 무변환 사용 */
  azimuth: number;
  enbId?: string | null;
  sector?: string | null;
  txAnt?: string | null;
  hBeamwidth?: number | null;
  txTilt?: number | null;
  txETilt?: number | null;
  towerHeight?: number | null;
  dupCnt?: number | null;
};

export type AntennaBatchExport = {
  generatedAt: string;
  sourceTable: string;
  dt: string;
  filterRule?: string;
  targets: Record<string, AntennaAsset[]>;
};

// ---------------------------------------------------------------------------
// 장비 필터 — 규격서 §3
// gubun/detail/los_flag가 전부 비어 있어 tx_ant 장비명이 유일한 판별 근거다.
// 배치 쿼리에서 1차로 걸러지지만, 캐시가 구버전일 수 있으므로 런타임에서도 방어한다.
// ---------------------------------------------------------------------------

/** 인빌딩 피코 RU · 광중계기 계열 (판정 시 가장 먼저 확인) */
const EXCLUDE_PREFIX = ['RO-', 'T_RO-', 'RORO-', 'RHU-', 'PRU', 'OPRU'];
/** 옥외 매크로 계열 (5G AAU + LTE RRU/RRH) */
const INCLUDE_PREFIX = ['AAU', 'ARRU', 'DBRRU', 'RRU', 'RRH'];

const warnedUnknown = new Set<string>();

/**
 * 아웃도어 매크로 안테나인지 판정.
 * 인빌딩 장비는 건물 내부만 서비스하므로 단지 O2I 커버리지에 기여하지 않는다.
 */
export function isOutdoorMacroAntenna(txAnt: string | null | undefined): boolean {
  if (!txAnt) return false; // NULL → 제외
  // ① 제외 접두어를 먼저 본다 — RO-AAU…, RO-PRU… 를 올바로 걸러내기 위함
  if (EXCLUDE_PREFIX.some(p => txAnt.startsWith(p))) return false;
  // ② 28GHz는 외벽 투과손실이 과다해 O2I가 사실상 불가 → 인빌딩과 같은 이유로 제외
  if (txAnt.includes('-28G-')) return false;
  // ③ 포함 접두어
  if (INCLUDE_PREFIX.some(p => txAnt.startsWith(p))) return true;
  // ④ 미지 장비명은 기본 제외 + 1회 경고 (신규 장비가 조용히 섞여 들어오는 것 방지)
  if (!warnedUnknown.has(txAnt)) {
    warnedUnknown.add(txAnt);
    console.warn(`[ANT] 미분류 장비명, 제외 처리: ${txAnt}`);
  }
  return false;
}

/** 방위각 유효성 — 0~360 밖(NULL·이상치 361~855)은 버린다 */
function normalizeAzimuth(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (v < 0 || v > 360) return null;
  return v === 360 ? 0 : v;
}

// ---------------------------------------------------------------------------
// 캐시 로딩
// ---------------------------------------------------------------------------

let cachePromise: Promise<AntennaBatchExport | null> | null = null;

/** public/antenna_assets.json 배치 캐시를 1회만 읽어 메모리에 보관 */
export async function loadAntennaAssetCache(): Promise<AntennaBatchExport | null> {
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    try {
      const res = await fetch(getApiUrl('/antenna_assets.json'), { cache: 'no-cache' });
      if (!res.ok) {
        console.warn(`[ANT] 캐시 없음 (HTTP ${res.status}) — 인접 안테나 없이 진행`);
        return null;
      }
      const json = (await res.json()) as AntennaBatchExport;
      if (!json || typeof json !== 'object' || !json.targets) {
        console.warn('[ANT] 캐시 형식 오류 — 인접 안테나 없이 진행');
        return null;
      }
      return json;
    } catch (err) {
      console.warn('[ANT] 캐시 로딩 실패 — 인접 안테나 없이 진행', err);
      return null;
    }
  })();
  return cachePromise;
}

/** 테스트/재조회용 — 메모리 캐시 초기화 */
export function resetAntennaAssetCache(): void {
  cachePromise = null;
}

// ---------------------------------------------------------------------------
// 캔버스 좌표 변환 + 공간 필터 (규격서 §6 — 건물 로딩과 동일 기준)
// ---------------------------------------------------------------------------

export type AntennaToEquipmentOptions = {
  /** 단지 외곽선 기준 유효 반경 (m). 건물과 동일하게 adjacentBuildingBuffer(기본 65m)를 쓴다 */
  bufferMeters?: number;
  /**
   * 씬의 건물 폴리곤. 안테나가 올라가 있는 "호스트 건물"을 찾아 bIdx로 물리기 위해 필요하다.
   * 넘기지 않으면 bIdx가 undefined가 되고, 호스트 건물이 자기 신호를 막아 커버리지가 0이 된다.
   */
  buildings?: Polygon[];
  /** 호스트 건물 스냅 허용 거리 (m, 기본 5m). 좌표 오차·옥상 가장자리 설치를 흡수 */
  hostSnapMeters?: number;
};

/**
 * 안테나가 올라가 있는 건물(호스트)의 인덱스를 찾는다.
 * ① 폴리곤 내부에 있으면 그 건물, ② 아니면 hostSnapMeters 이내 최근접 건물, ③ 없으면 undefined.
 *
 * 실제 안테나는 건물 옥상에 설치되므로 2D 평면 투영으로는 자기 건물 안/바로 옆에 찍힌다.
 * simulation.ts의 [규칙 9]는 `point.bIdx`와 같은 건물을 차폐 계산에서 면제하는데,
 * bIdx를 안 물리면 자기가 올라탄 건물이 모든 레이를 출발점에서 막아버려 기여도가 0이 된다.
 */
function findHostBuildingIdx(
  p: Point,
  buildings: Polygon[] | undefined,
  pixelsPerMeter: number,
  snapMeters: number
): number | undefined {
  if (!buildings || buildings.length === 0) return undefined;
  for (let i = 0; i < buildings.length; i++) {
    if (pointInPolygon(p, buildings[i])) return i;
  }
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < buildings.length; i++) {
    const d = distToPolygon(p, buildings[i]);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestDist <= snapMeters * (pixelsPerMeter || 1) ? bestIdx : undefined;
}

/**
 * 안테나 자산을 시뮬레이션용 Equipment(기존 Sector)로 변환한다.
 *
 * - 좌표: lonLatToCanvas — 건물/단지 폴리곤과 동일한 매핑
 * - 방위각: 캔버스가 북쪽-위이고 simulation.ts 각도 규약이 0=정북/시계방향이라 **무변환**
 * - 공간 필터: **단지 폴리곤 바깥** & 외곽선에서 bufferMeters 이내 (도넛 영역)
 * - 호스트 건물: 안테나가 올라탄 건물을 bIdx로 물려 자기 건물 차폐를 면제 (options.buildings 필요)
 *
 * [중요] 건물 필터와 여기서 갈린다. 건물은 "단지 내부 OR 65m 이내"를 담지만,
 * 안테나는 **내부를 오히려 버린다**. 단지 폴리곤 안에 찍히는 자사 안테나는
 * 아파트 준공 전 그 자리에 있던 기존 건물의 장비가 DB에 남아 있는 것이라,
 * 자사 DB 기준으로는 정상 데이터지만 신축 단지 시뮬레이션에는 존재할 수 없다.
 */
export function antennasToEquipments(
  assets: AntennaAsset[] | null | undefined,
  mapping: CanvasMapping,
  complexArea: Polygon | null,
  pixelsPerMeter: number,
  options: AntennaToEquipmentOptions = {}
): Equipment[] {
  if (!assets || assets.length === 0) return [];

  const bufferMeters = options.bufferMeters ?? STANDARD_SIM_PARAMS.adjacentBuildingBuffer;
  const bufferPx = bufferMeters * (pixelsPerMeter || 1);
  const out: Equipment[] = [];

  assets.forEach((a, idx) => {
    if (!isOutdoorMacroAntenna(a.txAnt)) return;

    const azimuth = normalizeAzimuth(a.azimuth);
    if (azimuth === null) return;
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return;

    const p: Point = lonLatToCanvas(a.lon, a.lat, mapping);

    // 단지 폴리곤이 없으면(폴백 씬) 공간 필터를 걸 기준이 없으므로 전부 통과시킨다
    if (complexArea && complexArea.length >= 3) {
      // ① 단지 폴리곤 내부 → 제외 (철거 예정 부지의 잔존 장비로 간주)
      if (pointInPolygon(p, complexArea)) return;
      // ② 외곽선에서 bufferMeters 초과 → 제외
      if (distToPolygon(p, complexArea) > bufferPx) return;
    }

    // 호스트 건물을 물려야 자기 건물에 의한 출발점 차단을 면제받는다 (findHostBuildingIdx 주석 참조)
    const hostBIdx = findHostBuildingIdx(p, options.buildings, pixelsPerMeter, options.hostSnapMeters ?? 5);

    out.push({
      id: `ANT-${a.enbId ?? 'NA'}-${a.sector ?? 'NA'}-${idx}`,
      x: p.x,
      y: p.y,
      angle: azimuth,
      ...(hostBIdx !== undefined ? { bIdx: hostBIdx } : {}),
      isExisting: true,
      isManual: false,
      txAnt: a.txAnt ?? undefined,
      enbId: a.enbId ?? undefined,
      sectorId: a.sector ?? undefined,
      hBeamwidth: a.hBeamwidth ?? undefined,
    });
  });

  return out;
}

/** RAPA Key 기준으로 캐시에서 꺼내 바로 Equipment로 변환하는 헬퍼 */
export async function loadExistingAntennaEquipments(
  rapaKey: string,
  mapping: CanvasMapping,
  complexArea: Polygon | null,
  pixelsPerMeter: number,
  options: AntennaToEquipmentOptions = {}
): Promise<Equipment[]> {
  const cache = await loadAntennaAssetCache();
  if (!cache) return [];
  const assets = cache.targets[rapaKey];
  if (!assets) {
    console.info(`[ANT] 캐시에 ${rapaKey} 항목 없음 — 인접 안테나 0건`);
    return [];
  }
  return antennasToEquipments(assets, mapping, complexArea, pixelsPerMeter, options);
}
