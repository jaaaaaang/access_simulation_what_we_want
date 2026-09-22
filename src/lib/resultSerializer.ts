import {
  SimulationParams,
  SimulationResult,
  BatchResult,
  BatchResultStatus,
  BatchStepReport,
  BatchStepKey,
  StepStatus,
  BatchSite,
  TopRankSummary,
  Point,
} from '../types';
import { CanvasGeoMapping } from './scenePrep';
import { canvasToLonLat } from './moiraPolygon';
import { VERANDA_AI_VERSION } from './verandaAi';

export interface BuildBatchResultMeta {
  aptName?: string;
  durationSec?: number;
  source?: 'batch' | 'manual';
  buildingCount?: number;
  verandaSource?: string;
  pixelsPerMeter?: number;
  stepReportSteps?: Record<BatchStepKey, StepStatus>;
}

/**
 * 시뮬레이션 결과(SimulationResult)를 표준 BatchResult 스키마로 직렬화 조립하는 순수 함수
 * (헤드리스 losRunner와 지도 탭의 수동 결과 저장에서 공용 사용)
 */
export function buildBatchResult(
  simResult: SimulationResult,
  mapping: CanvasGeoMapping,
  params: SimulationParams,
  rapaKey: string,
  meta: BuildBatchResultMeta = {}
): BatchResult {
  // 1. Rank 1 Equipments -> BatchSite 그룹핑
  const rank1Equipments = simResult.equipments || [];
  const siteMap = new Map<string, BatchSite>();
  let siteSeq = 0;

  rank1Equipments.forEach((eq) => {
    const key = `${Math.round(eq.x)},${Math.round(eq.y)}`;
    if (!siteMap.has(key)) {
      const [lng, lat] = canvasToLonLat(eq.x, eq.y, mapping);
      siteMap.set(key, {
        siteIdx: siteSeq++,
        x: Math.round(eq.x * 10) / 10,
        y: Math.round(eq.y * 10) / 10,
        lng,
        lat,
        bIdx: eq.bIdx,
        sectors: [],
      });
    }
    siteMap.get(key)!.sectors.push({
      id: eq.id,
      angle: eq.angle,
      type: eq.isManual ? 'manual' : 'auto',
    });
  });

  const rank1Sites = Array.from(siteMap.values());
  const coverageRatio = parseFloat(simResult.coverageRatio.toFixed(1));
  const secondCoveredCount = simResult.secondCoveredSamples?.length || 0;

  // 복원용 covered samples (0.1px 반올림으로 용량 절감)
  const coveredSamples: Point[] = (simResult.coveredSamples || []).map((p: Point) => ({
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
  }));

  const secondCoveredSamplesPoints: Point[] = (simResult.secondCoveredSamples || []).map((p: Point) => ({
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
  }));

  // 0%/0site 판정: "Auto-optimizer ended: Unfinished targeting" 또는 배치 불가 케이스
  const isZeroResult = coverageRatio === 0 && rank1Sites.length === 0;
  const finalStatus: BatchResultStatus = isZeroResult ? 'WARN' : 'OK';
  const warningMsg = isZeroResult
    ? '커버리지 0% (배치 대상 베란다/후보점 부재 또는 목표 커버리지 미도달)'
    : null;

  // 로그 크기 최적화 (상한 100건)
  let logs = simResult.logs || [];
  if (logs.length > 100) {
    logs = [
      ...logs.slice(0, 40),
      {
        id: 'SUMMARY-TRUNCATED',
        x: 0,
        y: 0,
        angle: 0,
        score: 0,
        coveredCount: 0,
        message: `... 중간 로그 ${logs.length - 80}건 생략 ...`,
      },
      ...logs.slice(-40),
    ];
  }

  // 2. TopRanks 1~5 요약 조립
  const topRanks: TopRankSummary[] = [];
  if (simResult.rankResults) {
    for (let r = 1; r <= 5; r++) {
      const rRes = simResult.rankResults[r];
      if (rRes) {
        const rSiteMap = new Map<string, { x: number; y: number; lng: number; lat: number; bIdx?: number; angles: number[] }>();
        rRes.equipments.forEach((eq) => {
          const key = `${Math.round(eq.x)},${Math.round(eq.y)}`;
          if (!rSiteMap.has(key)) {
            const [lng, lat] = canvasToLonLat(eq.x, eq.y, mapping);
            rSiteMap.set(key, {
              x: Math.round(eq.x * 10) / 10,
              y: Math.round(eq.y * 10) / 10,
              lng,
              lat,
              bIdx: eq.bIdx,
              angles: [],
            });
          }
          rSiteMap.get(key)!.angles.push(eq.angle);
        });
        const rSites = Array.from(rSiteMap.values());
        topRanks.push({
          rank: r,
          coverageRatio: parseFloat(rRes.coverageRatio.toFixed(1)),
          siteCount: rSites.length,
          sectorCount: rRes.equipments.length,
          sites: rSites,
        });
      }
    }
  }

  // 3. StepReport 조립
  const steps: Record<BatchStepKey, StepStatus> = meta.stepReportSteps || {
    '2.1_polygon_fetch': 'OK',
    '2.2_nearby_sites': 'SKIP',
    '2.3_kanro_check': 'OK',
    '2.4_veranda_setup': 'OK',
    '2.5_polygon_filter': 'OK',
    '2.6_los_simulation': 'OK',
    '2.7_ailayer_prep': 'OK',
    '3_ailayer_update': 'SKIP',
  };

  const stepReport: BatchStepReport = {
    ina_no: rapaKey,
    apt_name: meta.aptName || rapaKey,
    steps,
    overall: finalStatus,
    error_msg: null,
    warning_msg: warningMsg,
    los_pct: coverageRatio,
    site_cnt: rank1Sites.length,
  };

  return {
    rapaKey,
    analyzedAt: new Date().toISOString(),
    durationSec: meta.durationSec || 1,
    status: finalStatus,
    errorMsg: null,
    warningMsg,
    source: meta.source || 'batch',
    params,
    scene: {
      buildingCount: meta.buildingCount ?? 0,
      verandaSource: meta.verandaSource || VERANDA_AI_VERSION,
      pixelsPerMeter: meta.pixelsPerMeter || params.pixelsPerMeter || 1.0,
    },
    rank1: {
      coverageRatio,
      secondCoveredSamples: secondCoveredCount,
      secondCoverage: secondCoveredCount,
      coveredSamples,
      secondCoveredSamplesPoints,
      sites: rank1Sites,
      buildingCoverages: simResult.buildingCoverages || [],
      logs,
    },
    topRanks,
    stepReport,
  };
}
