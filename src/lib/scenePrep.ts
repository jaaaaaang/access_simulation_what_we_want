import { Point, Line, Polygon } from '../types';
import { MoiraComplexPolygonResult, lonLatToCanvas, CanvasMapping, FALLBACK_HALF_DEG } from './moiraPolygon';
import { generateAutoVerandas, metersPerPxFromGeoMapping } from './verandaAi';
import { STANDARD_SIM_PARAMS } from './standardParams';

export const M_PER_DEG_LAT = 111320;
export const MAX_CANVAS_W = 1200;
export const MAX_CANVAS_H = 800;
export const MIN_ASPECT = 0.4;
export const MAX_ASPECT = 2.5;

export type CanvasGeoMapping = CanvasMapping;

/** WGS84 위경도 범위로 보이는지 (SHP 등 투영좌표계 입력을 걸러내기 위함) */
export const looksLikeLonLat = (m: CanvasGeoMapping): boolean =>
  Math.abs(m.minLon) <= 180 &&
  Math.abs(m.minLon + m.lonRange) <= 180 &&
  Math.abs(m.minLat) <= 89 &&
  Math.abs(m.minLat + m.latRange) <= 89;

/** 가로/세로 미터-픽셀 비를 같게 맞춘 mapping 반환 (좌표계 불명이면 원본 그대로) */
export function squareUpMapping<T extends CanvasGeoMapping>(m: T): T {
  if (!(m.lonRange > 0) || !(m.latRange > 0) || !looksLikeLonLat(m)) return m;
  const midLat = m.minLat + m.latRange / 2;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  if (!(mPerDegLon > 0)) return m;
  const mppX = (m.lonRange * mPerDegLon) / (m.cWidth * 0.8);
  const mppY = (m.latRange * M_PER_DEG_LAT) / (m.cHeight * 0.8);
  const mpp = Math.max(mppX, mppY); // 항상 넓히는 쪽 — 기존 표시 영역 보존
  const lonRange = (mpp * m.cWidth * 0.8) / mPerDegLon;
  const latRange = (mpp * m.cHeight * 0.8) / M_PER_DEG_LAT;
  return {
    ...m,
    minLon: m.minLon + m.lonRange / 2 - lonRange / 2,
    minLat: m.minLat + m.latRange / 2 - latRange / 2,
    lonRange,
    latRange,
  };
}

/**
 * 위경도 bbox -> 등방(가로=세로 축척) 캔버스 매핑.
 * 캔버스 크기 자체를 bbox의 실제 미터 종횡비에 맞춰 정하므로, 화면을 낭비하지 않으면서
 * 픽셀당 미터가 두 축에서 같아진다 (= 축척 스칼라 1개로 정확히 표현 가능).
 * 종횡비가 극단이면 캔버스를 클램프하고 남는 몫은 bbox를 넓혀 흡수한다(표시 영역 보존).
 */
export const fitIsotropicMapping = (
  base: { minLon: number; minLat: number; lonRange: number; latRange: number }
): CanvasGeoMapping => {
  const fallback: CanvasGeoMapping = { ...base, cWidth: MAX_CANVAS_W, cHeight: MAX_CANVAS_H };
  if (!(base.lonRange > 0) || !(base.latRange > 0) || !looksLikeLonLat(fallback)) return fallback;
  const midLat = base.minLat + base.latRange / 2;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  if (!(mPerDegLon > 0)) return fallback;
  const widthM = base.lonRange * mPerDegLon;
  const heightM = base.latRange * M_PER_DEG_LAT;
  if (!(widthM > 0) || !(heightM > 0)) return fallback;

  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, widthM / heightM));
  let cWidth: number, cHeight: number;
  if (aspect >= MAX_CANVAS_W / MAX_CANVAS_H) {
    cWidth = MAX_CANVAS_W;
    cHeight = Math.round(MAX_CANVAS_W / aspect);
  } else {
    cHeight = MAX_CANVAS_H;
    cWidth = Math.round(MAX_CANVAS_H * aspect);
  }
  // 클램프/반올림 잔차는 bbox를 넓혀 흡수 -> 두 축 축척이 정확히 일치
  return squareUpMapping({ ...base, cWidth, cHeight });
};

/** 등방화된 mapping에서 픽셀/미터 산출. 계산 불가(이미지 배경·투영좌표계 등)면 null. */
export const pixelsPerMeterFromMapping = (m: CanvasGeoMapping | null | undefined): number | null => {
  if (!m || !(m.lonRange > 0) || !(m.cWidth > 0) || !looksLikeLonLat(m)) return null;
  const midLat = m.minLat + m.latRange / 2;
  const widthM = m.lonRange * M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  if (!(widthM > 0)) return null;
  const ppm = (m.cWidth * 0.8) / widthM;
  return isFinite(ppm) && ppm > 0 ? ppm : null;
};

export type ScenePrepOptions = {
  /** 베란다 자동 생성(generateAutoVerandas) 실행 여부 (기본 true) */
  generateVerandas?: boolean;
  /** 수동 지정 픽셀/미터 (미지정 시 mapping으로부터 자동 계산) */
  customPixelsPerMeter?: number;
  /** 단지 경계 기준 인접 건물 유효 반경 (m, Ground Rule 기본값: 65m, -1이면 필터링 없이 전체 포함) */
  adjacentBuildingBuffer?: number;
};

export type PreparedScene = {
  mapping: CanvasGeoMapping;
  buildings: Polygon[];
  analysisArea: Point[] | null;
  pixelsPerMeter: number;
  verandas: Line[];
  concreteWalls: Line[];
  targetBuildings: Polygon[];
  buildingCount: number;
  sourceMoira: MoiraComplexPolygonResult;
};

