import { Point, Line, Polygon, Equipment, SimulationParams, SimulationResult, LogEntry, CandidateSite, SimulationMode, RankResult } from '../types';
import { STANDARD_SIM_PARAMS } from './standardParams';

/**
 * [규칙 5] 2차 베란다 가중치 — 1차 대비 RF 투과율 차이를 반영해 70%만 인정한다.
 * 커버율 = (1차 커버 + SECOND_VERANDA_WEIGHT × 2차 커버) / 1차 총량.
 * 최적화 루프·다이어트·최종 KPI·건물별 커버리지가 모두 이 상수 하나를 쓴다 (지표 통일).
 */
export const SECOND_VERANDA_WEIGHT = 0.7;

export function pointInPolygon(point: Point, vs: Polygon) {
    let x = point.x, y = point.y;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].x, yi = vs[i].y;
        let xj = vs[j].x, yj = vs[j].y;
        let intersect = ((yi > y) != (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

export function distance(p1: Point, p2: Point) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

function distToSegmentSquared(p: Point, v: Point, w: Point) {
    const l2 = Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
    if (l2 === 0) return distance(p, v) * distance(p, v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.pow(p.x - (v.x + t * (w.x - v.x)), 2) + Math.pow(p.y - (v.y + t * (w.y - v.y)), 2);
}

export function distToPolygon(p: Point, poly: Polygon) {
    let minDist = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const d2 = distToSegmentSquared(p, poly[j], poly[i]);
        if (d2 < minDist) {
            minDist = d2;
        }
    }
    return Math.sqrt(minDist);
}

export function snapToPolygonEdge(p: Point, poly: Polygon): Point {
    let minDist = Infinity;
    let closestPoint: Point = { x: p.x, y: p.y };
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const v = poly[j];
        const w = poly[i];
        const l2 = Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
        if (l2 === 0) {
            const d = distance(p, v);
            if (d < minDist) { minDist = d; closestPoint = { x: v.x, y: v.y }; }
            continue;
        }
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        const proj = { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) };
        const d = distance(p, proj);
        if (d < minDist) {
            minDist = d;
            closestPoint = proj;
        }
    }
    return closestPoint;
}

export function getSecondVerandas(buildings: Polygon[], firstVerandas: Line[] = []): Line[] {
    const secondLines: Line[] = [];

    // [FIX] 1차 베란다에 건물 매핑(bIdx)이 아직 없으면(시뮬레이션 실행 전) 최근접 건물로 즉시 매핑
    // — 매핑 누락 시 "이 건물엔 1차 없음"으로 오판하여 1차를 그린 벽면까지 2차로 이중 계산되는 버그 방지
    firstVerandas.forEach(fv => {
        if (fv.bIdx === undefined && buildings.length > 0) {
            const mid = { x: (fv.start.x + fv.end.x) / 2, y: (fv.start.y + fv.end.y) / 2 };
            let minD = Infinity;
            let best = -1;
            buildings.forEach((b, idx) => {
                const d = distToPolygon(mid, b);
                if (d < minD) { minD = d; best = idx; }
            });
            if (best !== -1) fv.bIdx = best;
        }
    });

    buildings.forEach((poly, bIdx) => {
        const N = poly.length;
        if (N < 3) return;

        const bFirsts = firstVerandas.filter(v => v.bIdx === bIdx);

        for (let i = 0; i < N; i++) {
            const start = poly[i];
            const end = poly[(i + 1) % N];
            const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

            let isFirstEdge = false;
            for (const fv of bFirsts) {
                const fvMid = { x: (fv.start.x + fv.end.x) / 2, y: (fv.start.y + fv.end.y) / 2 };
                // 엣지 전체를 1차로 그린 경우 (중점 일치)
                if (distance(mid, fvMid) < 5) {
                    isFirstEdge = true;
                    break;
                }
                // [FIX] 엣지의 일부 구간만 1차로 그린 경우 — 1차 중점이 이 엣지 선분 위(5px 이내)에 있으면 제외
                if (distToSegmentSquared(fvMid, start, end) < 25) {
                    isFirstEdge = true;
                    break;
                }
            }
            if (isFirstEdge) continue;

            if (bFirsts.length > 0) {
                const fv = bFirsts[0];
                const v1 = { x: end.x - start.x, y: end.y - start.y };
                const v2 = { x: fv.end.x - fv.start.x, y: fv.end.y - fv.start.y };
                const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
                const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
                if (len1 > 0 && len2 > 0) {
                    const dot = Math.abs((v1.x * v2.x + v1.y * v2.y) / (len1 * len2));
                    if (dot > 0.8) {
                        secondLines.push({ start, end, bIdx, isSecond: true });
                    }
                }
            } else {
                const edgeLen = distance(start, end);
                const avgLen = poly.reduce((sum, p, idx) => sum + distance(p, poly[(idx + 1) % N]), 0) / N;
                if (edgeLen >= avgLen) {
                    secondLines.push({ start, end, bIdx, isSecond: true });
                }
            }
        }
    });
    return secondLines;
}


// [규칙 9] 건물 차단 + [규칙 8] 거리 보상 + [B] isCandidate 분기 처리
export function evaluateRay(
    point: { x: number; y: number; bIdx?: number; isCandidate?: boolean },
    angle: number,
    sample: Point & { line: Line },
    params: SimulationParams,
    buildings: Polygon[]
): number {
    const d_px = distance(point, sample);
    const d_m = d_px / params.pixelsPerMeter;
    if (d_m > params.maxRange) return 0;

    let math_angle_to_P = Math.atan2(sample.y - point.y, sample.x - point.x) * 180 / Math.PI;
    let angle_to_P = math_angle_to_P + 90;
    if (angle_to_P < 0) angle_to_P += 360;
    if (angle_to_P >= 360) angle_to_P -= 360;

    let diff = Math.abs(angle_to_P - angle);
    diff = diff > 180 ? 360 - diff : diff;
    const halfWidth = params.beamWidth / 2;
    if (diff > halfWidth + 15) return 0;

    let angular_loss = 0;
    if (diff <= halfWidth) {
        const theta = (diff / halfWidth) * (Math.PI / 4);
        angular_loss = Math.pow(Math.cos(theta), 2);
    } else {
        const extra = diff - halfWidth;
        angular_loss = 0.5 * (1 - (extra / 15));
        if (angular_loss <= 0) return 0;
    }

    // [규칙 9] 건물 차단 — isCandidate 분기로 경계선 후보점의 정확한 차단 처리
    let blocked = false;
    const rayStep = 3;
    const startOffset = 5;
    const endOffset = 5;

    if (d_px > startOffset + endOffset) {
        for (let dist = startOffset; dist < d_px - endOffset; dist += rayStep) {
            const t = dist / d_px;
            const p = {
                x: point.x + (sample.x - point.x) * t,
                y: point.y + (sample.y - point.y) * t
            };

            let hit = false;
            for (let bIdx = 0; bIdx < buildings.length; bIdx++) {
                if (point.bIdx !== undefined && bIdx === point.bIdx) {
                    if (!point.isCandidate) {
                        // 수동/지붕 노드: 자기 건물 벽은 막힘 없음 (규칙 9)
                        continue;
                    }
                    // 경계선 후보점(isCandidate): 건물 내부로 쏘는 레이는 차단
                }
                if (pointInPolygon(p, buildings[bIdx])) {
                    hit = true;
                    break;
                }
            }
            if (hit) {
                blocked = true;
                break;
            }
        }
    }
    if (blocked) return 0;

    // [규칙 8] 거리 감쇠 + 근거리 보상 (가까운 위치 선호)
    const r_pct = d_m / params.maxRange;
    let f_d = r_pct <= 0.46 ? 1.0 : (r_pct <= 0.66 ? 0.9 : (r_pct <= 1.0 ? 0.85 : 0));

    if (f_d > 0) {
        // 가까울수록 최대 +0.2 보너스 (규칙 8: 지향 건물과 가까이 배치)
        f_d += (1.0 - r_pct) * 0.2;
    }

    const vx = (point.x - sample.x) / d_px;
    const vy = (point.y - sample.y) / d_px;
    if (!sample.line.normal) return 0;
    const cos_phi = vx * sample.line.normal.x + vy * sample.line.normal.y;

    if (cos_phi <= 0) return 0;

    const score = cos_phi * f_d * angular_loss;

    // [규칙 5] Second Veranda는 70% 적용 (모수 아님, 가점)
    return sample.line.isSecond ? score * SECOND_VERANDA_WEIGHT : score;
}

