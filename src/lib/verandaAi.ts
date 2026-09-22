import { Point, Line, Polygon } from '../types';

/**
 * ============================================================================
 * AI 베란다 자동 세팅 엔진 v2 (챌린지 리뷰 반영판)
 * ----------------------------------------------------------------------------
 * v1 대비 핵심 변경 (근거: docs/00-pm/veranda_ai_challenge_review.md):
 *  1) [BUG FIX] 캔버스 비등방 왜곡 보정
 *     - App.tsx toCanvas()는 lon/lat을 각각 캔버스 폭/높이에 독립 정규화하므로
 *       각도·종횡비가 단지마다 다르게 왜곡됨. metersPerPx 옵션으로 미터 복원.
 *  2) [BUG FIX] 판상형 게이트 교체: 주축 집중도 R>=0.6 은 순수 직사각형 기준
 *       종횡비 4:1 과 등가 (R=(L-W)/(L+W)) → 실제 판상형의 92%가 타워 로직으로
 *       빠져 마구리가 베란다로 오분류되던 원인. → 최소면적 OBB(fill+aspect) 기반.
 *  3) [NEW] RDP 기반 Collinear 매크로엣지 병합 (advanced 문서 4.2의 미구현 항목)
 *     - 동일 벽면이 미세 요철로 쪼개져 first/second가 교차하던 문제 해소.
 *  4) [NEW] 타워형 날개 마구리(cap) 격리: 양측 볼록 코너 + 내부 관통깊이 조건.
 *  5) [NEW] 배면-전면 페어링: 배면 벽은 내부로 세대 깊이(depth) 이내에서 1차
 *       베란다와 마주볼 때만 2차 베란다. (Y형 실측 GT: V자 요입부만 2차,
 *       날개 바깥 배면/마구리는 콘크리트)
 *  6) [NEW] 1m 미만 선분 drop 제거(병합에 포함) + 저층 부속동 마스킹 옵션.
 * ============================================================================
 */

export const VERANDA_AI_VERSION = 'verandaAi-v2.2';

export type ClassifiedWall = {
    p1: Point;
    p2: Point;
    length: number;        // 미터 (metersPerPx 미지정 시 입력 단위)
    azimuth: number;       // 0=북, 90=동, 180=남, 270=서
    sunScore: number;
    wallType: 'first' | 'second' | 'concrete';
    reason?: string;       // 판정 사유 (검증 뷰어/툴팁용)
};

export type VerandaAiOptions = {
    /** 캔버스 px -> 미터 환산 (x축). 미지정 시 1 (입력좌표=미터 가정) */
    metersPerPxX?: number;
    /** 캔버스 px -> 미터 환산 (y축). 미지정 시 metersPerPxX 값 */
    metersPerPxY?: number;
    /** true면 건물 전체를 콘크리트 처리 (저층 부속동 마스킹) */
    forceConcrete?: boolean;
    rdpEps?: number;        // collinear 병합 허용 오차 (m), default 1.2
    smallFace?: number;     // 이하 매크로면 콘크리트 (m), default 3.5
    capTurn?: number;       // cap 코너 최소 회전각 (deg), default 45
    capLenMax?: number;     // cap 최대 길이 (m), default 17
    capDepthRatio?: number; // cap 내부 관통깊이/길이 최소비, default 1.5
    sunBand?: number;       // first 문턱 (sunScore >= band), default 0.0 (스펙 60~240도)
                            // 주의: 밴드를 올리면 az233~240 남서면이 동별로 first 탈락 -> 페어링 연쇄 실패 (2206-3699 사례)
    relBand?: number;       // 경계 상대판정 밴드, default 0.15. |sunScore| < relBand 인 장벽은 절대 부호 대신
                            // 마주보는 장벽과 sunScore를 비교해 더 수광적인 쪽을 first로 판정.
                            // 60/240° 경계에 걸친 단지(1908-4586)에서 0.9° 방위 지터로 동일 유형 건물이
                            // first↔concrete로 갈리던 나이프엣지 대응. (3단지+전수 회귀 검증 완료)
    perpCap?: boolean;      // 수직 마구리(perp-cap) 규칙, default true. 자기보다 1.3배 이상 긴 first 벽과
                            // 수직(75~105°)·볼록으로 인접하고, 내부 관통 깊이가 depthMax를 넘는(=뒤에 세대가
                            // 없는) 길이 capLenMax 이하 first 벽을 슬래브 스트립의 마구리로 보아 concrete 처리.
                            // 날개 측면은 관통 깊이가 날개폭(<=depthMax)이라 보호됨.
                            // (Y형 "몸통부 측면=콘크리트, 날개 측면=베란다" 실측 GT 반영. 전수 회귀 상세는
                            // docs/00-pm/veranda_ai_challenge_review.md 참고)
    depthMax?: number;      // 배면-전면 페어링 최대 세대 깊이 (m), default 17
    endWallAng?: number;    // 판상형 단축 격리 각 (deg), default 35
    slabFill?: number;      // OBB 채움비 기준, default 0.70
    slabAspect?: number;    // OBB 종횡비 기준, default 2.0
    sunAzimuth?: number;    // 최적 수광 방위각, default 150
};