/** 점이 다각형 내부인지 판별 */
function pointInPoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 점과 다각형 외곽선 사이의 최단 거리 계산 */
function distToPoly(p: Point, poly: Point[]): number {
  let minD = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p1 = poly[j];
    const p2 = poly[i];
    const l2 = (p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2;
    let t = l2 === 0 ? 0 : ((p.x - p1.x) * (p2.x - p1.x) + (p.y - p1.y) * (p2.y - p1.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    const proj = { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
    const d = Math.sqrt((p.x - proj.x) ** 2 + (p.y - proj.y) ** 2);
    if (d < minD) minD = d;
  }
  return minD;
}

/**
 * MOIRA(Athena 또는 temps JSON) 단지/건물 데이터를 받아
 * 브라우저 및 헤드리스 공용으로 시뮬레이션용 장면(Scene)을 구성한다.
 */
export function prepareSceneFromMoira(
  moira: MoiraComplexPolygonResult,
  options: ScenePrepOptions = {}
): PreparedScene {
  if (!moira || (!moira.buildings?.length && !moira.complex?.polygon?.length)) {
    throw new Error('유효한 건물 또는 단지 폴리곤 데이터가 없습니다.');
  }

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  const extend = (lon: number, lat: number) => {
    if (!isNaN(lon) && !isNaN(lat)) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  };

  moira.complex?.polygon?.forEach(([lon, lat]) => extend(lon, lat));
  moira.buildings?.forEach(b => {
    if (b.polygon && b.polygon.length >= 3) {
      b.polygon.forEach(([lon, lat]) => extend(lon, lat));
    } else if (b.center) {
      extend(b.center[0], b.center[1]);
    }
  });

  if (!isFinite(minLon) || !isFinite(minLat)) {
    throw new Error('폴리곤 좌표 경계(BBox)를 계산할 수 없습니다.');
  }

  // 투영 등방화 매핑
  const mapping = fitIsotropicMapping({
    minLon,
    minLat,
    lonRange: (maxLon - minLon) || 0.0001,
    latRange: (maxLat - minLat) || 0.0001,
  });

  // 건물 폴리곤 캔버스 좌표계 변환
  const allParsedBuildings: Polygon[] = (moira.buildings || []).map(b => {
    const ring = (b.polygon && b.polygon.length >= 3)
      ? b.polygon
      : [
        [b.center[0] - FALLBACK_HALF_DEG, b.center[1] - FALLBACK_HALF_DEG],
        [b.center[0] + FALLBACK_HALF_DEG, b.center[1] - FALLBACK_HALF_DEG],
        [b.center[0] + FALLBACK_HALF_DEG, b.center[1] + FALLBACK_HALF_DEG],
        [b.center[0] - FALLBACK_HALF_DEG, b.center[1] + FALLBACK_HALF_DEG],
      ] as [number, number][];
    return ring.map(([lon, lat]) => lonLatToCanvas(lon, lat, mapping));
  });

  // 단지 분석 영역 캔버스 좌표계 변환
  const mappedComplexArea: Point[] | null = (moira.complex && moira.complex.polygon && moira.complex.polygon.length >= 3)
    ? moira.complex.polygon.map(([lon, lat]) => lonLatToCanvas(lon, lat, mapping))
    : null;

  // PPM 축척 계산
  const calculatedPpm = pixelsPerMeterFromMapping(mapping) || 1.0;
  const pixelsPerMeter = options.customPixelsPerMeter !== undefined
    ? options.customPixelsPerMeter
    : parseFloat(calculatedPpm.toFixed(3));

  // [Ground Rule] 단지 인접 건물 필터링 (기본값: 65m 이내 건물만 유지)
  const bufferMeters = options.adjacentBuildingBuffer !== undefined
    ? options.adjacentBuildingBuffer
    : STANDARD_SIM_PARAMS.adjacentBuildingBuffer; // Ground Rule 기본값(WG 검증 중)

  let parsedBuildings: Polygon[] = allParsedBuildings;
  if (mappedComplexArea && bufferMeters >= 0) {
    const bufferPx = bufferMeters * pixelsPerMeter;
    parsedBuildings = allParsedBuildings.filter(bldg => {
      let cx = 0, cy = 0;
      bldg.forEach(p => { cx += p.x; cy += p.y; });
      cx /= bldg.length;
      cy /= bldg.length;
      const center = { x: cx, y: cy };

      // 1. 건물의 중심점이 단지 내부이면 포함
      if (pointInPoly(center, mappedComplexArea)) return true;

      // 2. 단지 경계선과의 거리가 bufferPx(65m) 이내이면 포함
      const dist = distToPoly(center, mappedComplexArea);
      return dist <= bufferPx;
    });

    // 만약 필터링 결과가 비어있다면 원본 유지 (안전장치)
    if (parsedBuildings.length === 0) {
      parsedBuildings = allParsedBuildings;
    }
  }

  let verandas: Line[] = [];
  let concreteWalls: Line[] = [];
  let targetBuildings: Polygon[] = [];

  const shouldGenVerandas = options.generateVerandas !== false;
  if (shouldGenVerandas && parsedBuildings.length > 0) {
    const autoResult = generateAutoVerandas(
      parsedBuildings,
      mappedComplexArea,
      metersPerPxFromGeoMapping(mapping)
    );
    verandas = autoResult.verandas;
    concreteWalls = autoResult.concreteWalls;
    targetBuildings = autoResult.targetBuildings;
  }

  return {
    mapping,
    buildings: parsedBuildings,
    analysisArea: mappedComplexArea,
    pixelsPerMeter,
    verandas,
    concreteWalls,
    targetBuildings,
    buildingCount: parsedBuildings.length,
    sourceMoira: moira,
  };
}