export function runSimulation(
    buildings: Polygon[],
    verandas: Line[],
    params: SimulationParams,
    initialEquipments: Equipment[] = []
): SimulationResult {
    // [C] 후보점 간격 — 미터 기준(기본 2.5m)을 축척으로 환산해 단지마다 균등한 밀도로 옥상 테두리를 탐색.
    //     (구 4px 고정은 축척에 따라 0.5~4.5m로 제각각이었음, 2026-09-05 개정)
    //     엣지를 ceil(길이/간격) 등분하므로 실제 간격은 항상 설정값 이하이고, 꼭짓점(t=0)은 항상 포함된다.
    const candidatePoints: (Point & { bIdx: number })[] = [];
    const stepM = params.candidateStepMeters ?? STANDARD_SIM_PARAMS.candidateStepMeters;
    const step = Math.max(1, stepM * (params.pixelsPerMeter || 1));

    // [관로동 추천 모드] 단지 폴리곤 밖 건물 처리
    //   · 차폐물로는 그대로 남긴다 (빼면 LOS가 과대평가된다)
    //   · 장비 설치 후보(옥상 테두리)에서 제외한다
    //   · 커버리지 모수(베란다)에서도 제외한다 — 단지 내 세대만 기준으로 목표 커버율을 판정
    const insideArea = (params.hostInsideOnly && params.analysisArea && params.analysisArea.length >= 3)
        ? params.analysisArea : null;
    const polyCenter = (poly: Polygon): Point => ({
        x: poly.reduce((a, p) => a + p.x, 0) / poly.length,
        y: poly.reduce((a, p) => a + p.y, 0) / poly.length,
    });
    const buildingInside: boolean[] = buildings.map(b => !insideArea || pointInPolygon(polyCenter(b), insideArea));
    const scopedVerandas: Line[] = !insideArea ? verandas : verandas.filter(v => (
        v.bIdx !== undefined && v.bIdx >= 0 && v.bIdx < buildingInside.length
            ? buildingInside[v.bIdx]
            : pointInPolygon({ x: (v.start.x + v.end.x) / 2, y: (v.start.y + v.end.y) / 2 }, insideArea)
    ));

    // 1. 건물 경계선을 따라 후보 위치점 생성 (옥상 테두리 = 실제 LOS 유리 위치)
    buildings.forEach((poly, bIdx) => {
        if (!buildingInside[bIdx]) return;   // 단지 밖 건물: 설치 후보 제외 (차폐는 유지)
        for (let i = 0; i < poly.length; i++) {
            const p1 = poly[i];
            const p2 = poly[(i + 1) % poly.length];
            const dist = distance(p1, p2);
            const steps = Math.ceil(dist / step);
            for (let j = 0; j < steps; j++) {
                const t = steps === 0 ? 0 : j / steps;
                candidatePoints.push({
                    x: p1.x + (p2.x - p1.x) * t,
                    y: p1.y + (p2.y - p1.y) * t,
                    bIdx,
                    // [G] 엣지 중심부 보너스: 중심에 가까울수록 1.0, 끝에 가까울수록 0.0
                    centerFactor: 1.0 - Math.abs(t - 0.5) * 2,
                    isCandidate: true,
                    edgeLength: dist
                });
            }
        }
    });

    // [D] 1차/2차 베란다 완전 분리 — 규칙 5) 핵심 아키텍처
    // 사용자 그린 베란다를 1차(isSecond !== true)와 2차(isSecond === true)로 분리
    const firstVerandas = scopedVerandas.filter(v => !v.isSecond);
    const userSecondVerandas = scopedVerandas.filter(v => v.isSecond);

    // 1차 베란다가 있는 건물 추적
    const buildingsWithFirstVeranda = new Set<number>();

    // 1차 베란다: 법선 벡터 및 건물 매핑
    firstVerandas.forEach((line) => {
        let minD = Infinity;
        let bestBIdx = -1;
        const midPoint = { x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 };

        buildings.forEach((b, bIdx) => {
            const d = distToPolygon(midPoint, b);
            if (d < minD) {
                minD = d;
                bestBIdx = bIdx;
            }
        });
        line.bIdx = bestBIdx;
        if (bestBIdx !== -1) {
            buildingsWithFirstVeranda.add(bestBIdx);
        }

        const dx = line.end.x - line.start.x;
        const dy = line.end.y - line.start.y;
        let nx = -dy;
        let ny = dx;
        const len = Math.sqrt(nx * nx + ny * ny);
        if (len > 0) {
            nx /= len;
            ny /= len;
        }

        let isInside1 = false;
        let isInside2 = false;
        if (bestBIdx !== -1) {
            const poly = buildings[bestBIdx];
            for (let ep = 1; ep <= 10; ep += 2) {
                if (pointInPolygon({ x: midPoint.x + nx * ep, y: midPoint.y + ny * ep }, poly)) isInside1 = true;
                if (pointInPolygon({ x: midPoint.x - nx * ep, y: midPoint.y - ny * ep }, poly)) isInside2 = true;
                if (isInside1 !== isInside2) break;
            }
            if (isInside1 && !isInside2) {
                nx = -nx; ny = -ny;
            } else if (isInside2 && !isInside1) {
                // nx, ny is already outward
            } else {
                let cx = 0, cy = 0;
                poly.forEach(p => { cx += p.x; cy += p.y; });
                cx /= poly.length;
                cy /= poly.length;
                if (nx * (midPoint.x - cx) + ny * (midPoint.y - cy) < 0) {
                    nx = -nx; ny = -ny;
                }
            }
        }
        line.normal = { x: nx, y: ny };
    });

    // 2차 베란다: 사용자가 직접 그린 것만 사용
    // (반대변 자동 추출 기능 제거 — 별도 고도화 예정. 자동 추출이 필요해지면 getSecondVerandas 재사용)
    const secondVerandas = [...userSecondVerandas];

    // 2차 베란다: 법선 벡터 및 건물 매핑
    secondVerandas.forEach((line) => {
        let minD = Infinity;
        let bestBIdx = -1;
        const midPoint = { x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 };

        buildings.forEach((b, bIdx) => {
            const d = distToPolygon(midPoint, b);
            if (d < minD) {
                minD = d;
                bestBIdx = bIdx;
            }
        });
        line.bIdx = bestBIdx;

        const dx = line.end.x - line.start.x;
        const dy = line.end.y - line.start.y;
        let nx = -dy;
        let ny = dx;
        const len = Math.sqrt(nx * nx + ny * ny);
        if (len > 0) {
            nx /= len;
            ny /= len;
        }

        let isInside1 = false;
        let isInside2 = false;
        if (bestBIdx !== -1) {
            const poly = buildings[bestBIdx];
            for (let ep = 1; ep <= 10; ep += 2) {
                if (pointInPolygon({ x: midPoint.x + nx * ep, y: midPoint.y + ny * ep }, poly)) isInside1 = true;
                if (pointInPolygon({ x: midPoint.x - nx * ep, y: midPoint.y - ny * ep }, poly)) isInside2 = true;
                if (isInside1 !== isInside2) break;
            }
            if (isInside1 && !isInside2) {
                nx = -nx; ny = -ny;
            } else if (isInside2 && !isInside1) {
                // nx, ny is already outward
            } else {
                let cx = 0, cy = 0;
                poly.forEach(p => { cx += p.x; cy += p.y; });
                cx /= poly.length;
                cy /= poly.length;
                if (nx * (midPoint.x - cx) + ny * (midPoint.y - cy) < 0) {
                    nx = -nx; ny = -ny;
                }
            }
        }
        line.normal = { x: nx, y: ny };
    });

    type Sample = Point & { line: Line, covered: boolean };
    const samples: Sample[] = [];       // [규칙 5] 1차 베란다만 → 분모(모수)
    const secondSamples: Sample[] = []; // [규칙 5] 2차 베란다 → 가점 전용
    const sampleStep = (params.pixelsPerMeter * 1) || 5; // 1pt = 1m 베란다

    // 1차 베란다 샘플 (최적화 타겟 = 분모)
    firstVerandas.forEach(line => {
        const len = distance(line.start, line.end);
        const steps = Math.ceil(len / sampleStep);
        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            samples.push({
                x: line.start.x + (line.end.x - line.start.x) * t,
                y: line.start.y + (line.end.y - line.start.y) * t,
                line,
                covered: false
            });
        }
    });

    // 2차 베란다 샘플 ([규칙 5] 가점 전용 — 새 위치 배치 X, 기존 사이트 sector 추가만)
    secondVerandas.forEach(line => {
        const len = distance(line.start, line.end);
        const steps = Math.ceil(len / sampleStep);
        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            secondSamples.push({
                x: line.start.x + (line.end.x - line.start.x) * t,
                y: line.start.y + (line.end.y - line.start.y) * t,
                line,
                covered: false
            });
        }
    });

    if (samples.length === 0) {
        return { equipments: [], coverageRatio: 0, coveredSamples: [], logs: [] };
    }

    // [규칙 5 / 지표 통일 2026-09-05] 커버율 정의는 단 하나:
    //   coverage = (1차 커버 m + SECOND_VERANDA_WEIGHT × 2차 커버 m) / 1차 총량 m
    // 분모는 1차 베란다만(모수), 2차는 투과율 차이를 반영해 70%만 분자에 가산한다.
    // 이 정의를 루프 종료 조건·다이어트 하한·최종 KPI·건물별 커버리지 모두에 동일 적용한다.
    const getWeight = (s: Sample) => (s.line.isSecond ? SECOND_VERANDA_WEIGHT : 1.0);
    // 최적화 루프(Phase 2)·다이어트(Phase 2.6)가 보는 샘플 풀: 1차 + 2차 (2차는 0.7 가중)
    const allSamples: Sample[] = [...samples, ...secondSamples];

    const equipments: Equipment[] = [];
    const logs: LogEntry[] = [];
    logs.push({
        id: 'CAND-GRID', x: 0, y: 0, angle: 0, score: 0, coveredCount: candidatePoints.length,
        message: `[후보점] 간격 ${stepM}m (=${Math.round(step * 10) / 10}px, 축척 ${Math.round((params.pixelsPerMeter || 1) * 100) / 100}px/m) · 건물 ${buildings.length}개 옥상 테두리 후보 ${candidatePoints.length}개`
    });
    const totalWeightSum = samples.reduce((sum, s) => sum + getWeight(s), 0); // 분모 = 1차 총량
    const targetCoveredScore = totalWeightSum * (params.targetCoverage / 100);
    let currentCoveredScore = 0;
    const pct = (score: number) => Math.round((score / totalWeightSum) * 1000) / 10;
    const establishedNodes = new Map<number, Point>();

    // 기존 안테나(인접 무선시설) 기여분 집계 — 총 커버율의 분자에 포함되며, 별도로도 표기한다
    let existingCovered1stCount = 0;
    let existingAntennaCount = 0;

    // Phase 1: 사전 배치 장비 평가 (수동 배치 + 기존 안테나)
    //          1차 베란다 커버 + 2차 베란다 가점 커버 조사
    for (const eq of initialEquipments) {
        const scoredSamples: { idx: number, score: number }[] = [];
        for (let i = 0; i < samples.length; i++) {
            if (samples[i].covered) continue;
            if (eq.bIdx !== undefined && eq.bIdx === samples[i].line.bIdx) continue;

            const score = evaluateRay(eq, eq.angle, samples[i], params, buildings);
            if (score > 0.05) {
                scoredSamples.push({ idx: i, score });
            }
        }
        scoredSamples.sort((a, b) => b.score - a.score);
        const selectedSamples = scoredSamples;

        const newEq = { ...eq, coveredPoints: [] as Point[] };
        for (const s of selectedSamples) {
            samples[s.idx].covered = true;
            currentCoveredScore += getWeight(samples[s.idx]);
            newEq.coveredPoints.push({ x: samples[s.idx].x, y: samples[s.idx].y });
            if (eq.isExisting && !samples[s.idx].line.isSecond) existingCovered1stCount++;
        }
        if (eq.isExisting) existingAntennaCount++;

        // 수동 배치 장비의 2차 베란다 커버 평가 (0.7 가중으로 목표 점수에 가산 — 지표 통일)
        let second2ndCount = 0;
        for (const s2 of secondSamples) {
            if (s2.covered) continue;
            if (eq.bIdx !== undefined && eq.bIdx === s2.line.bIdx) continue;
            const score2 = evaluateRay(eq, eq.angle, s2, params, buildings);
            if (score2 > 0.05) {
                s2.covered = true;
                currentCoveredScore += getWeight(s2);
                second2ndCount++;
                newEq.coveredPoints.push({ x: s2.x, y: s2.y });
            }
        }

        equipments.push(newEq);

        if (newEq.bIdx !== undefined && !establishedNodes.has(newEq.bIdx)) {
            establishedNodes.set(newEq.bIdx, { x: newEq.x, y: newEq.y });
        }
        logs.push({
            id: newEq.id,
            x: Math.round(newEq.x), y: Math.round(newEq.y), angle: Math.round(newEq.angle),
            score: 0, coveredCount: selectedSamples.length,
            message: newEq.isExisting
                ? `[기존 안테나] ${newEq.txAnt ?? newEq.id} (${Math.round(newEq.x)}, ${Math.round(newEq.y)}) eNB ${newEq.enbId ?? '-'}/${newEq.sectorId ?? '-'} (방위각 ${Math.round(newEq.angle)}°, 1차 ${selectedSamples.length}m + 2차 ${second2ndCount}m 기여)`
                : `[수동 배치] ${newEq.id} (${Math.round(newEq.x)}, ${Math.round(newEq.y)}) ${newEq.bIdx !== undefined ? `건물 #${newEq.bIdx + 1}` : '맵'} (방향 ${Math.round(newEq.angle)}°, 1차 ${selectedSamples.length}m + 2차 ${second2ndCount}m 확보)`
        });
    }

    let maxIterations = 40;
    // [탐색 통계] 사용자 보고용 — 몇 개 포인트를 몇 번 훑어 몇 개 케이스를 평가했는지
    let searchIterations = 0;   // Phase 2 사이트 탐색 이터레이션 수
    let searchPointScans = 0;   // 포인트 × 이터레이션 (실제 36방향 스캔이 수행된 횟수)
    let searchRays = 0;         // evaluateRay 호출 수 (36방향 스캔 내부)
    const uniqueManualCoords = new Set<string>();
    initialEquipments
        .filter(eq => !eq.isExisting) // 기존 안테나는 신규 Site 번호 채번에서 제외
        .forEach(eq => uniqueManualCoords.add(`${Math.round(eq.x)},${Math.round(eq.y)}`));
    let nextSiteIdx = uniqueManualCoords.size + 1;

    // 이터레이션별 후보 투명성 — 탈락 후보 Top5 수집
    const allCandidateSites: CandidateSite[] = [];

    // 베란다 선 위 후보점 — 옥상 테두리와 같은 간격(step)으로, 이미 테두리 후보가 있는 셀은 건너뜀.
    // (구) 4px 고정으로 모든 베란다 선을 다시 샘플링 → 베란다는 건물 테두리 위에 있으므로 테두리 후보와
    //     거의 전부 중복. 2202-0846 기준 테두리 709개에 베란다 1,262개가 얹혀 탐색량이 2.8배였음 (2026-09-05).
    // (신) 테두리 후보가 없는 셀(step 크기 격자)에만 추가 → 베란다 끝점처럼 테두리 샘플이 비켜간 위치만 보강.
    const cellKey = (x: number, y: number) => `${Math.floor(x / step)},${Math.floor(y / step)}`;
    const occupiedCells = new Set<string>(candidatePoints.map(p => cellKey(p.x, p.y)));
    const rooftopCandidateCount = candidatePoints.length;
    [...firstVerandas, ...secondVerandas].forEach(v => {
        if (v.bIdx !== undefined) {
            const dist = distance(v.start, v.end);
            const steps = Math.ceil(dist / step);
            for (let j = 0; j <= steps; j++) {
                const t = steps === 0 ? 0 : j / steps;
                const x = v.start.x + (v.end.x - v.start.x) * t;
                const y = v.start.y + (v.end.y - v.start.y) * t;
                const key = cellKey(x, y);
                if (occupiedCells.has(key)) continue;
                occupiedCells.add(key);
                candidatePoints.push({ x, y, bIdx: v.bIdx, isCandidate: true, edgeLength: dist });
            }
        }
    });
    if (candidatePoints.length !== rooftopCandidateCount) {
        logs.push({
            id: 'CAND-GRID-2', x: 0, y: 0, angle: 0, score: 0, coveredCount: candidatePoints.length,
            message: `[후보점] 베란다 선 보강 +${candidatePoints.length - rooftopCandidateCount}개 (테두리 후보와 겹치는 위치 제외) → 총 ${candidatePoints.length}개`
        });
    }

    const simMode: SimulationMode = params.simulationMode || (params.preventAutoSectors ? 'pure_manual' : 'full_auto');
    const allowAutoSites = simMode === 'full_auto';
    const allowSecondVerandaSectors = simMode === 'full_auto' || simMode === 'manual_second_veranda';

    // Phase 2: Tri-Sector Site Greedy Optimizer
    // [규칙 7] 건물 분산 커버 극대화 + [규칙 6] 1~3개 활성 섹터만 배포
    const siteCap = (params.maxSites && params.maxSites > 0) ? params.maxSites : Infinity;
    const firstAutoSiteIdx = nextSiteIdx;   // 자동 사이트 개수 = nextSiteIdx - firstAutoSiteIdx
    while (allowAutoSites && currentCoveredScore < targetCoveredScore && maxIterations > 0 && candidatePoints.length > 0) {
        // [관로동 추천 모드] 사이트 수 상한 — 목표 미달이어도 여기서 멈춘다 (기준 대비 N배수 확보용)
        const autoSiteCount = nextSiteIdx - firstAutoSiteIdx;
        if (autoSiteCount >= siteCap) {
            logs.push({ id: 'SITE-CAP', x: 0, y: 0, angle: 0, score: 0, coveredCount: autoSiteCount,
                message: `[사이트 상한] 자동 사이트 ${autoSiteCount}개로 상한(${siteCap}) 도달 → 탐색 종료 (누적 커버율 ${pct(currentCoveredScore)}% / 목표 ${params.targetCoverage}%)` });
            break;
        }
        maxIterations--;
        searchIterations++;

        let bestSitePoint: (Point & { bIdx: number }) | null = null;
        let bestSiteAngles: number[] = [];
        let bestSiteScore = -1;
        let bestSiteCoveredIndices: number[] = [];
        // 이 이터레이션에서 평가된 point별 최선 후보
        const pointCandidates: { x: number; y: number; bIdx: number; score: number; angles: number[]; coveredCount: number }[] = [];

        for (const point of candidatePoints) {
            let isAllowed = true;
            if (params.strictCoLocation) {
                if (establishedNodes.has(point.bIdx)) {
                    const established = establishedNodes.get(point.bIdx)!;
                    if (Math.abs(point.x - established.x) > 1 || Math.abs(point.y - established.y) > 1) {
                        isAllowed = false;
                    }
                }
            }
            if (!isAllowed) continue;

            // 현재 건물 소속이 아닌 미커버 샘플 수집
            const activeSampleIndices: number[] = [];
            for (let i = 0; i < allSamples.length; i++) {
                if (allSamples[i].covered) continue;
                if (point.bIdx !== undefined && point.bIdx === allSamples[i].line.bIdx) continue;
                activeSampleIndices.push(i);
            }

            if (activeSampleIndices.length === 0) continue;

            const numActive = activeSampleIndices.length;

            const activeSampleBIdx = new Int32Array(numActive);
            for (let s = 0; s < numActive; s++) {
                activeSampleBIdx[s] = allSamples[activeSampleIndices[s]].line.bIdx !== undefined
                    ? allSamples[activeSampleIndices[s]].line.bIdx! : -1;
            }

            // 36방향(10° 단계) 레이 점수 사전 계산
            const scoreMatrix = new Float32Array(36 * numActive);
            const angleScores = new Float32Array(36);
            searchPointScans++;
            searchRays += 36 * numActive;

            for (let aIdx = 0; aIdx < 36; aIdx++) {
                const angle = aIdx * 10;
                let activeAngleScore = 0;
                const bScoresForAngle = new Map<number, number>();

                for (let s = 0; s < numActive; s++) {
                    const globalIdx = activeSampleIndices[s];
                    const rayScore = evaluateRay(point, angle, allSamples[globalIdx], params, buildings);
                    if (rayScore > 0.05) {
                        const weightedScore = rayScore * getWeight(allSamples[globalIdx]);
                        scoreMatrix[aIdx * numActive + s] = weightedScore;
                        activeAngleScore += weightedScore;

                        const bIdx = activeSampleBIdx[s];
                        if (bIdx !== -1) {
                            bScoresForAngle.set(bIdx, (bScoresForAngle.get(bIdx) || 0) + weightedScore);
                        }
                    }
                }
                angleScores[aIdx] = activeAngleScore;
            }

            // [E'] 커버 미터(m) 우선 1~3섹터 조합 탐색 — 최적화 지표를 KPI(커버 미터)와 일치
            // 품질(레이 스코어 합)은 동점 타이브레이커로만 사용.
            // 동일 미터(3% 허용오차)면 더 적은 섹터 조합 선택 → CAPEX 절감 + 꼴등 건물용 여유 슬롯 보존.
            // (구 [G] 엣지 중심부/긴 면 보너스 제거: temp_logic "꼭짓점 LOS Window 최대 확보" 철학과 상반되는 편향이었음)
            const sampleW = new Float32Array(numActive);
            for (let s = 0; s < numActive; s++) sampleW[s] = getWeight(allSamples[activeSampleIndices[s]]);

            let colocBonus = 1.0;
            if (params.strictCoLocation) {
                for (const eq of equipments) {
                    if (Math.sqrt((eq.x - point.x) ** 2 + (eq.y - point.y) ** 2) < 2) {
                        colocBonus = 1.30; // 코로케이션 보너스 (품질항에만 적용)
                        break;
                    }
                }
            }

            type Combo = { angles: number[]; meters: number; quality: number };
            let best1: Combo | null = null;
            let best2: Combo | null = null;
            let best3: Combo | null = null;

            for (let i = 0; i < 36; i++) {
                if (angleScores[i] === 0) continue;

                let m1 = 0;
                for (let s = 0; s < numActive; s++) {
                    if (scoreMatrix[i * numActive + s] > 0) m1 += sampleW[s];
                }
                if (!best1 || m1 > best1.meters || (m1 === best1.meters && angleScores[i] > best1.quality)) {
                    best1 = { angles: [i * 10], meters: m1, quality: angleScores[i] };
                }

                for (let j = i + 1; j < 36; j++) {
                    if (angleScores[j] === 0) continue;
                    let diffAB = Math.abs((i - j) * 10);
                    diffAB = diffAB > 180 ? 360 - diffAB : diffAB;
                    if (diffAB < 60) continue; // [규칙 11] 60° 이상 이격

                    let m2 = 0, q2 = 0;
                    for (let s = 0; s < numActive; s++) {
                        const valA = scoreMatrix[i * numActive + s];
                        const valB = scoreMatrix[j * numActive + s];
                        const mx = valA > valB ? valA : valB;
                        if (mx > 0) { m2 += sampleW[s]; q2 += mx; }
                    }
                    if (!best2 || m2 > best2.meters || (m2 === best2.meters && q2 > best2.quality)) {
                        best2 = { angles: [i * 10, j * 10], meters: m2, quality: q2 };
                    }

                    for (let k = j + 1; k < 36; k++) {
                        if (angleScores[k] === 0) continue;
                        let diffBC = Math.abs((j - k) * 10);
                        diffBC = diffBC > 180 ? 360 - diffBC : diffBC;
                        if (diffBC < 60) continue;

                        let diffCA = Math.abs((k - i) * 10);
                        diffCA = diffCA > 180 ? 360 - diffCA : diffCA;
                        if (diffCA < 60) continue;

                        let m3 = 0, q3 = 0;
                        for (let s = 0; s < numActive; s++) {
                            const valA = scoreMatrix[i * numActive + s];
                            const valB = scoreMatrix[j * numActive + s];
                            const valC = scoreMatrix[k * numActive + s];
                            const mx = valA > valB ? (valA > valC ? valA : valC) : (valB > valC ? valB : valC);
                            if (mx > 0) { m3 += sampleW[s]; q3 += mx; }
                        }
                        if (!best3 || m3 > best3.meters || (m3 === best3.meters && q3 > best3.quality)) {
                            best3 = { angles: [i * 10, j * 10, k * 10], meters: m3, quality: q3 };
                        }
                    }
                }
            }

            // 섹터 다이어트 선택: 최대 미터 대비 3%(최소 0.5m) 이내 손해면 적은 섹터 우선
            const combos = [best1, best2, best3].filter((c): c is Combo => c !== null && c.meters > 0);
            let maxJointScore = -1;
            let bestAnglesForPoint: number[] = [];
            let bestCoveredForPoint: number[] = [];
            if (combos.length > 0) {
                const peakMeters = Math.max(...combos.map(c => c.meters));
                const tol = Math.max(0.5, peakMeters * 0.03);
                const chosen = combos.find(c => c.meters >= peakMeters - tol)!; // 배열 순서 = 섹터 수 오름차순
                bestAnglesForPoint = chosen.angles;
                for (let s = 0; s < numActive; s++) {
                    for (const ang of chosen.angles) {
                        if (scoreMatrix[(ang / 10) * numActive + s] > 0) {
                            bestCoveredForPoint.push(activeSampleIndices[s]);
                            break;
                        }
                    }
                }
                // 미터가 1순위(×1000), 품질은 타이브레이크
                maxJointScore = chosen.meters * 1000 + chosen.quality * colocBonus;
            }

            // 후보 수집: 이 point의 최선 결과를 기록 (이터레이션 후 Top5 선별)
            // score 표시값 = 확보 미터 (직관적 지표)
            if (maxJointScore > 0) {
                pointCandidates.push({
                    x: Math.round(point.x),
                    y: Math.round(point.y),
                    bIdx: point.bIdx,
                    score: Math.round((maxJointScore / 1000) * 100) / 100,
                    angles: [...bestAnglesForPoint],
                    coveredCount: bestCoveredForPoint.length
                });
            }

            if (maxJointScore > bestSiteScore && maxJointScore > 0) {
                bestSiteScore = maxJointScore;
                bestSitePoint = point;
                bestSiteAngles = bestAnglesForPoint;
                bestSiteCoveredIndices = bestCoveredForPoint;
            }
        }

        // 이터레이션 Top5 후보 기록 (중복 위치 제거 후 점수 내림차순)
        const seenCoords = new Set<string>();
        const dedupedCandidates = pointCandidates.filter(c => {
            const key = `${c.x},${c.y}`;
            if (seenCoords.has(key)) return false;
            seenCoords.add(key);
            return true;
        });
        dedupedCandidates.sort((a, b) => b.score - a.score);
        dedupedCandidates.slice(0, 5).forEach((c, rank) => {
            allCandidateSites.push({
                iterationIdx: nextSiteIdx,
                rank: rank + 1,
                x: c.x,
                y: c.y,
                bIdx: c.bIdx,
                angles: c.angles,
                jointScore: c.score,
                coveredCount: c.coveredCount,
                isChosen: rank === 0
            });
        });

        if (!bestSitePoint || bestSiteCoveredIndices.length === 0) {
            logs.push({
                id: 'stop', x: 0, y: 0, angle: 0, score: 0, coveredCount: 0,
                message: `[탐색 완료] 추가 커버 가능한 유효 후보점이 없어 사이트 탐색을 종료합니다.`
            });
            break;
        }

        // [H] 각도 정제: 각 섹터를 ±15° 범위에서 1° 단계로 정밀 보정 (규칙 7: LOS 합 극대화)
        const stepActiveSamples: Sample[] = [];
        const stepActiveIndices: number[] = [];
        for (let i = 0; i < allSamples.length; i++) {
            if (allSamples[i].covered) continue;
            if (bestSitePoint!.bIdx !== undefined && bestSitePoint!.bIdx === allSamples[i].line.bIdx) continue;
            stepActiveSamples.push(allSamples[i]);
            stepActiveIndices.push(i);
        }

        // [H'] 각도 정제 (1~3 가변 섹터): 커버 미터 우선 + 품질 타이브레이크로 ±15° 정밀 보정
        const refinedAngles = [...bestSiteAngles];
        const numSectors = refinedAngles.length;
        for (let aIdx = 0; aIdx < numSectors; aIdx++) {
            let bestAngle = refinedAngles[aIdx];
            let bestRefineScore = -1;

            // 다른 섹터 점수를 고정하고 현재 섹터만 탐색
            const otherAngles = refinedAngles.filter((_, oi) => oi !== aIdx);
            const otherScores = stepActiveSamples.map(s => {
                let mx = 0;
                for (const oa of otherAngles) {
                    mx = Math.max(mx, evaluateRay(bestSitePoint!, oa, s, params, buildings));
                }
                return mx;
            });

            for (let offset = -15; offset <= 15; offset += 1) {
                const testAngle = (bestSiteAngles[aIdx] + offset + 360) % 360;

                // [규칙 11] 동일 Site 내 Sector 간 최소 60° 이격 검증 (최대 5° 중첩 허용)
                let sepOk = true;
                for (const oa of otherAngles) {
                    let d = Math.abs(testAngle - oa);
                    d = d > 180 ? 360 - d : d;
                    if (d < 60) { sepOk = false; break; }
                }
                if (!sepOk) continue;

                let meters = 0, quality = 0;
                for (let i = 0; i < stepActiveSamples.length; i++) {
                    const s = stepActiveSamples[i];
                    const scoreTest = evaluateRay(bestSitePoint!, testAngle, s, params, buildings);
                    const maxS = Math.max(scoreTest, otherScores[i]);

                    if (maxS > 0.05) {
                        const w = getWeight(s);
                        meters += w;
                        quality += maxS * w;
                    }
                }

                const refineScore = meters * 1000 + quality; // 미터 우선 + 품질 타이브레이크
                if (refineScore > bestRefineScore) {
                    bestRefineScore = refineScore;
                    bestAngle = testAngle;
                }
            }
            refinedAngles[aIdx] = bestAngle;
        }

        // 정제된 각도로 섹터별 커버 샘플 분배 (1~3 가변)
        const suffix = ['A', 'B', 'C'];
        const sectorCoveredPoints: Point[][] = refinedAngles.map(() => []);
        const sectorCoveredIndices: number[][] = refinedAngles.map(() => []);

        for (let i = 0; i < stepActiveSamples.length; i++) {
            const s = stepActiveSamples[i];
            const originalIdx = stepActiveIndices[i];
            let bestAngleIdx = 0;
            let maxRayScore = -1;
            for (let aIdx = 0; aIdx < numSectors; aIdx++) {
                const rs = evaluateRay(bestSitePoint!, refinedAngles[aIdx], s, params, buildings);
                if (rs > maxRayScore) {
                    maxRayScore = rs;
                    bestAngleIdx = aIdx;
                }
            }
            if (maxRayScore > 0.05) {
                sectorCoveredPoints[bestAngleIdx].push({ x: s.x, y: s.y });
                sectorCoveredIndices[bestAngleIdx].push(originalIdx);
            }
        }

        // [I] 동적 섹터 배포: 기여도 내림차순 정렬, 유의미한 섹터만 배포 (규칙 6: 1~3개)
        const sectorOrder = refinedAngles.map((_, x) => x).sort((a, b) => {
            const scoreA = sectorCoveredIndices[a].reduce((sum, idx) => sum + getWeight(allSamples[idx]), 0);
            const scoreB = sectorCoveredIndices[b].reduce((sum, idx) => sum + getWeight(allSamples[idx]), 0);
            return scoreB - scoreA;
        });

        const deployedSectors: string[] = [];
        const deployedSectorsInfo: string[] = [];
        let siteAddedCount = 0;
        let siteAdded1st = 0, siteAdded2nd = 0;

        for (const aIdx of sectorOrder) {
            if (sectorCoveredPoints[aIdx].length === 0) continue; // 빈 섹터 제거
            if (currentCoveredScore >= targetCoveredScore) continue; // [CAPEX 락] 목표 달성 시 신규 섹터 중단

            let sectorScore = 0;
            const newlyCovered: number[] = [];
            for (const idx of sectorCoveredIndices[aIdx]) {
                if (!allSamples[idx].covered) {
                    allSamples[idx].covered = true;
                    newlyCovered.push(idx);
                    sectorScore += getWeight(allSamples[idx]);
                }
            }

            // 약한 섹터 제거: 15m 미만이고 이미 1개 이상 배포된 경우
            // [FIX] 배포하지 않는 섹터가 마킹한 샘플은 반드시 원복 (커버리지 오염 방지)
            if (sectorScore < 15 && deployedSectors.length > 0) {
                for (const idx of newlyCovered) allSamples[idx].covered = false;
                continue;
            }
            if (sectorScore < 15 && deployedSectors.length === 0) {
                for (const idx of newlyCovered) allSamples[idx].covered = false;
                break; // 최우선 섹터도 약하면 사이트 포기
            }

            // [FIX] CAPEX 락 작동을 위한 실제 점수 가산 (이전엔 누락되어 목표 달성 후에도 계속 site 추가됨)
            currentCoveredScore += sectorScore;

            const eqId = `AUTO-${nextSiteIdx}-${suffix[aIdx]}`;
            const securedMeters = sectorCoveredPoints[aIdx].length;
            let sec1st = 0, sec2nd = 0;
            for (const idx of sectorCoveredIndices[aIdx]) { if (allSamples[idx].line.isSecond) sec2nd++; else sec1st++; }

            equipments.push({
                id: eqId,
                x: bestSitePoint.x,
                y: bestSitePoint.y,
                angle: refinedAngles[aIdx],
                bIdx: bestSitePoint.bIdx,
                coveredPoints: sectorCoveredPoints[aIdx],
                isManual: false
            });

            deployedSectors.push(eqId);
            deployedSectorsInfo.push(`${suffix[aIdx]}(${refinedAngles[aIdx]}°: 1차 ${sec1st}m+2차 ${sec2nd}m)`);
            siteAddedCount += securedMeters;
            siteAdded1st += sec1st;
            siteAdded2nd += sec2nd;

            // 섹터별 개별 배치 및 LOS 커버리지 Score 명시 로그
            logs.push({
                id: eqId,
                x: Math.round(bestSitePoint.x),
                y: Math.round(bestSitePoint.y),
                angle: refinedAngles[aIdx],
                score: Math.round(sectorScore * 100) / 100,
                coveredCount: securedMeters,
                message: `[섹터 배치] ${eqId} (${Math.round(bestSitePoint.x)}, ${Math.round(bestSitePoint.y)}) ${bestSitePoint.bIdx !== undefined ? `건물 #${bestSitePoint.bIdx + 1}` : '맵'} (방향 ${refinedAngles[aIdx]}°, 1차 ${sec1st}m + 2차 ${sec2nd}m 확보, 누적 ${pct(currentCoveredScore)}%)`
            });
        }

        if (deployedSectors.length === 0) {
            break;
        }

        if (bestSitePoint.bIdx !== undefined && !establishedNodes.has(bestSitePoint.bIdx)) {
            establishedNodes.set(bestSitePoint.bIdx, { x: bestSitePoint.x, y: bestSitePoint.y });
        }

        logs.push({
            id: `SITE-${nextSiteIdx}`,
            x: Math.round(bestSitePoint.x),
            y: Math.round(bestSitePoint.y),
            angle: refinedAngles[0],
            score: Math.round((bestSiteScore / 1000) * 100) / 100, // 미터 단위 표시
            coveredCount: siteAddedCount,
            message: `[사이트 배치] Site #${nextSiteIdx} (${Math.round(bestSitePoint.x)}, ${Math.round(bestSitePoint.y)}) ${deployedSectors.length}개 섹터 [${deployedSectorsInfo.join(', ')}] (1차 ${siteAdded1st}m + 2차 ${siteAdded2nd}m 확보 → 누적 커버율 ${pct(currentCoveredScore)}% / 목표 ${params.targetCoverage}%)`
        });

        nextSiteIdx++;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // [Phase 2.6] YW-BiGreedy Site Diet — 마이너스 엔지니어링 3단계 시퀀스
    // temp_logic.md: Target Coverage 유지 조건 하에 Site 삭감/통합 (CAPEX 다이어트)
    // ═══════════════════════════════════════════════════════════════════════
    if (allowAutoSites && equipments.length > 0) {
        // 1차+2차(0.7) 통합 커버리지 전체 평가 (사전 계산 프리셋 — 후보 루프 외부 1회 계산 원칙)
        const evalCoverage = (eqs: Equipment[]) => {
            const flags = new Uint8Array(allSamples.length);
            let score = 0;
            for (let i = 0; i < allSamples.length; i++) {
                const s = allSamples[i];
                for (const eq of eqs) {
                    if (eq.bIdx !== undefined && eq.bIdx === s.line.bIdx) continue;
                    if (evaluateRay(eq, eq.angle, s, params, buildings) > 0.05) {
                        flags[i] = 1;
                        score += getWeight(s);
                        break;
                    }
                }
            }
            return { score, flags };
        };

        type DietSite = { key: string; x: number; y: number; bIdx?: number; eqs: Equipment[]; isManual: boolean };
        const groupSites = (eqs: Equipment[]): DietSite[] => {
            const map = new Map<string, DietSite>();
            for (const eq of eqs) {
                const key = `${Math.round(eq.x)},${Math.round(eq.y)}`;
                if (!map.has(key)) map.set(key, { key, x: eq.x, y: eq.y, bIdx: eq.bIdx, eqs: [], isManual: false });
                const site = map.get(key)!;
                site.eqs.push(eq);
                // 기존 안테나(isExisting)는 우리가 놓은 장비가 아니므로 삭감/통합 대상이 될 수 없다.
                // isManual과 동일하게 취급해 다이어트에서 보호한다.
                if (eq.isManual || eq.isExisting) site.isManual = true;
            }
            return Array.from(map.values());
        };

        // [Rule 11] 동일 Site 내 Sector 간 최소 60° 이격 검증 (최대 5° 중첩 허용)
        const isValidSectorSeparation = (angle: number, others: number[]) => {
            for (const o of others) {
                let diff = Math.abs(angle - o);
                diff = diff > 180 ? 360 - diff : diff;
                if (diff < 60) return false;
            }
            return true;
        };

        let working = equipments.slice();
        let baseline = evalCoverage(working);
        const sitesBefore = groupSites(working).length;
        const sectorsBefore = working.length;
        // 다이어트 허용 하한: 목표 점수(초과 달성분은 반납 가능)와 현재 점수 중 낮은 값
        // → 통합 커버율(1차+0.7×2차)이 목표치 이하로 손실되는 삭감은 절대 불허
        const dietFloor = Math.min(targetCoveredScore, baseline.score) - 1e-6;

        let dietGuard = 24;
        let dietChanged = true;
        while (dietChanged && dietGuard-- > 0) {
            dietChanged = false;
            const sites = groupSites(working);
            const autoSites = sites.filter(st => !st.isManual); // Manual site는 절대 삭감 불가
            if (autoSites.length === 0 || sites.length <= 1) break;

            // 기여도 오름차순: 가장 값싼 victim부터 삭감/통합 시도
            const victimEvals = autoSites.map(v => {
                const rest = working.filter(eq => !v.eqs.includes(eq));
                const ev = evalCoverage(rest);
                return { v, rest, ev, contribution: baseline.score - ev.score };
            }).sort((a, b) => a.contribution - b.contribution);

            for (const cand of victimEvals) {
                // [Try-0] 순수 삭감: victim 없이도 목표 유지 → 즉시 Site 전격 삭감
                if (cand.ev.score >= dietFloor) {
                    working = cand.rest;
                    baseline = cand.ev;
                    logs.push({
                        id: 'DIET-PRUNE', x: Math.round(cand.v.x), y: Math.round(cand.v.y), angle: 0,
                        score: Math.round(cand.ev.score * 100) / 100, coveredCount: cand.v.eqs.length,
                        message: `[DIET-PRUNE] Redundant site at (${Math.round(cand.v.x)}, ${Math.round(cand.v.y)}) removed (${cand.v.eqs.length} sectors). coverage(1차+0.7×2차) preserved at ${Math.round((cand.ev.score / totalWeightSum) * 1000) / 10}% (>= target).`
                    });
                    dietChanged = true;
                    break;
                }

                // 통합(Merge): victim 제거 시 잃는 타겟 샘플을 인접 생존 사이트가 흡수
                const lostIdxs: number[] = [];
                for (let i = 0; i < allSamples.length; i++) {
                    if (baseline.flags[i] && !cand.ev.flags[i]) lostIdxs.push(i);
                }
                if (lostIdxs.length === 0) continue;

                // Target-Driven Vector Geometry: 잃는 샘플의 건물별 중심점 도출
                const centroidMap = new Map<number, { x: number; y: number; n: number }>();
                for (const idx of lostIdxs) {
                    const bId = allSamples[idx].line.bIdx ?? -1;
                    const c = centroidMap.get(bId) || { x: 0, y: 0, n: 0 };
                    c.x += allSamples[idx].x; c.y += allSamples[idx].y; c.n++;
                    centroidMap.set(bId, c);
                }
                const centroids = Array.from(centroidMap.values()).map(c => ({ x: c.x / c.n, y: c.y / c.n }));

                // [Step 1] Sector Slot Margin Check — 3섹터 꽉 찬 사이트는 Immediate Pruning Skip
                const absorbers = groupSites(cand.rest)
                    .filter(st => st.eqs.length < 3)
                    .sort((a, b) => distance(a, cand.v) - distance(b, cand.v));

                let mergeDone = false;
                for (const adj of absorbers) {
                    const slots = 3 - adj.eqs.length;
                    // 고정 장비(adj 제외 생존 전체) 커버리지 1회 사전 계산 (Pre-computation)
                    const fixedEqs = cand.rest.filter(eq => !adj.eqs.includes(eq));
                    const fixedEv = evalCoverage(fixedEqs);
                    const openIdxs: number[] = [];
                    for (let i = 0; i < allSamples.length; i++) if (!fixedEv.flags[i]) openIdxs.push(i);
                    if (openIdxs.length === 0) continue;

                    // [Step 2] Rooftop Vertex/Edge Micro-Shift (위치 이동 최우선, Building Boundary Lock)
                    const positions: Point[] = [{ x: adj.x, y: adj.y }];
                    if (!adj.isManual && adj.bIdx !== undefined && buildings[adj.bIdx]) {
                        const poly = buildings[adj.bIdx];
                        for (const p of poly) positions.push({ x: p.x, y: p.y }); // 모서리 꼭짓점 Attractor
                        for (const t of [0.25, 0.5, 0.75, 1.0]) { // victim 방향 보행점(Interpolation Step)
                            let wp = { x: adj.x + (cand.v.x - adj.x) * t, y: adj.y + (cand.v.y - adj.y) * t };
                            if (!pointInPolygon(wp, poly)) wp = snapToPolygonEdge(wp, poly); // 경계 밖 유출 시 강제 스냅
                            positions.push(wp);
                        }
                    }
                    const seenPos = new Set<string>();
                    const uniquePositions = positions.filter(p => {
                        const k = `${Math.round(p.x)},${Math.round(p.y)}`;
                        if (seenPos.has(k)) return false;
                        seenPos.add(k);
                        return true;
                    });

                    for (const pos of uniquePositions) {
                        // 셀프 차폐 방지: 옥상 테두리점 출발 레이는 isCandidate 플래그 명시
                        const posPoint = { x: pos.x, y: pos.y, bIdx: adj.bIdx, isCandidate: adj.bIdx !== undefined };
                        const movedAngles = adj.eqs.map(eq => eq.angle);

                        // 이동한 기존 섹터들이 열린 샘플을 커버하는지 평가
                        const coveredByPlan = new Uint8Array(openIdxs.length);
                        for (let oi = 0; oi < openIdxs.length; oi++) {
                            const s = allSamples[openIdxs[oi]];
                            if (adj.bIdx !== undefined && adj.bIdx === s.line.bIdx) continue;
                            for (const ang of movedAngles) {
                                if (evaluateRay(posPoint, ang, s, params, buildings) > 0.05) { coveredByPlan[oi] = 1; break; }
                            }
                        }

                        // [Step 3] Target Vector Azimuth Aiming — θ = atan2 역산 + ±15° 미세 튜닝 세트
                        const aimAngles: number[] = [];
                        for (const c of centroids) {
                            const theta = (Math.atan2(c.y - pos.y, c.x - pos.x) * 180 / Math.PI + 90 + 360) % 360;
                            for (const off of [0, -5, 5, -10, 10, -15, 15]) {
                                aimAngles.push(Math.round(theta + off + 360) % 360);
                            }
                        }

                        // 여유 슬롯만큼 최대 이득 각도를 그리디 선택 (60° 이격 준수)
                        const pickedAngles: number[] = [];
                        for (let slot = 0; slot < slots; slot++) {
                            let bestAng = -1, bestGain = 0, bestList: number[] = [];
                            for (const ang of aimAngles) {
                                if (!isValidSectorSeparation(ang, [...movedAngles, ...pickedAngles])) continue;
                                let gain = 0;
                                const list: number[] = [];
                                for (let oi = 0; oi < openIdxs.length; oi++) {
                                    if (coveredByPlan[oi]) continue;
                                    const s = allSamples[openIdxs[oi]];
                                    if (adj.bIdx !== undefined && adj.bIdx === s.line.bIdx) continue;
                                    if (evaluateRay(posPoint, ang, s, params, buildings) > 0.05) {
                                        gain += getWeight(s);
                                        list.push(oi);
                                    }
                                }
                                if (gain > bestGain) { bestGain = gain; bestAng = ang; bestList = list; }
                            }
                            if (bestAng === -1 || bestGain <= 0) break;
                            pickedAngles.push(bestAng);
                            for (const oi of bestList) coveredByPlan[oi] = 1;
                        }

                        // 계획 총점 = 고정 장비 점수 + (이동 섹터 + 신규 조준 섹터)가 확보한 샘플
                        let planScore = fixedEv.score;
                        for (let oi = 0; oi < openIdxs.length; oi++) {
                            if (coveredByPlan[oi]) planScore += getWeight(allSamples[openIdxs[oi]]);
                        }

                        if (planScore >= dietFloor) {
                            // Target Coverage 달성 → Site 전격 삭감 확정!
                            const shiftDist = Math.round(distance(pos, adj));
                            for (const eq of adj.eqs) { eq.x = pos.x; eq.y = pos.y; }
                            const newEqs: Equipment[] = [];
                            const usedSuffixes = adj.eqs.map(eq => eq.id.substring(eq.id.lastIndexOf('-') + 1));
                            const baseId = adj.eqs[0].id.substring(0, adj.eqs[0].id.lastIndexOf('-'));
                            for (const ang of pickedAngles) {
                                const sfx = ['A', 'B', 'C'].find(sf => !usedSuffixes.includes(sf)) || 'X';
                                usedSuffixes.push(sfx);
                                newEqs.push({ id: `${baseId}-${sfx}`, x: pos.x, y: pos.y, angle: ang, bIdx: adj.bIdx, isManual: false });
                            }
                            working = [...fixedEqs, ...adj.eqs, ...newEqs];
                            baseline = evalCoverage(working);
                            logs.push({
                                id: 'DIET-MERGE', x: Math.round(pos.x), y: Math.round(pos.y), angle: pickedAngles[0] ?? movedAngles[0] ?? 0,
                                score: Math.round(baseline.score * 100) / 100, coveredCount: lostIdxs.length,
                                message: `[사이트 통합] 사이트 (${Math.round(cand.v.x)}, ${Math.round(cand.v.y)})를 (${Math.round(adj.x)}, ${Math.round(adj.y)})로 통합 흡수 (커버율 ${pct(baseline.score)}% 유지)`
                            });
                            mergeDone = true;
                            break;
                        }
                    }
                    if (mergeDone) break;
                }
                if (mergeDone) { dietChanged = true; break; }
            }
        }

        // [Phase 2.7] 비효율 섹터 컷 (TODO 2): 1차 고유 기여 ~0m + 2차 고유 기여 0m 섹터 삭감
        const uniqueSecondCover = (eq: Equipment, eqs: Equipment[]) => {
            let count = 0;
            for (const s2 of secondSamples) {
                if (eq.bIdx !== undefined && eq.bIdx === s2.line.bIdx) continue;
                if (evaluateRay(eq, eq.angle, s2, params, buildings) <= 0.05) continue;
                let othersCover = false;
                for (const other of eqs) {
                    if (other === eq) continue;
                    if (other.bIdx !== undefined && other.bIdx === s2.line.bIdx) continue;
                    if (evaluateRay(other, other.angle, s2, params, buildings) > 0.05) { othersCover = true; break; }
                }
                if (!othersCover) count++;
            }
            return count;
        };
        for (const eq of working.slice()) {
            if (eq.isManual) continue;
            const rest = working.filter(e => e !== eq);
            const ev = evalCoverage(rest);
            if (ev.score >= baseline.score - 0.5 && ev.score >= dietFloor && uniqueSecondCover(eq, working) < 1) {
                working = rest;
                baseline = ev;
                logs.push({
                    id: 'DIET-CUT', x: Math.round(eq.x), y: Math.round(eq.y), angle: Math.round(eq.angle),
                    score: Math.round(ev.score * 100) / 100, coveredCount: 0,
                    message: `[비효율 섹터 삭감] 기여도가 미미한 섹터 ${eq.id} (${Math.round(eq.x)}, ${Math.round(eq.y)}, 방향 ${Math.round(eq.angle)}°) 삭감 완료`
                });
            }
        }

        const sitesAfter = groupSites(working).length;
        if (sitesAfter !== sitesBefore || working.length !== sectorsBefore) {
            logs.push({
                id: 'DIET-SUMMARY', x: 0, y: 0, angle: 0,
                score: Math.round(baseline.score * 100) / 100, coveredCount: working.length,
                message: `[다이어트 완료] 사이트 최적화: 사이트 ${sitesBefore}개 → ${sitesAfter}개, 섹터 ${sectorsBefore}개 → ${working.length}개 (커버율(1차+0.7×2차): ${pct(baseline.score)}%)`
            });
        }

        equipments.length = 0;
        equipments.push(...working);

        // 커버리지 전면 재산정 — 다이어트 후 최종 장비 세트 기준 샘플/coveredPoints 재할당
        samples.forEach(s => { s.covered = false; });
        secondSamples.forEach(s => { s.covered = false; });
        for (const eq of equipments) eq.coveredPoints = [];
        currentCoveredScore = 0;
        for (const s of samples) {
            let bestEq: Equipment | null = null;
            let bestSc = 0.05;
            for (const eq of equipments) {
                if (eq.bIdx !== undefined && eq.bIdx === s.line.bIdx) continue;
                const sc = evaluateRay(eq, eq.angle, s, params, buildings);
                if (sc > bestSc) { bestSc = sc; bestEq = eq; }
            }
            if (bestEq) {
                s.covered = true;
                currentCoveredScore += getWeight(s);
                bestEq.coveredPoints!.push({ x: s.x, y: s.y });
            }
        }
        for (const s2 of secondSamples) {
            let bestEq: Equipment | null = null;
            let bestSc = 0.05;
            for (const eq of equipments) {
                if (eq.bIdx !== undefined && eq.bIdx === s2.line.bIdx) continue;
                const sc = evaluateRay(eq, eq.angle, s2, params, buildings);
                if (sc > bestSc) { bestSc = sc; bestEq = eq; }
            }
            if (bestEq) {
                s2.covered = true;
                currentCoveredScore += getWeight(s2); // 2차는 0.7 가중 (지표 통일)
                bestEq.coveredPoints!.push({ x: s2.x, y: s2.y });
            }
        }
    }

    // [J] Phase 3.5: 기존 사이트에 2차 베란다용 여분 섹터 추가 (규칙 5)
    // "first 베란다를 지향하는 위치에서 sector 추가는 가능"
    if (allowSecondVerandaSectors) {
        const sitesMap = new Map<string, { x: number, y: number, bIdx?: number, angles: number[], eqIds: string[] }>();
        for (const eq of equipments) {
            const key = `${eq.x},${eq.y}`;
            if (!sitesMap.has(key)) {
                sitesMap.set(key, { x: eq.x, y: eq.y, bIdx: eq.bIdx, angles: [], eqIds: [] });
            }
            const site = sitesMap.get(key)!;
            site.angles.push(eq.angle);
            site.eqIds.push(eq.id);
        }

        // [Step 4] Worst Building SAVIOR Sector — 2차 베란다 커버 수율 꼴등 건물 우선 구제
        // 살아남은 사이트 중 슬롯 여유(Sector < 3)가 있고 꼴등 건물을 지향 가능한 곳에 보너스 섹터 장착
        {
            const worstStats = new Map<number, { covered: number; total: number }>();
            for (const s2 of secondSamples) {
                const bId = s2.line.bIdx ?? -1;
                if (bId === -1) continue;
                const st = worstStats.get(bId) || { covered: 0, total: 0 };
                st.total++;
                if (s2.covered) st.covered++;
                worstStats.set(bId, st);
            }
            // 꼴등 건물부터 시도, 기하 제약(사거리/이격/차폐)으로 무산되면 차순위 건물 fallback
            const worstOrder = Array.from(worstStats.entries())
                .filter(([, st]) => st.total > 0 && st.covered < st.total)
                .map(([bId, st]) => ({ bId, ratio: st.covered / st.total }))
                .sort((a, b) => a.ratio - b.ratio);
            for (const { bId: worstB, ratio: worstRatio } of worstOrder) {
                const targets: number[] = [];
                let cx = 0, cy = 0;
                for (let i = 0; i < secondSamples.length; i++) {
                    const s2 = secondSamples[i];
                    if (!s2.covered && s2.line.bIdx === worstB) {
                        targets.push(i);
                        cx += s2.x; cy += s2.y;
                    }
                }
                if (targets.length > 0) {
                    cx /= targets.length; cy /= targets.length;
                    let bestSite: { x: number, y: number, bIdx?: number, angles: number[], eqIds: string[] } | null = null;
                    let bestAngle = -1, bestScore = 0;
                    let bestIdxs: number[] = [];
                    for (const site of sitesMap.values()) {
                        if (site.angles.length >= 3) continue; // Step 1: 슬롯 마진 체크
                        if (site.bIdx !== undefined && site.bIdx === worstB) continue; // 자기 건물 서비스 불가
                        // Target Vector Azimuth: 꼴등 건물 미커버 2차 베란다 중심점 역산 조준
                        const theta = (Math.atan2(cy - site.y, cx - site.x) * 180 / Math.PI + 90 + 360) % 360;
                        for (const off of [0, -5, 5, -10, 10, -15, 15]) {
                            const ang = Math.round(theta + off + 360) % 360;
                            let sepOk = true;
                            for (const existing of site.angles) {
                                let diff = Math.abs(ang - existing);
                                diff = diff > 180 ? 360 - diff : diff;
                                if (diff < 60) { sepOk = false; break; }
                            }
                            if (!sepOk) continue;
                            let score = 0;
                            const idxs: number[] = [];
                            for (const ti of targets) {
                                const rayScore = evaluateRay(site, ang, secondSamples[ti], params, buildings);
                                if (rayScore > 0.05) { score += rayScore; idxs.push(ti); }
                            }
                            if (score > bestScore) {
                                bestScore = score;
                                bestAngle = ang;
                                bestSite = site;
                                bestIdxs = idxs;
                            }
                        }
                    }
                    if (bestSite && bestAngle !== -1 && bestIdxs.length > 0) {
                        bestSite.angles.push(bestAngle);
                        const existingSuffixes = bestSite.eqIds.map(id => id.substring(id.lastIndexOf('-') + 1));
                        const missingSuffix = ['A', 'B', 'C'].find(sf => !existingSuffixes.includes(sf)) || 'X';
                        const baseNodeId = bestSite.eqIds[0].substring(0, bestSite.eqIds[0].lastIndexOf('-'));
                        const eqId = `${baseNodeId}-${missingSuffix}`;
                        bestSite.eqIds.push(eqId);
                        equipments.push({
                            id: eqId,
                            x: bestSite.x,
                            y: bestSite.y,
                            angle: bestAngle,
                            bIdx: bestSite.bIdx,
                            coveredPoints: bestIdxs.map(ti => ({ x: secondSamples[ti].x, y: secondSamples[ti].y })),
                            isManual: false
                        });
                        for (const ti of bestIdxs) { secondSamples[ti].covered = true; currentCoveredScore += getWeight(secondSamples[ti]); }
                        logs.push({
                            id: eqId,
                            x: Math.round(bestSite.x), y: Math.round(bestSite.y), angle: bestAngle,
                            score: Math.round(bestScore * 100) / 100, coveredCount: bestIdxs.length,
                            message: `[음영 구조 섹터] 취약 건물 #${worstB + 1} 구조를 위해 Site (${Math.round(bestSite.x)}, ${Math.round(bestSite.y)})에 ${eqId} 섹터 (방향 ${bestAngle}°) 추가 투입 (2차 ${bestIdxs.length}m 확보)`
                        });
                        break; // 꼴등 건물 구제 성공 → SAVIOR 1회로 종료
                    }
                }
            }
        }

        // [CAPEX 게이트 2026-09-05] 일반 2차 확장 섹터는 통합 커버율(1차+0.7×2차)이 목표 미달일 때만 투입.
        // (SAVIOR는 규칙 5 꼴등 건물 구제 목적이라 게이트 없이 1회 유지)
        if (currentCoveredScore >= targetCoveredScore) {
            logs.push({
                id: 'EXPAND-SKIP', x: 0, y: 0, angle: 0, score: Math.round(currentCoveredScore * 100) / 100, coveredCount: 0,
                message: `[2차 확장 생략] 통합 커버율 ${pct(currentCoveredScore)}% ≥ 목표 ${params.targetCoverage}% — 추가 2차 확장 섹터 투입 안 함`
            });
        }
        for (const site of sitesMap.values()) {
            while (site.angles.length < 3 && currentCoveredScore < targetCoveredScore) {
                let bestAngle = -1;
                let bestScore = 0;
                let bestCoveredIndices: number[] = [];

                for (let aIdx = 0; aIdx < 36; aIdx++) {
                    const angle = aIdx * 10;
                    // 기존 각도와 60° 이상 차이나는 방향만 허용
                    let isAllowed = true;
                    for (const existingAngle of site.angles) {
                        let diff = Math.abs(angle - existingAngle);
                        diff = diff > 180 ? 360 - diff : diff;
                        if (diff < 60) {
                            isAllowed = false;
                            break;
                        }
                    }
                    if (!isAllowed) continue;

                    let score = 0;
                    const coveredIndices: number[] = [];
                    for (let i = 0; i < secondSamples.length; i++) {
                        const sample = secondSamples[i];
                        if (sample.covered) continue;
                        if (site.bIdx !== undefined && site.bIdx === sample.line.bIdx) continue;
                        const rayScore = evaluateRay(site, angle, sample, params, buildings);
                        if (rayScore > 0.05) {
                            score += rayScore;
                            coveredIndices.push(i);
                        }
                    }
                    if (score > bestScore) {
                        bestScore = score;
                        bestAngle = angle;
                        bestCoveredIndices = coveredIndices;
                    }
                }

                // [CAPEX] 비효율 증설 차단: 유의미한 2차 커버(>2m 상당)를 확보할 때만 보너스 섹터 추가
                if (bestScore > 2 && bestAngle !== -1) {
                    // 1° 단위로 정제 (동일 Site 기존 섹터들과 최소 60° 이격 유도)
                    let refinedAngle = bestAngle;
                    let maxRefinedScore = -1;
                    for (let offset = -10; offset <= 10; offset += 1) {
                        const testAngle = (bestAngle + offset + 360) % 360;

                        let isValidAngle = true;
                        for (const existingAngle of site.angles) {
                            let diff = Math.abs(testAngle - existingAngle);
                            diff = diff > 180 ? 360 - diff : diff;
                            if (diff < 60) {
                                isValidAngle = false;
                                break;
                            }
                        }
                        if (!isValidAngle) continue;

                        let rScore = 0;
                        for (const idx of bestCoveredIndices) {
                            const rayScore = evaluateRay(site, testAngle, secondSamples[idx], params, buildings);
                            if (rayScore > 0.05) rScore += rayScore;
                        }
                        if (rScore > maxRefinedScore) {
                            maxRefinedScore = rScore;
                            refinedAngle = testAngle;
                        }
                    }

                    site.angles.push(refinedAngle);

                    const existingSuffixes = site.eqIds.map(id => id.substring(id.lastIndexOf('-') + 1));
                    const missingSuffix = ['A', 'B', 'C'].find(s => !existingSuffixes.includes(s)) || 'X';
                    const baseNodeId = site.eqIds[0].substring(0, site.eqIds[0].lastIndexOf('-'));
                    const eqId = `${baseNodeId}-${missingSuffix}`;

                    site.eqIds.push(eqId);
                    const coveredPoints = bestCoveredIndices.map(idx => ({ x: secondSamples[idx].x, y: secondSamples[idx].y }));

                    equipments.push({
                        id: eqId,
                        x: site.x,
                        y: site.y,
                        angle: refinedAngle,
                        bIdx: site.bIdx,
                        coveredPoints: coveredPoints,
                        isManual: false
                    });

                    logs.push({
                        id: eqId,
                        x: Math.round(site.x),
                        y: Math.round(site.y),
                        angle: refinedAngle,
                        score: Math.round(maxRefinedScore * 100) / 100,
                        coveredCount: bestCoveredIndices.length,
                        message: `[2차 확장 섹터] 2차 베란다 확장을 위해 Site (${Math.round(site.x)}, ${Math.round(site.y)})에 ${eqId} 섹터 (방향 ${refinedAngle}°) 추가 투입 (2차 ${bestCoveredIndices.length}m 확보, 누적 ${pct(currentCoveredScore)}%)`
                    });

                    for (const idx of bestCoveredIndices) {
                        secondSamples[idx].covered = true;
                        currentCoveredScore += getWeight(secondSamples[idx]);
                    }
                } else {
                    break;
                }
            }
        }
    }

    // Phase 3: 2차 베란다 RF 투과 전수 평가 (배치된 수동/자동 모든 장비의 빔이 2차 베란다에 도달하는지 조사)
    for (const sample of secondSamples) {
        if (sample.covered) continue;
        for (const eq of equipments) {
            if (eq.bIdx !== undefined && eq.bIdx === sample.line.bIdx) continue;
            const score = evaluateRay(eq, eq.angle, sample, params, buildings);
            if (score > 0.05) {
                sample.covered = true;
                break;
            }
        }
    }

    // [K] buildingCoverages — min(100%, (1차 커버길이 + 0.7×2차 커버길이) / 1차 전체길이 * 100)
    const buildingCoverages: {
        bIdx: number;
        ratio: number;
        covered: number;
        total: number;
        secondCovered?: number;
        secondTotal?: number;
    }[] = [];

    buildings.forEach((b, idx) => {
        const bSamples = samples.filter(s => s.line.bIdx === idx && !s.line.isSecond);
        const bSecondSamples = secondSamples.filter(s => s.line.bIdx === idx);

        if (bSamples.length > 0 || bSecondSamples.length > 0) {
            const total1st = bSamples.length;
            const covered1st = bSamples.filter(s => s.covered).length;
            const total2nd = bSecondSamples.length;
            const covered2nd = bSecondSamples.filter(s => s.covered).length;

            const combinedCovered = covered1st + covered2nd * SECOND_VERANDA_WEIGHT; // 2차는 0.7 가중 (지표 통일)
            const ratioVal = total1st > 0
                ? Math.min(100, (combinedCovered / total1st) * 100)
                : (total2nd > 0 ? Math.min(100, (covered2nd / total2nd) * 100) : 0);

            buildingCoverages.push({
                bIdx: idx,
                total: total1st,
                covered: covered1st,
                ratio: ratioVal,
                secondCovered: covered2nd,
                secondTotal: total2nd
            });
        }
    });

    // [L] coverageRatio 최종 계산 — min(100%, (1차 커버 + 0.7×2차 커버) / 1차 전체 모수 * 100)  ※ 루프 목표·다이어트와 동일 정의
    const total1stCount = samples.length; // 1차 베란다 전체 길이 (모수)
    const covered1stCount = samples.filter(s => s.covered && !s.line.isSecond).length;
    const covered2ndCount = secondSamples.filter(s => s.covered).length;
    const combinedTotalCovered = covered1stCount + covered2ndCount * SECOND_VERANDA_WEIGHT; // 2차는 0.7 가중 (지표 통일)

    const defaultRatio = total1stCount > 0
        ? Math.min(100, (combinedTotalCovered / total1stCount) * 100)
        : 0;
    const defaultCovered = samples.filter(s => s.covered && !s.line.isSecond).map(s => ({ x: s.x, y: s.y }));
    const defaultSecondCovered = secondSamples.filter(s => s.covered).map(s => ({ x: s.x, y: s.y }));

    // Rank 1~5 결과 세트 보강 생성
    const rankResults: Record<number, RankResult> = {};
    [1, 2, 3, 4, 5].forEach(r => {
        rankResults[r] = buildRankResult(
            r,
            initialEquipments,
            allCandidateSites,
            buildings,
            firstVerandas,
            secondVerandas,
            params,
            equipments,
            defaultRatio,
            defaultCovered,
            defaultSecondCovered,
            buildingCoverages
        );
    });

    // [탐색 요약] RESULTS 카드·로그용 한 문장
    const searchCases = searchPointScans * 36;
    const searchSummary = {
        buildings: buildings.length,
        points: candidatePoints.length,
        iterations: searchIterations,
        directions: 36,
        cases: searchCases,
        rays: searchRays,
        stepMeters: stepM,
    };
    if (allowAutoSites) {
        logs.push({
            id: 'SEARCH-SUMMARY', x: 0, y: 0, angle: 0, score: 0, coveredCount: searchCases,
            message: `[탐색 요약] 건물 ${buildings.length}개동 옥상 테두리 ${candidatePoints.length}개 포인트(${stepM}m 간격) 분석, 포인트별 ${searchIterations}회 × 36방향 시뮬레이션으로 총 ${searchCases.toLocaleString()}개 케이스(레이 ${searchRays.toLocaleString()}회) 분석 완료`
        });
    }

    return {
        equipments,
        coverageRatio: defaultRatio,
        searchSummary,
        existingCoverageRatio: total1stCount > 0
            ? Math.min(100, (existingCovered1stCount / total1stCount) * 100)
            : 0,
        existingAntennaCount,
        coveredSamples: defaultCovered,
        secondCoveredSamples: defaultSecondCovered,
        logs,
        buildingCoverages,
        candidateSites: allCandidateSites,
        rankResults
    };
}