type GeoMapping = {
    minLon: number; minLat: number;
    lonRange: number; latRange: number;
    cWidth: number; cHeight: number;
};

/** App.tsx의 geoMapping 상태로부터 metersPerPx 옵션 산출 (toCanvas 역변환) */
export function metersPerPxFromGeoMapping(m: GeoMapping): { metersPerPxX: number; metersPerPxY: number } {
    const midLat = m.minLat + m.latRange / 2;
    const M_PER_DEG_LAT = 111320;
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
    return {
        metersPerPxX: (m.lonRange * mPerDegLon) / (m.cWidth * 0.8),
        metersPerPxY: (m.latRange * M_PER_DEG_LAT) / (m.cHeight * 0.8),
    };
}

/**
 * 단지 폴리곤(보라색) 내부에 점이 포함되는지 판정 (Ray Casting)
 */
export function isPointInPolygon(p: Point, poly: Polygon): boolean {
    const n = poly.length;
    let inside = false;
    let p1 = poly[0];
    for (let i = 0; i <= n; i++) {
        const p2 = poly[i % n];
        if (p.y > Math.min(p1.y, p2.y)) {
            if (p.y <= Math.max(p1.y, p2.y)) {
                if (p.x <= Math.max(p1.x, p2.x)) {
                    if (p1.y !== p2.y) {
                        const xinters = (p.y - p1.y) * (p2.x - p1.x) / (p2.y - p1.y) + p1.x;
                        if (p1.x === p2.x || p.x <= xinters) {
                            inside = !inside;
                        }
                    }
                }
            }
        }
        p1 = p2;
    }
    return inside;
}

// ---------------------------------------------------------------------------
// 내부 기하 유틸 (미터 좌표계: +x 동, +y 북)
// ---------------------------------------------------------------------------
type Pt = { x: number; y: number };

function angDiff(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
}

function polyAreaSigned(pts: Pt[]): number {
    const n = pts.length;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return s * 0.5; // CCW > 0
}

function convexHull(pts: Pt[]): Pt[] {
    const P = [...new Map(pts.map(p => [`${p.x},${p.y}`, p])).values()]
        .sort((a, b) => (a.x - b.x) || (a.y - b.y));
    if (P.length < 3) return P;
    const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: Pt[] = [];
    for (const p of P) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: Pt[] = [];
    for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

type Obb = { long: number; short: number; longAxisDeg: number; area: number };

function minAreaObb(pts: Pt[]): Obb | null {
    const hull = convexHull(pts);
    if (hull.length < 3) return null;
    let best: { area: number; w: number; h: number; ang: number } | null = null;
    const m = hull.length;
    for (let i = 0; i < m; i++) {
        const a = hull[i], b = hull[(i + 1) % m];
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        const ux = dx / L, uy = dy / L;
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const p of hull) {
            const u = p.x * ux + p.y * uy;
            const v = -p.x * uy + p.y * ux;
            if (u < minU) minU = u; if (u > maxU) maxU = u;
            if (v < minV) minV = v; if (v > maxV) maxV = v;
        }
        const w = maxU - minU, h = maxV - minV;
        if (!best || w * h < best.area) {
            const ang = (Math.atan2(uy, ux) * 180 / Math.PI + 180) % 180;
            best = { area: w * h, w, h, ang };
        }
    }
    if (!best) return null;
    if (best.w >= best.h) {
        return { long: best.w, short: best.h, longAxisDeg: best.ang, area: best.area };
    }
    return { long: best.h, short: best.w, longAxisDeg: (best.ang + 90) % 180, area: best.area };
}

/** open chain RDP 단순화: 유지 인덱스 반환 */
function rdpIndices(chain: Pt[], eps: number): number[] {
    if (chain.length < 3) return chain.map((_, i) => i);
    const keep = new Set<number>([0, chain.length - 1]);
    const stack: [number, number][] = [[0, chain.length - 1]];
    while (stack.length) {
        const [i0, i1] = stack.pop()!;
        if (i1 <= i0 + 1) continue;
        const x0 = chain[i0].x, y0 = chain[i0].y;
        const dx = chain[i1].x - x0, dy = chain[i1].y - y0;
        const L = Math.hypot(dx, dy);
        let dmax = -1, imax = -1;
        for (let i = i0 + 1; i < i1; i++) {
            const px = chain[i].x, py = chain[i].y;
            const d = L < 1e-9
                ? Math.hypot(px - x0, py - y0)
                : Math.abs(dy * (px - x0) - dx * (py - y0)) / L;
            if (d > dmax) { dmax = d; imax = i; }
        }
        if (dmax > eps) {
            keep.add(imax);
            stack.push([i0, imax], [imax, i1]);
        }
    }
    return [...keep].sort((a, b) => a - b);
}

/** 닫힌 링 단순화: 최원점 쌍 앵커 + 체인별 RDP */
function simplifyRing(pts: Pt[], eps: number): number[] {
    const n = pts.length;
    const hull = convexHull(pts);
    let pa = hull[0] || pts[0], pb = hull[1 % hull.length] || pts[1 % n], bestD = -1;
    for (let i = 0; i < hull.length; i++) {
        for (let j = i + 1; j < hull.length; j++) {
            const d = (hull[i].x - hull[j].x) ** 2 + (hull[i].y - hull[j].y) ** 2;
            if (d > bestD) { bestD = d; pa = hull[i]; pb = hull[j]; }
        }
    }
    const nearest = (q: Pt) => {
        let bi = 0, bd = Infinity;
        for (let k = 0; k < n; k++) {
            const d = (pts[k].x - q.x) ** 2 + (pts[k].y - q.y) ** 2;
            if (d < bd) { bd = d; bi = k; }
        }
        return bi;
    };
    let ia = nearest(pa), ib = nearest(pb);
    if (ia === ib) ib = (ia + Math.floor(n / 2)) % n;
    const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
    const chain1 = pts.slice(lo, hi + 1);
    const chain2 = [...pts.slice(hi), ...pts.slice(0, lo + 1)];
    const keep = new Set<number>();
    rdpIndices(chain1, eps).forEach(i => keep.add(lo + i));
    rdpIndices(chain2, eps).forEach(i => keep.add((hi + i) % n));
    return [...keep].sort((a, b) => a - b);
}

type MacroEdge = {
    i0: number; i1: number; span: number[];
    p1: Pt; p2: Pt;
    length: number; azimuth: number; sunScore: number;
    normal: Pt;
    wallType: 'first' | 'second' | 'concrete' | null;
    reason: string;
};

/**
 * 건물 폴리곤 외벽을 1차 베란다(First) / 2차 베란다(Second) / 콘크리트(Concrete)로 자동 분류
 * - 입력 좌표계: Canvas (+x 동, +y 남). 내부적으로 y 반전 + metersPerPx 환산 후 미터계로 처리.
 */