function buildRankResult(
    rank: number,
    initialEquipments: Equipment[],
    allCandidateSites: CandidateSite[],
    buildings: Polygon[],
    firstVerandas: Line[],
    secondVerandas: Line[],
    params: SimulationParams,
    defaultEquipments: Equipment[],
    defaultRatio: number,
    defaultCovered: Point[],
    defaultSecondCovered: Point[],
    defaultBuildingCoverages: any[]
): RankResult {
    if (rank === 1 || allCandidateSites.length === 0) {
        return {
            rank,
            equipments: defaultEquipments,
            coverageRatio: defaultRatio,
            coveredSamples: defaultCovered,
            secondCoveredSamples: defaultSecondCovered,
            buildingCoverages: defaultBuildingCoverages
        };
    }

    const iterations = Array.from(new Set(allCandidateSites.map(c => c.iterationIdx))).sort((a, b) => a - b);
    const rankEquipments: Equipment[] = [...initialEquipments];

    iterations.forEach(iterIdx => {
        const iterCandidates = allCandidateSites.filter(c => c.iterationIdx === iterIdx);
        const chosen = iterCandidates.find(c => c.rank === rank) || iterCandidates[0];
        if (chosen) {
            chosen.angles.forEach((angle, idx) => {
                const sectorChar = String.fromCharCode(65 + idx);
                rankEquipments.push({
                    id: `AUTO-R${rank}-${iterIdx}-${sectorChar}`,
                    x: chosen.x,
                    y: chosen.y,
                    angle: angle,
                    bIdx: chosen.bIdx,
                    isManual: false
                });
            });
        }
    });

    const stepSize = Math.max(1, Math.round(params.pixelsPerMeter || 1));
    const samples: { x: number; y: number; line: Line; covered: boolean; weight: number }[] = [];
    const secondSamples: { x: number; y: number; line: Line; covered: boolean; weight: number }[] = [];

    firstVerandas.forEach(v => {
        const dist = distance(v.start, v.end);
        const steps = Math.ceil(dist / stepSize);
        for (let j = 0; j <= steps; j++) {
            const t = steps === 0 ? 0 : j / steps;
            samples.push({
                x: v.start.x + (v.end.x - v.start.x) * t,
                y: v.start.y + (v.end.y - v.start.y) * t,
                line: v,
                covered: false,
                weight: 1.0
            });
        }
    });

    secondVerandas.forEach(v => {
        const dist = distance(v.start, v.end);
        const steps = Math.ceil(dist / stepSize);
        for (let j = 0; j <= steps; j++) {
            const t = steps === 0 ? 0 : j / steps;
            secondSamples.push({
                x: v.start.x + (v.end.x - v.start.x) * t,
                y: v.start.y + (v.end.y - v.start.y) * t,
                line: v,
                covered: false,
                weight: SECOND_VERANDA_WEIGHT
            });
        }
    });

    rankEquipments.forEach(eq => {
        const eqPoint: Point & { bIdx?: number } = { x: eq.x, y: eq.y, bIdx: eq.bIdx };
        samples.forEach(s => {
            if (!s.covered) {
                if (evaluateRay(eqPoint, eq.angle, s, params, buildings) > 0.05) {
                    s.covered = true;
                }
            }
        });
        secondSamples.forEach(s => {
            if (!s.covered) {
                if (evaluateRay(eqPoint, eq.angle, s, params, buildings) > 0.05) {
                    s.covered = true;
                }
            }
        });
    });

    const total1stCount = samples.length;
    const covered1stCount = samples.filter(s => s.covered && !s.line.isSecond).length;
    const covered2ndCount = secondSamples.filter(s => s.covered).length;
    const combinedTotalCovered = covered1stCount + covered2ndCount * SECOND_VERANDA_WEIGHT; // 2차는 0.7 가중 (지표 통일)
    const coverageRatio = total1stCount > 0
        ? Math.min(100, (combinedTotalCovered / total1stCount) * 100)
        : 0;

    const bCoverages: any[] = [];
    buildings.forEach((b, idx) => {
        const bSamples = samples.filter(s => s.line.bIdx === idx && !s.line.isSecond);
        const bSecondSamples = secondSamples.filter(s => s.line.bIdx === idx);

        if (bSamples.length > 0 || bSecondSamples.length > 0) {
            const total1st = bSamples.length;
            const covered1st = bSamples.filter(s => s.covered).length;
            const total2nd = bSecondSamples.length;
            const covered2nd = bSecondSamples.filter(s => s.covered).length;

            const combinedCovered = covered1st + covered2nd * SECOND_VERANDA_WEIGHT; // 2차는 0.7 가중 (지표 통일)
            const ratioVal = total1st > 0
                ? Math.min(100, (combinedCovered / total1st) * 100)
                : (total2nd > 0 ? Math.min(100, (covered2nd / total2nd) * 100) : 0);

            bCoverages.push({
                bIdx: idx,
                total: total1st,
                covered: covered1st,
                ratio: ratioVal,
                secondCovered: covered2nd,
                secondTotal: total2nd
            });
        }
    });

    return {
        rank,
        equipments: rankEquipments,
        coverageRatio,
        coveredSamples: samples.filter(s => s.covered).map(s => ({ x: s.x, y: s.y })),
        secondCoveredSamples: secondSamples.filter(s => s.covered).map(s => ({ x: s.x, y: s.y })),
        buildingCoverages: bCoverages
    };
}