export function classifyBuildingWalls(
    poly: Polygon,
    opts: VerandaAiOptions = {}
): ClassifiedWall[] {
    const o = {
        metersPerPxX: opts.metersPerPxX ?? 1,
        metersPerPxY: opts.metersPerPxY ?? opts.metersPerPxX ?? 1,
        forceConcrete: opts.forceConcrete ?? false,
        rdpEps: opts.rdpEps ?? 1.2,
        smallFace: opts.smallFace ?? 3.5,
        capTurn: opts.capTurn ?? 45,
        capLenMax: opts.capLenMax ?? 17,
        capDepthRatio: opts.capDepthRatio ?? 1.5,
        sunBand: opts.sunBand ?? 0.0,
        relBand: opts.relBand ?? 0.15,
        perpCap: opts.perpCap ?? true,
        depthMax: opts.depthMax ?? 17,
        endWallAng: opts.endWallAng ?? 35,
        slabFill: opts.slabFill ?? 0.70,
        slabAspect: opts.slabAspect ?? 2.0,
        sunAzimuth: opts.sunAzimuth ?? 150,
    };

    let src = [...poly];
    if (src.length >= 2 &&
        src[0].x === src[src.length - 1].x && src[0].y === src[src.length - 1].y) {
        src = src.slice(0, -1);
    }
    const n = src.length;
    if (n < 3) return [];

    // Canvas(+y 남) -> 미터(+y 북) 변환
    const pts: Pt[] = src.map(p => ({ x: p.x * o.metersPerPxX, y: -p.y * o.metersPerPxY }));

    const area = polyAreaSigned(pts);
    const isCcw = area > 0;

    const obb = minAreaObb(pts);
    if (!obb) return [];
    const fill = obb.area > 0 ? Math.abs(area) / obb.area : 0;
    const aspect = obb.short > 0 ? obb.long / obb.short : 1;
    const isSlab = fill >= o.slabFill && aspect >= o.slabAspect;

    // ---- RDP 매크로엣지 ----
    let keep = simplifyRing(pts, o.rdpEps);
    if (keep.length < 3) keep = pts.map((_, i) => i);
    const M0 = keep.length;

    const macros: MacroEdge[] = [];
    for (let k = 0; k < M0; k++) {
        const i0 = keep[k], i1 = keep[(k + 1) % M0];
        const span: number[] = [];
        let i = i0;
        while (true) {
            span.push(i);
            i = (i + 1) % n;
            if (i === i1 || span.length > n) break;
        }
        const a = pts[i0], b = pts[i1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        const nx = isCcw ? dy / L : -dy / L;
        const ny = isCcw ? -dx / L : dx / L;
        const azimuth = (Math.atan2(nx, ny) * 180 / Math.PI + 360) % 360;
        const sunScore = Math.cos((azimuth - o.sunAzimuth) * Math.PI / 180);
        macros.push({
            i0, i1, span, p1: a, p2: b,
            length: L, azimuth, sunScore,
            normal: { x: nx, y: ny },
            wallType: null, reason: 'pending',
        });
    }
    const M = macros.length;
    if (M === 0) return [];

    // ---- 분류 ----
    if (o.forceConcrete) {
        macros.forEach(e => { e.wallType = 'concrete'; e.reason = 'lowrise_mask'; });
    } else if (isSlab) {
        // Case A: 판상형 - OBB 장축 법선 기준
        const normA = (90 - (obb.longAxisDeg + 90) % 360 + 360) % 360;
        const normB = (normA + 180) % 360;
        const firstNorm = angDiff(normA, o.sunAzimuth) <= angDiff(normB, o.sunAzimuth) ? normA : normB;
        const secondNorm = firstNorm === normA ? normB : normA;
        for (const e of macros) {
            const dF = angDiff(e.azimuth, firstNorm);
            const dS = angDiff(e.azimuth, secondNorm);
            if (Math.min(dF, dS) > o.endWallAng) {
                e.wallType = 'concrete'; e.reason = 'end_wall';
            } else if (e.length <= o.smallFace) {
                e.wallType = 'concrete'; e.reason = 'small_face';
            } else if (dF <= dS) {
                e.wallType = 'first'; e.reason = 'front_axis';
            } else {
                e.wallType = 'second'; e.reason = 'back_axis';
            }
        }
    } else {
        // Case B: 타워형/Y형/L형 - 국소 수광 + cap 격리 + 배면 페어링
        const rayInward = (k: number, t: number = 0.5): { dist: number | null; j: number | null } => {
            const e = macros[k];
            const mx = e.p1.x + (e.p2.x - e.p1.x) * t;
            const my = e.p1.y + (e.p2.y - e.p1.y) * t;
            const dx = -e.normal.x, dy = -e.normal.y;
            const ox = mx + dx * 0.01, oy = my + dy * 0.01;
            let bestT: number | null = null, bestJ: number | null = null;
            for (let j = 0; j < M; j++) {
                if (j === k) continue;
                for (const i of macros[j].span) {
                    const x1 = pts[i].x, y1 = pts[i].y;
                    const x2 = pts[(i + 1) % n].x, y2 = pts[(i + 1) % n].y;
                    const ex = x2 - x1, ey = y2 - y1;
                    const den = dx * ey - dy * ex;
                    if (Math.abs(den) < 1e-12) continue;
                    const t = ((x1 - ox) * ey - (y1 - oy) * ex) / den;
                    const u = ((x1 - ox) * dy - (y1 - oy) * dx) / den;
                    if (t > 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
                        if (bestT === null || t < bestT) { bestT = t; bestJ = j; }
                    }
                }
            }
            return { dist: bestT, j: bestJ };
        };
        const depthIn = macros.map((_, k) => rayInward(k));

        const significantNeighbor = (k: number, step: number): MacroEdge => {
            let j = (k + step + M) % M;
            while (j !== k && macros[j].length <= o.smallFace) j = (j + step + M) % M;
            return macros[j];
        };
        const netConvex = (a: MacroEdge, b: MacroEdge): boolean => {
            const v1x = a.p2.x - a.p1.x, v1y = a.p2.y - a.p1.y;
            const v2x = b.p2.x - b.p1.x, v2y = b.p2.y - b.p1.y;
            const cr = v1x * v2y - v1y * v2x;
            return isCcw ? cr > 0 : cr < 0;
        };

        // 1-pass: small / cap(마구리) / first
        macros.forEach((e, k) => {
            const ps = significantNeighbor(k, -1);
            const ns = significantNeighbor(k, +1);
            const tIn = angDiff(ps.azimuth, e.azimuth);
            const tOut = angDiff(e.azimuth, ns.azimuth);
            const dIn = depthIn[k].dist;
            const isCap =
                tIn >= o.capTurn && tOut >= o.capTurn &&
                netConvex(ps, e) && netConvex(e, ns) &&
                e.length <= o.capLenMax &&
                dIn !== null && dIn >= o.capDepthRatio * e.length;
            if (e.length <= o.smallFace) {
                e.wallType = 'concrete'; e.reason = 'small_face';
            } else if (isCap) {
                e.wallType = 'concrete'; e.reason = 'wing_cap';
            } else if (Math.abs(e.sunScore) < o.relBand) {
                e.reason = 'rel_pending'; // 경계밴드 — 1.5-pass에서 마주보는 벽과 상대판정
            } else if (e.sunScore >= o.sunBand) {
                e.wallType = 'first'; e.reason = 'sun_front';
            }
        });

        // 1.5-pass: 경계밴드 상대판정 — 마주보는 장벽 쌍에서 더 수광적인 쪽 = first.
        // 나이프엣지(60/240° 경계)에서 절대 부호 대신 상대 비교로 동일 유형 건물의 일관성 보장.
        // 마주볼 상대가 없으면(깊이 초과 등) 기존 절대 규칙으로 폴백해 회귀를 막는다.
        macros.forEach((e, k) => {
            if (e.reason !== 'rel_pending') return;
            const { dist, j } = depthIn[k];
            const opp = (j !== null && dist !== null && dist <= o.depthMax) ? macros[j] : null;
            if (opp === null) {
                if (e.sunScore >= o.sunBand) { e.wallType = 'first'; e.reason = 'sun_front'; }
                else { e.wallType = null; e.reason = 'pending'; }
            } else if (opp.wallType === 'first') {
                e.wallType = null; e.reason = 'pending';       // 상대가 명확한 전면 -> 나는 배면
            } else if (e.sunScore > opp.sunScore + 1e-9) {
                e.wallType = 'first'; e.reason = 'rel_front';  // 쌍 중 더 수광적 -> first
            } else if (e.sunScore < opp.sunScore - 1e-9) {
                e.wallType = null; e.reason = 'pending';       // 쌍 중 덜 수광적 -> 배면
            } else {
                if (e.sunScore >= o.sunBand) { e.wallType = 'first'; e.reason = 'sun_front'; }
                else { e.wallType = null; e.reason = 'pending'; }
            }
        });

        // 2-pass: 배면-전면 페어링 (내부 레이 3점 샘플이 depthMax 이내에서 first에 닿아야 second)
        // 중점 1점 레이는 요철/코너에 걸려 같은 단지 동끼리도 결과가 갈림 (2206-3699 사례)
        macros.forEach((e, k) => {
            if (e.wallType !== null) return;
            let paired = false;
            for (const t of [0.5, 0.28, 0.72]) {
                const { dist, j } = t === 0.5 ? depthIn[k] : rayInward(k, t);
                const ptype = j !== null ? macros[j].wallType : null;
                if (ptype === 'first' && dist !== null && dist <= o.depthMax) {
                    paired = true;
                    break;
                }
            }
            if (paired) {
                e.wallType = 'second'; e.reason = 'paired_back';
            } else {
                e.wallType = 'concrete'; e.reason = 'unpaired_back';
            }
        });

        // 3-pass: 코어 샌드위치 흡수 (콘크리트 사이 8m 이하 고립면)
        macros.forEach((e, k) => {
            if ((e.wallType !== 'first' && e.wallType !== 'second') || e.length > 8) return;
            const ps = significantNeighbor(k, -1);
            const ns = significantNeighbor(k, +1);
            if (ps.wallType === 'concrete' && ns.wallType === 'concrete') {
                e.wallType = 'concrete'; e.reason = 'core_sandwich';
            }
        });

        // 3.5-pass: 수직 마구리(perp-cap) — "자기보다 1.3배 이상 긴 first와 수직(75~105°)·볼록으로
        // 인접"하고 "내부 관통 깊이가 depthMax를 넘는(뒤에 세대가 없는)" 짧은 first는 슬래브 스트립의
        // 마구리로 간주 -> concrete. 날개 측면은 관통 깊이 = 날개폭(<=depthMax)이라 보호됨.
        if (o.perpCap) {
            macros.forEach((e, k) => {
                if (e.wallType !== 'first' || e.length > o.capLenMax) return;
                const dIn = depthIn[k].dist;
                if (dIn === null || dIn <= o.depthMax) return; // 뒤에 세대 깊이 있으면 진짜 전면
                for (const step of [-1, 1]) {
                    const nb = significantNeighbor(k, step);
                    const turn = angDiff(e.azimuth, nb.azimuth);
                    const cvx = step === -1 ? netConvex(nb, e) : netConvex(e, nb);
                    if (nb.wallType === 'first' && turn >= 75 && turn <= 105 && cvx && nb.length >= 1.3 * e.length) {
                        e.wallType = 'concrete';
                        e.reason = 'perp_cap';
                        break;
                    }
                }
            });
        }
    }

    // ---- 원본 선분에 매크로 라벨 전파 (Canvas 원좌표로 반환) ----
    const out: ClassifiedWall[] = [];
    for (const e of macros) {
        for (const i of e.span) {
            const a = src[i], b = src[(i + 1) % n];
            const lm = Math.hypot(
                (b.x - a.x) * o.metersPerPxX,
                (b.y - a.y) * o.metersPerPxY
            );
            if (lm < 1e-9) continue;
            out.push({
                p1: a, p2: b, length: lm,
                azimuth: e.azimuth, sunScore: e.sunScore,
                wallType: e.wallType ?? 'concrete',
                reason: e.reason,
            });
        }
    }
    return out;
}

/** 건물별 부가정보 (저층 부속동 마스킹용) */
export type BuildingMeta = { floorsAbove?: number | null; height?: number | null };

export function isLowRise(meta?: BuildingMeta): boolean {
    if (!meta) return false;
    if (meta.floorsAbove !== null && meta.floorsAbove !== undefined) {
        return meta.floorsAbove <= 2;
    }
    if (meta.height !== null && meta.height !== undefined) {
        return meta.height <= 7;
    }
    return false;
}

/**
 * 단지 폴리곤(보라색) 내부 건물들을 필터링하고 전체 베란다 Line[] 목록 자동 생성
 * @param buildingsMeta buildings와 같은 순서의 층수/높이 정보(옵션). 전달 시 저층 부속동(<=2층) 마스킹.
 */
export function generateAutoVerandas(
    buildings: Polygon[],
    complexPolygon?: Polygon | null,
    opts: VerandaAiOptions = {},
    buildingsMeta?: (BuildingMeta | undefined)[]
): { verandas: Line[]; concreteWalls: Line[]; targetBuildings: Polygon[] } {
    const verandas: Line[] = [];
    const concreteWalls: Line[] = [];
    const targetBuildings: Polygon[] = [];

    buildings.forEach((poly, bIdx) => {
        if (poly.length < 3) return;

        let cx = 0, cy = 0;
        poly.forEach(p => { cx += p.x; cy += p.y; });
        cx /= poly.length;
        cy /= poly.length;

        if (complexPolygon && complexPolygon.length >= 3) {
            if (!isPointInPolygon({ x: cx, y: cy }, complexPolygon)) {
                return; // 단지 외부 건물은 제외
            }
        }

        targetBuildings.push(poly);
        const meta = buildingsMeta?.[bIdx];
        const classified = classifyBuildingWalls(poly, {
            ...opts,
            forceConcrete: opts.forceConcrete || isLowRise(meta),
        });

        classified.forEach(w => {
            if (w.wallType === 'first') {
                verandas.push({ start: w.p1, end: w.p2, bIdx, isSecond: false });
            } else if (w.wallType === 'second') {
                verandas.push({ start: w.p1, end: w.p2, bIdx, isSecond: true });
            } else {
                concreteWalls.push({ start: w.p1, end: w.p2, bIdx });
            }
        });
    });

    return { verandas, concreteWalls, targetBuildings };
}
