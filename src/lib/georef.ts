// ============================================================================
// 단지 위치 자동 보정 (Georeference by shape matching)
// ----------------------------------------------------------------------------
// CAD에서 뽑은 단지/건물 폴리곤(temps JSON)은 모양·축척은 정확하지만 절대 위치·방위가
// 틀릴 수 있다 (apt_list 대표 좌표 오차 최대 ~1km, 방위표 없는 도면은 정북 가정).
// 이 모듈은 VWorld 공간데이터(연속지적도 필지, 용도지역 등)에서 "단지와 같은 모양의 땅"을
// 찾아 회전(0~360°)·이동을 IoU 최대화로 맞추고, 그 결과를 temps JSON 좌표에 적용한다.
//
//  - 지번형 대상: 지번 → VWorld 주소좌표 → 그 주변 필지 (대지 필지는 착공 전부터 존재)
//  - 블록형 대상(택지 L5, A-3 등): 확정측량 전이라 지적에 블록이 없을 수 있음 →
//    용도지역/계획 레이어 폴리곤과 '도로 필지 사이 빈 구역'까지 후보로 본다.
//  - 여러 필지로 나뉜 대지(재건축 등)는 "배치된 단지가 50% 이상 덮는 필지들의 합"으로 재정합.
//  - 자동 채택 기준: IoU ≥ 0.9 & 차순위와 뚜렷한 차이 → high / ≥ 0.8 → medium / 그 외 수동.
// 좌표 규약: temps JSON 은 [lon, lat]. 내부 계산은 국지 평면(m, 동=+x, 북=+y), 회전은 반시계(+).
// 순수 TypeScript — 브라우저(시뮬레이터)와 Node(오프라인 테스트) 양쪽에서 동작한다.
// ============================================================================

export type LL = [number, number];
export type XY = [number, number];

const D2R = Math.PI / 180;

/** 국지 평면 좌표계 (등장방형 근사, 단지 규모 1~3km에서 오차 무시 가능) */
export class LocalFrame {
  readonly kx: number;
  readonly ky = 110950;
  constructor(readonly lon0: number, readonly lat0: number) {
    this.kx = 111320 * Math.cos(lat0 * D2R);
  }
  toXY(p: LL): XY { return [(p[0] - this.lon0) * this.kx, (p[1] - this.lat0) * this.ky]; }
  toLL(q: XY): LL { return [this.lon0 + q[0] / this.kx, this.lat0 + q[1] / this.ky]; }
}

// ---------------------------------------------------------------- polygon utils
export function ringArea(r: XY[]): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
export function ringCentroid(r: XY[]): XY {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) {
    const m = r.reduce((s, p) => [s[0] + p[0], s[1] + p[1]] as XY, [0, 0] as XY);
    return [m[0] / r.length, m[1] / r.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}
function bboxOf(rings: XY[][]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}
function closeOpen(r: XY[]): XY[] {
  // 마지막 점이 첫 점과 같으면 제거 (계산은 열린 링 기준)
  if (r.length > 2) {
    const a = r[0], b = r[r.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) return r.slice(0, -1);
  }
  return r;
}

export interface Pose { th: number; tx: number; ty: number }

/** 원점 중심 링을 th(도, 반시계) 회전 후 (tx,ty)로 이동 */
export function placeRing(c0: XY[], pose: Pose): XY[] {
  const c = Math.cos(pose.th * D2R), s = Math.sin(pose.th * D2R);
  return c0.map(p => [c * p[0] - s * p[1] + pose.tx, s * p[0] + c * p[1] + pose.ty] as XY);
}

// ---------------------------------------------------------------- raster mask
/** 행 누적합을 가진 이진 격자 — 임의 폴리곤과의 겹침 픽셀 수를 O(행 수)로 계산 */
export class Mask {
  readonly W: number; readonly H: number;
  readonly data: Uint8Array;
  pre!: Int32Array;
  count = 0;
  constructor(readonly x0: number, readonly y0: number, readonly res: number, W: number, H: number) {
    this.W = Math.max(1, W); this.H = Math.max(1, H);
    this.data = new Uint8Array(this.W * this.H);
  }
  static around(rings: XY[][], res: number, margin: number): Mask {
    const [a, b, c, d] = bboxOf(rings);
    const x0 = a - margin, y0 = b - margin;
    return new Mask(x0, y0, res, Math.ceil((c - a + 2 * margin) / res), Math.ceil((d - b + 2 * margin) / res));
  }
  /** 폴리곤(외곽+구멍 링들, even-odd) 내부를 v로 채움. 여러 번 호출하면 합집합 */
  fill(rings: XY[] | XY[][], v = 1): void {
    this.spans(rings, (j, ia, ib) => { this.data.fill(v, j * this.W + ia, j * this.W + ib + 1); });
  }
  /** 폴리곤(링 하나 또는 외곽+구멍 링들)의 행별 픽셀 구간 콜백 — 모든 링의 교차점을 합쳐 even-odd (격자 밖은 잘라냄) */
  spans(rings: XY[] | XY[][], cb: (row: number, ia: number, ib: number) => void): void {
    const rs: XY[][] = (rings.length && typeof (rings as any)[0][0] === 'number') ? [rings as XY[]] : rings as XY[][];
    let ymin = Infinity, ymax = -Infinity;
    for (const r of rs) for (const p of r) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
    if (!Number.isFinite(ymin)) return;
    const j0 = Math.max(0, Math.ceil((ymin - this.y0) / this.res - 0.5));
    const j1 = Math.min(this.H - 1, Math.floor((ymax - this.y0) / this.res - 0.5));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const yc = this.y0 + (j + 0.5) * this.res;
      xs.length = 0;
      for (const r of rs) {
        const n = r.length; if (n < 3) continue;
        for (let i = 0; i < n; i++) {
          const p = r[i], q = r[(i + 1) % n];
          if ((p[1] <= yc && q[1] > yc) || (q[1] <= yc && p[1] > yc)) {
            xs.push(p[0] + (yc - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let ia = Math.ceil((xs[k] - this.x0) / this.res - 0.5);
        let ib = Math.ceil((xs[k + 1] - this.x0) / this.res - 0.5) - 1;
        if (ia < 0) ia = 0; if (ib > this.W - 1) ib = this.W - 1;
        if (ib >= ia) cb(j, ia, ib);
      }
    }
  }
  /** 채우기가 끝난 뒤 호출 — 누적합/개수 계산 */
  seal(): this {
    const W = this.W, H = this.H, d = this.data;
    this.pre = new Int32Array((W + 1) * H);
    let cnt = 0;
    for (let j = 0; j < H; j++) {
      let acc = 0; const o = j * (W + 1), r = j * W;
      for (let i = 0; i < W; i++) { acc += d[r + i]; this.pre[o + i + 1] = acc; }
      cnt += acc;
    }
    this.count = cnt;
    return this;
  }
  /** 폴리곤 내부에 있는 마스크 픽셀 수 */
  overlap(r: XY[] | XY[][]): number {
    let s = 0; const W1 = this.W + 1;
    this.spans(r, (j, ia, ib) => { s += this.pre[j * W1 + ib + 1] - this.pre[j * W1 + ia]; });
    return s;
  }
  /** 픽셀 → 링 무게중심 계산용 (마스크 전체의 무게중심, m) */
  centroid(): XY {
    let sx = 0, sy = 0, n = 0;
    for (let j = 0; j < this.H; j++) for (let i = 0; i < this.W; i++) if (this.data[j * this.W + i]) { sx += i; sy += j; n++; }
    return n ? [this.x0 + (sx / n + 0.5) * this.res, this.y0 + (sy / n + 0.5) * this.res] : [this.x0, this.y0];
  }
}

/** 폴리곤들(각각 [외곽, 구멍...])의 합집합 마스크 */
export function maskFromPolys(polys: XY[][][], res: number, margin = 60): Mask {
  const m = Mask.around(polys.flat(), res, margin);
  for (const p of polys) m.fill(p);
  return m.seal();
}
/** 단순 링들(구멍 없음)의 합집합 마스크 */
export function maskFromRings(rings: XY[][], res: number, margin = 60): Mask {
  return maskFromPolys(rings.map(r => [r]), res, margin);
}

/** 배치된 단지 링과 기준 마스크의 IoU */
export function iouRingMask(ring: XY[], m: Mask): number {
  const I = m.overlap(ring);
  const A = Math.abs(ringArea(ring)) / (m.res * m.res);
  const U = A + m.count - I;
  return U > 0 ? I / U : 0;
}

// ---------------------------------------------------------------- pose fitting
export interface FitOut { pose: Pose; iou: number }

function angDiff(a: number, b: number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  return Math.abs(d);
}

/** 국소 탐색(이동·회전) — 단계별 보폭을 줄여가며 IoU 상승 방향으로 이동 */
export function refinePose(c0: XY[], m: Mask, start: Pose, levels = [
  { d: 16, a: 4 }, { d: 8, a: 2 }, { d: 4, a: 1 }, { d: 2, a: 0.5 }, { d: 1, a: 0.25 }, { d: 0.5, a: 0.1 },
], fixRot = false): FitOut {
  let pose = { ...start };
  let best = iouRingMask(placeRing(c0, pose), m);
  for (const L of levels) {
    for (let it = 0; it < 40; it++) {
      const moves: Pose[] = [
        { ...pose, tx: pose.tx + L.d }, { ...pose, tx: pose.tx - L.d },
        { ...pose, ty: pose.ty + L.d }, { ...pose, ty: pose.ty - L.d },
      ];
      if (!fixRot) moves.push({ ...pose, th: pose.th + L.a }, { ...pose, th: pose.th - L.a });
      let bi = -1, bv = best;
      moves.forEach((p, i) => { const v = iouRingMask(placeRing(c0, p), m); if (v > bv + 1e-6) { bv = v; bi = i; } });
      if (bi < 0) break;
      pose = moves[bi]; best = bv;
    }
  }
  pose.th = ((pose.th % 360) + 360) % 360;
  return { pose, iou: best };
}

/**
 * 기준 마스크에 단지를 맞춘다.
 * thetas: 거친 회전 후보(도). 기본은 0~355° 5° 간격(방위 모름).
 * 상위 몇 개 회전(서로 20° 이상 떨어진)을 국소 탐색으로 다듬어 모두 반환(IoU 내림차순).
 */
export function fitToMask(c0: XY[], m: Mask, opts: { thetas?: number[]; init?: XY; keep?: number; fixRot?: boolean } = {}): FitOut[] {
  const init = opts.init || m.centroid();
  const thetas = opts.thetas || Array.from({ length: 72 }, (_, i) => i * 5);
  const coarse = thetas.map(th => ({ th, v: iouRingMask(placeRing(c0, { th, tx: init[0], ty: init[1] }), m) }))
    .sort((a, b) => b.v - a.v);
  const seeds: number[] = [];
  for (const c of coarse) {
    if (seeds.every(s => angDiff(s, c.th) >= 20)) seeds.push(c.th);
    if (seeds.length >= (opts.keep || 4)) break;
  }
  return seeds.map(th => refinePose(c0, m, { th, tx: init[0], ty: init[1] }, undefined, opts.fixRot))
    .sort((a, b) => b.iou - a.iou);
}

// ---------------------------------------------------------------- VWorld 데이터
export interface RefFeature { source: string; id: string; label: string; parts: XY[][][]; area: number; centroid: XY }

export interface GeorefInput {
  /** temps JSON (MoiraComplexPolygonResult 호환: complex.polygon, buildings[].polygon/center, [lon,lat]) */
  data: any;
  /** apt_list 행 (위경도·주소·원본 컬럼) */
  apt?: { lat: number; lng: number; address?: string; raw?: Record<string, string> } | null;
  /** VWorld URL(GET) → JSON. 시뮬레이터에서는 /api/vworld-proxy 경유 */
  get: (url: string) => Promise<any>;
  /** URL key 파라미터 (서버 .env 키를 쓰려면 '__SERVER__') */
  key?: string;
  domain?: string;
  /** 블록형(지번 없음) 탐색 반경 m — 기본 1500 */
  radiusM?: number;
  /** 추가로 조회할 면형 레이어 (용도지역 등) */
  extraLayers?: string[];
  /** 블록 경계로 쓸 도시계획시설 레이어 */
  facilityLayers?: string[];
  log?: (s: string) => void;
}

export interface GeorefCandidateOut {
  source: string; label: string; iou: number;
  /** 현재 좌표 대비 추가 회전(도, 반시계 +) */
  rotDeg: number;
  /** 보정 후 단지 도심 [lon,lat] */
  center: LL;
  /** 현재 도심 → 보정 도심 이동거리 m */
  shiftM: number;
  areaRatio: number;
  /** 정합에 쓴 기준 경계 (지도 표시용) */
  rings: LL[][];
}

export interface GeorefProposal {
  ok: boolean;
  rapaKey: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  reason: string;
  best?: GeorefCandidateOut;
  alternatives: GeorefCandidateOut[];
  diagnostics: Record<string, any>;
}

/** 단일 폴리곤 후보로 쓸 면형 레이어 (용도지역) */
export const DEFAULT_EXTRA_LAYERS = ['LT_C_UQ111'];
/** 도시계획시설(도로·공원/녹지·학교 등) — 이들 사이의 '빈 구역'이 택지 블록(확정측량 전에도 존재) */
export const FACILITY_LAYERS = ['LT_C_UPISUQ151', 'LT_C_UPISUQ152', 'LT_C_UPISUQ153', 'LT_C_UPISUQ154', 'LT_C_UPISUQ155',
  'LT_C_UPISUQ156', 'LT_C_UPISUQ157', 'LT_C_UPISUQ158', 'LT_C_UPISUQ159'];
const PARCEL_LAYER = 'LP_PA_CBND_BUBUN';

/** GeoJSON → 폴리곤 파트 목록 (각 파트 = [외곽, 구멍...]) */
function polyParts(geom: any): LL[][][] {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

/** 택지 블록형 대상 여부 (주소/공사명에 블록·지구 표기 → 지번 없음, apt_list 번지는 신뢰 불가) */
export function isBlockSite(apt: GeorefInput['apt']): boolean {
  const raw = apt?.raw || {};
  const txt = `${apt?.address || ''} ${raw['주소'] || ''} ${raw['공사명'] || ''}`;
  return /블록|블럭|\bBL\b|\dBL|[A-Z]{1,2}-?\d+BL|택지|공공주택지구|공급촉진지구|생활권|개발사업|지구\s*[A-Z]{0,2}-?\d/.test(txt)
    && !/\s\d+(-\d+)?\s*$/.test((apt?.address || '').trim());
}

function vworldDataUrl(layer: string, box: number[], page: number, key: string, domain: string): string {
  const q = new URLSearchParams({
    service: 'data', version: '2.0', request: 'GetFeature', format: 'json', errorFormat: 'json',
    size: '1000', page: String(page), data: layer,
    geomFilter: `BOX(${box.map(v => v.toFixed(7)).join(',')})`,
    geometry: 'true', attribute: 'true', crs: 'EPSG:4326', key, domain,
  });
  return `https://api.vworld.kr/req/data?${q.toString()}`;
}

/** BOX 안의 레이어 피처 전부 (페이지 순회, 범위 초과 오류 시 4분할) */
async function fetchLayer(inp: GeorefInput, layer: string, box: number[], depth = 0, diag: any = {}): Promise<any[]> {
  const key = inp.key || '__SERVER__', domain = inp.domain || '';
  const out: any[] = [];
  for (let page = 1; page <= 10; page++) {
    let js: any;
    try { js = await inp.get(vworldDataUrl(layer, box, page, key, domain)); }
    catch (e: any) { diag.error = String(e?.message || e); break; }
    const r = js?.response;
    if (!r) { diag.error = js?.error || 'no response'; break; }
    if (r.status === 'NOT_FOUND') break;
    if (r.status !== 'OK') {
      const msg = r.error?.text || r.error?.code || r.status;
      diag.error = msg;
      // 조회 범위/건수 제한 → 4분할 재시도
      if (depth < 2 && /범위|BOX|영역|RANGE|LIMIT|초과/i.test(String(msg))) {
        const [x0, y0, x1, y1] = box, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
        for (const b of [[x0, y0, xm, ym], [xm, y0, x1, ym], [x0, ym, xm, y1], [xm, ym, x1, y1]]) {
          out.push(...await fetchLayer(inp, layer, b, depth + 1, diag));
        }
        delete diag.error;
      }
      break;
    }
    const feats = r.result?.featureCollection?.features || [];
    out.push(...feats);
    const total = Number(r.page?.total || 1);
    if (page >= total || feats.length === 0) break;
  }
  return out;
}

/** 지번 주소 → [lon,lat] (VWorld 주소 좌표 검색) */
async function geocodeParcel(inp: GeorefInput, address: string): Promise<LL | null> {
  const q = new URLSearchParams({
    service: 'address', request: 'getcoord', version: '2.0', crs: 'epsg:4326', address,
    refine: 'true', simple: 'false', format: 'json', type: 'parcel',
    key: inp.key || '__SERVER__', domain: inp.domain || '',
  });
  try {
    const js = await inp.get(`https://api.vworld.kr/req/address?${q.toString()}`);
    const p = js?.response?.result?.point;
    if (js?.response?.status === 'OK' && p) return [Number(p.x), Number(p.y)];
  } catch { /* ignore */ }
  return null;
}

/** apt_list 행에서 지번 주소 구성 (번/지 컬럼 우선, 없으면 주소 끝의 숫자) */
export function parcelAddressOf(apt: GeorefInput['apt']): { address: string; bun: string } | null {
  if (!apt) return null;
  const raw = apt.raw || {};
  const g = (k: string) => (raw[`${k}_보정`] && raw[`${k}_보정`] !== '-' ? raw[`${k}_보정`] : raw[k] || '').trim();
  const bun = g('번'), ji = g('지');
  if (/^\d+$/.test(bun) && Number(bun) > 0) {
    const parts = [g('시도'), g('시군구'), g('읍면동'), g('리')].filter(v => v && v !== '-');
    const jb = ji && /^\d+$/.test(ji) && Number(ji) > 0 ? `${bun}-${ji}` : bun;
    if (parts.length >= 2) return { address: `${parts.join(' ')} ${jb}`, bun };
  }
  const m = (apt.address || '').trim().match(/^(.*?[동리가로])\s+(\d+)(?:\s+|-)?(\d+)?$/);
  if (m) return { address: `${m[1]} ${m[2]}${m[3] ? '-' + m[3] : ''}`, bun: m[2] };
  return null;
}

function convexHull(pts: XY[]): XY[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: XY[] = [], up: XY[] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** 단지 경계(LL) — complex.polygon, 없으면 건물 외곽 볼록껍질 */
function complexRingLL(data: any): LL[] | null {
  const c = data?.complex?.polygon;
  if (Array.isArray(c) && c.length >= 3) return c as LL[];
  const pts: LL[] = [];
  for (const b of data?.buildings || []) for (const p of b.polygon || []) pts.push(p);
  if (pts.length < 3) return null;
  const f = new LocalFrame(pts[0][0], pts[0][1]);
  return convexHull(pts.map(p => f.toXY(p))).map(q => f.toLL(q));
}

// ---------------------------------------------------------------- 메인: 보정안 산출
interface Scored { src: string; label: string; fit: FitOut; refPolys: XY[][][]; refArea: number; outline?: XY[] }
export interface Cand { src: string; label: string; mask: Mask; area: number; polys: XY[][][]; outline?: XY[] }

function polysArea(parts: XY[][][]): number {
  let a = 0;
  for (const p of parts) { a += Math.abs(ringArea(p[0])); for (const h of p.slice(1)) a -= Math.abs(ringArea(h)); }
  return a;
}

/** 행 구간(좌/우 끝) 기반 외곽선 — 표시용 근사 (블록은 대체로 단조 형태) */
function outlineOfMask(m: Mask, step = 3): XY[] {
  const L: XY[] = [], R: XY[] = [];
  for (let j = 0; j < m.H; j += step) {
    let a = -1, b = -1;
    for (let i = 0; i < m.W; i++) if (m.data[j * m.W + i]) { if (a < 0) a = i; b = i; }
    if (a < 0) continue;
    const y = m.y0 + (j + 0.5) * m.res;
    L.push([m.x0 + a * m.res, y]); R.push([m.x0 + (b + 1) * m.res, y]);
  }
  return L.concat(R.reverse());
}

/**
 * 도시계획시설(도로·녹지·학교 …) 폴리곤을 격자에 칠하고, 칠해지지 않은 연결 영역 중
 * 단지 면적과 비슷한 것(경계에 닿지 않는 닫힌 구역)을 블록 후보로 뽑는다.
 */
export function gapBlocks(fac: XY[][][], bounds: [number, number, number, number], Ac: number, res = 2, ratio: [number, number] = [0.6, 1.7]): Cand[] {
  const [x0, y0, x1, y1] = bounds;
  const g = new Mask(x0, y0, res, Math.ceil((x1 - x0) / res), Math.ceil((y1 - y0) / res));
  for (const p of fac) g.fill(p);
  const W = g.W, H = g.H, lab = new Int32Array(W * H);
  const out: Cand[] = [];
  const stack: number[] = [];
  let id = 0;
  for (let s0 = 0; s0 < W * H; s0++) {
    if (g.data[s0] || lab[s0]) continue;
    id++; lab[s0] = id; stack.push(s0);
    let n = 0, border = false, bx0 = W, by0 = H, bx1 = 0, by1 = 0;
    const cells: number[] = [];
    while (stack.length) {
      const p = stack.pop()!; n++; cells.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (x > 0 && !g.data[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && !g.data[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && !g.data[p - W] && !lab[p - W]) { lab[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && !g.data[p + W] && !lab[p + W]) { lab[p + W] = id; stack.push(p + W); }
    }
    const area = n * res * res;
    if (border || area < Ac * ratio[0] || area > Ac * ratio[1]) continue;
    const pad = Math.ceil(40 / res);
    const m = new Mask(x0 + (bx0 - pad) * res, y0 + (by0 - pad) * res, res, bx1 - bx0 + 1 + 2 * pad, by1 - by0 + 1 + 2 * pad);
    for (const p of cells) { const x = p % W - bx0 + pad, y = ((p / W) | 0) - by0 + pad; m.data[y * m.W + x] = 1; }
    m.seal();
    out.push({ src: 'plan-block', label: `도시계획시설 사이 구역 ${Math.round(area / 100) / 100}ha`, mask: m, area, polys: [], outline: outlineOfMask(m) });
  }
  return out;
}

export async function proposeGeoref(inp: GeorefInput): Promise<GeorefProposal> {
  const t0 = Date.now();
  const log = inp.log || (() => { /* silent */ });
  const rapaKey = inp.data?.rapaKey || '';
  const diag: Record<string, any> = { layers: {} };
  const fail = (reason: string): GeorefProposal => ({ ok: false, rapaKey, confidence: 'none', reason, alternatives: [], diagnostics: { ...diag, ms: Date.now() - t0 } });

  const cLL = complexRingLL(inp.data);
  if (!cLL) return fail('단지/건물 폴리곤이 없어 형상 정합을 할 수 없습니다.');
  const f0 = new LocalFrame(cLL[0][0], cLL[0][1]);
  const cen0 = ringCentroid(closeOpen(cLL.map(p => f0.toXY(p))));
  const frame = new LocalFrame(...f0.toLL(cen0));           // 원점 = 현재 단지 도심
  const C0 = closeOpen(cLL.map(p => frame.toXY(p)));       // 도심 기준 단지 링
  const Ac = Math.abs(ringArea(C0));
  diag.complexAreaM2 = Math.round(Ac);

  // 1) 탐색 범위: 블록형은 apt_list 좌표·현재 도심 둘 다 포함 + 1.5km / 지번형은 지번좌표 + 600m
  const block = isBlockSite(inp.apt);
  const pa = block ? null : parcelAddressOf(inp.apt);
  const pts: XY[] = [[0, 0]];
  let R = inp.radiusM || 1500, how = 'current';
  if (inp.apt && Number.isFinite(inp.apt.lat) && Number.isFinite(inp.apt.lng)) { pts.push(frame.toXY([inp.apt.lng, inp.apt.lat])); how = 'apt_list'; }
  let geo: LL | null = null;
  if (pa) {
    geo = await geocodeParcel(inp, pa.address);
    diag.parcelAddress = pa.address; diag.geocoded = geo;
    if (geo) { pts.length = 0; pts.push(frame.toXY(geo), [0, 0]); R = Math.min(R, 600); how = 'jibun'; }
  }
  const center = pts[0];
  const bx0 = Math.min(...pts.map(p => p[0])) - R, by0 = Math.min(...pts.map(p => p[1])) - R;
  const bx1 = Math.max(...pts.map(p => p[0])) + R, by1 = Math.max(...pts.map(p => p[1])) + R;
  diag.search = { type: block ? 'block' : (pa ? 'jibun' : 'unknown'), how, radiusM: R, centerLL: frame.toLL(center), aptOffsetM: Math.round(Math.hypot(pts[pts.length - 1][0], pts[pts.length - 1][1])) };
  log(`[georef] ${rapaKey} ${diag.search.type} 탐색중심=${how} 반경=${R}m`);

  // 2) 기준 레이어 수집
  const llA = frame.toLL([bx0, by0]), llB = frame.toLL([bx1, by1]);
  const box = [llA[0], llA[1], llB[0], llB[1]];
  const feats: RefFeature[] = [];
  const fac: XY[][][] = [];
  const layers = [PARCEL_LAYER, ...(inp.extraLayers || DEFAULT_EXTRA_LAYERS), ...(inp.facilityLayers || FACILITY_LAYERS)];
  const facSet = new Set(inp.facilityLayers || FACILITY_LAYERS);
  for (const layer of layers) {
    const d: any = {};
    const raw = await fetchLayer(inp, layer, box, 0, d);
    let n = 0;
    for (const ft of raw) {
      const parts = polyParts(ft.geometry).map(pp => pp.map(r => closeOpen(r.map((p: any) => frame.toXY([Number(p[0]), Number(p[1])])))))
        .filter(pp => pp.length && pp[0].length >= 3);
      if (!parts.length) continue;
      n++;
      const pr = ft.properties || {};
      if (facSet.has(layer)) { fac.push(...parts); continue; }
      const area = polysArea(parts);
      const big = parts.reduce((a, p) => Math.abs(ringArea(p[0])) > Math.abs(ringArea(a[0])) ? p : a, parts[0]);
      const f: RefFeature = {
        source: layer === PARCEL_LAYER ? 'parcel' : layer,
        id: String(pr.pnu || ft.id || feats.length),
        label: String(pr.jibun || pr.uname || pr.dgm_nm || layer),
        parts, area, centroid: ringCentroid(big[0]),
      };
      feats.push(f);
      if (f.source === 'parcel' && /도$/.test(f.label.trim())) fac.push(...parts); // 지목 '도로' 필지도 블록 경계로 사용
    }
    diag.layers[layer] = { features: n, ...(d.error ? { error: d.error } : {}) };
  }
  const parcels = feats.filter(f => f.source === 'parcel');
  // 지목: 아파트 대지는 '대'(또는 잡종지). 하천·도로·전답 등 필지는 후보에서 제외 (모양이 우연히 비슷한 오답 방지)
  const jimok = (label: string) => { const m = label.trim().match(/([가-힣])\s*$/); return m ? m[1] : ''; };
  const siteLike = (f: RefFeature) => f.source !== 'parcel' || ['대', '잡'].includes(jimok(f.label));
  if (!feats.length && !fac.length) return fail(`VWorld 기준 데이터가 없습니다 (${Object.entries(diag.layers).map(([k, v]: any) => `${k}:${v.error || v.features}`).join(', ')}).`);

  // 3) 후보 생성
  const cands: Cand[] = [];
  const near = (c: XY) => c[0] >= bx0 && c[0] <= bx1 && c[1] >= by0 && c[1] <= by1;
  for (const f of feats) {
    const ratio = f.area / Ac;
    if (ratio >= 0.55 && ratio <= 1.8 && near(f.centroid) && siteLike(f)) {
      cands.push({ src: f.source, label: f.label, polys: f.parts, area: f.area, mask: maskFromPolys(f.parts, f.area > 250000 ? 2 : 1, 80) });
    }
  }
  if (geo && pa) {
    const g = frame.toXY(geo);
    const bonbun = parcels.filter(f => siteLike(f) && f.label.split(/[- ]/)[0].replace(/\D/g, '') === pa.bun && Math.hypot(f.centroid[0] - g[0], f.centroid[1] - g[1]) < 400);
    if (bonbun.length > 1) {
      const area = bonbun.reduce((s, f) => s + f.area, 0);
      if (area / Ac > 0.4 && area / Ac < 3) {
        const polys = bonbun.flatMap(f => f.parts);
        cands.push({ src: 'parcel-group', label: `${pa.bun}번지 필지 ${bonbun.length}개`, polys, area, mask: maskFromPolys(polys, 1, 80) });
      }
    }
    const probe: XY[] = [[g[0] - 0.5, g[1] - 0.5], [g[0] + 0.5, g[1] - 0.5], [g[0] + 0.5, g[1] + 0.5], [g[0] - 0.5, g[1] + 0.5]];
    const pm = maskFromRings([probe], 1, 2);
    for (const f of parcels) if (pm.overlap(f.parts[0][0]) > 0) {
      const ex = cands.find(c => c.polys === f.parts);
      if (ex) { ex.src = 'parcel-geo'; ex.label = f.label + ' (지번좌표 필지)'; }
      else cands.push({ src: 'parcel-geo', label: f.label + ' (지번좌표 필지)', polys: f.parts, area: f.area, mask: maskFromPolys(f.parts, 1, 80) });
    }
  }
  let nGap = 0;
  if (fac.length) {
    const gb = gapBlocks(fac, [bx0, by0, bx1, by1], Ac, (bx1 - bx0) * (by1 - by0) > 16e6 ? 3 : 2);
    nGap = gb.length; cands.push(...gb);
  }
  diag.candidates = { total: cands.length, planBlocks: nGap, facilityPolys: fac.length };
  if (!cands.length) return fail('면적이 비슷한 필지/구역 후보가 없습니다 (확정측량·도시계획 데이터 미반영 또는 탐색 반경 밖).');

  // 4) 후보별 전방위 정합
  const scored: Scored[] = [];
  for (const c of cands) {
    for (const fit of fitToMask(C0, c.mask, { keep: 3 })) {
      scored.push({ src: c.src, label: c.label, fit, refPolys: c.polys, refArea: c.area, outline: c.outline });
    }
  }
  scored.sort((a, b) => b.fit.iou - a.fit.iou);

  // 5) 필지 조립(여러 필지로 나뉜 대지): 배치된 단지가 50% 이상 덮는 '큰' 필지(≥3% 면적) 최대 6개의 합으로 재정합
  // 블록형(택지)은 확정측량 전 옛 필지가 잘게 남아 있어 조립하면 아무 모양이나 만들어진다 → 지번형에서만 조립
  for (const s of (block ? [] : scored.filter(x => x.src.startsWith('parcel')).slice(0, 4))) {
    let pose = s.fit.pose, prevKey = '';
    for (let it = 0; it < 3; it++) {
      const pm = maskFromRings([placeRing(C0, pose)], 1, 5);
      const sel = parcels.filter(f => siteLike(f) && f.area >= Ac * 0.03 && f.parts.reduce((a, p) => a + pm.overlap(p), 0) / f.area >= 0.5);
      const key = sel.map(f => f.id).sort().join('|');
      if (!sel.length || sel.length > 6 || key === prevKey) break;
      prevKey = key;
      const polys = sel.flatMap(f => f.parts), area = sel.reduce((a, f) => a + f.area, 0);
      const fit = refinePose(C0, maskFromPolys(polys, 1, 80), pose, [{ d: 4, a: 1 }, { d: 2, a: 0.5 }, { d: 1, a: 0.25 }, { d: 0.5, a: 0.1 }]);
      pose = fit.pose;
      if (sel.length > 1) scored.push({ src: 'parcel-union', label: `필지 ${sel.length}개 합`, fit, refPolys: polys, refArea: area });
    }
  }
  scored.sort((a, b) => b.fit.iou - a.fit.iou);

  // 6) 지번형: 지번좌표에서 300m 넘게 떨어진 배치는 버림 (지번 좌표는 신뢰할 수 있음)
  let pool = scored;
  if (geo) {
    const g = frame.toXY(geo);
    pool = scored.filter(s => Math.hypot(s.fit.pose.tx - g[0], s.fit.pose.ty - g[1]) <= 300);
    if (!pool.length) return fail(`지번 좌표(${pa?.address}) 300m 안에 맞는 경계가 없습니다 — 수동 보정 필요.`);
  }
  // 중복 제거
  const uniq: Scored[] = [];
  for (const s of pool) {
    if (uniq.some(u => Math.hypot(u.fit.pose.tx - s.fit.pose.tx, u.fit.pose.ty - s.fit.pose.ty) < 15 && angDiff(u.fit.pose.th, s.fit.pose.th) < 10)) continue;
    uniq.push(s);
  }
  const top = uniq[0];
  const samePlace = (u: Scored, v: Scored) => Math.hypot(u.fit.pose.tx - v.fit.pose.tx, u.fit.pose.ty - v.fit.pose.ty) <= 30;
  // 같은 자리에서 방향만 다른 동률 후보(직사각형 단지의 180° 등) → 방위 사전정보에 가까운 쪽 선택
  const ties = uniq.filter(u => samePlace(u, top) && top.fit.iou - u.fit.iou < 0.02);
  const priorConf = inp.data?.georeference?.confidence;
  const priorTrusted = priorConf === 'high' || priorConf === 'medium';
  let best: Scored = ties.reduce((a, u) => angDiff(u.fit.pose.th, 0) < angDiff(a.fit.pose.th, 0) ? u : a, top);
  const rotAmbiguous = ties.some(u => angDiff(u.fit.pose.th, best.fit.pose.th) > 20);
  diag.prior = { confidence: priorConf || null, trusted: priorTrusted };
  if (rotAmbiguous) diag.rotationCandidates = ties.map(u => Number((((u.fit.pose.th + 180) % 360) - 180).toFixed(1)));
  // 미세 회전(<1.5°)은 이득이 거의 없으면 0°로 고정 — 방위 정확한 도면에 잡음 회전을 주지 않도록
  if (angDiff(best.fit.pose.th, 0) < 1.5) {
    const c = cands.find(x => x.label === best.label && x.src === best.src);
    const m = c ? c.mask : maskFromPolys(best.refPolys, 1, 80);
    const snap = refinePose(C0, m, { ...best.fit.pose, th: 0 }, [{ d: 2, a: 0 }, { d: 1, a: 0 }, { d: 0.5, a: 0 }], true);
    if (best.fit.iou - snap.iou < 0.004) { best = { ...best, fit: snap }; diag.rotSnapped = true; }
  }
  // 위치 신뢰도: 다른 '자리' 후보와의 차이로 판단
  const second = uniq.find(u => !samePlace(u, best));
  const margin = best.fit.iou - (second ? second.fit.iou : 0);
  let confidence: GeorefProposal['confidence'] = 'none', reason = '';
  const iou = best.fit.iou;
  const geoParcel = best.src === 'parcel-geo';
  if (iou >= 0.9 && (margin >= 0.05 || geoParcel)) { confidence = 'high'; reason = `형상 일치 IoU ${iou.toFixed(3)}`; }
  else if (iou >= 0.8 && (margin >= 0.03 || geoParcel)) { confidence = 'medium'; reason = `형상 일치 IoU ${iou.toFixed(3)} (다른 자리 후보와 ${margin.toFixed(3)} 차)`; }
  else if (iou >= 0.8) { confidence = 'low'; reason = `비슷한 자리 후보가 여럿 (IoU ${iou.toFixed(3)}, 차순위 ${second?.fit.iou.toFixed(3)}) — 수동 확인 필요`; }
  else { confidence = 'none'; reason = `일치하는 경계 없음 (최고 IoU ${iou.toFixed(3)}) — 수동 보정 필요`; }
  if (rotAmbiguous && confidence !== 'none') {
    const alts = diag.rotationCandidates.filter((v: number) => angDiff(v, best.fit.pose.th) > 20).join('°, ');
    if (!priorTrusted) confidence = confidence === 'high' ? 'medium' : 'low';
    reason += ` · 방향 대칭 후보 있음(${alts}°) — 방위표/건물 배치로 방향 확인 권장`;
  }
  diag.margin = Number(margin.toFixed(3));
  diag.ms = Date.now() - t0;

  const toOut = (s: Scored): GeorefCandidateOut => ({
    source: s.src, label: s.label, iou: Number(s.fit.iou.toFixed(4)),
    rotDeg: Number((((s.fit.pose.th + 180) % 360) - 180).toFixed(2)),
    center: frame.toLL([s.fit.pose.tx, s.fit.pose.ty]),
    shiftM: Number(Math.hypot(s.fit.pose.tx, s.fit.pose.ty).toFixed(1)),
    areaRatio: Number((s.refArea / Ac).toFixed(3)),
    rings: (s.refPolys.length ? s.refPolys.map(p => p[0]) : (s.outline ? [s.outline] : [])).map(r => r.map(q => frame.toLL(q))),
  });
  return {
    ok: confidence === 'high' || confidence === 'medium',
    rapaKey, confidence, reason,
    best: toOut(best),
    alternatives: uniq.filter(u => u !== best).slice(0, 3).map(toOut),
    diagnostics: diag,
  };
}

// ---------------------------------------------------------------- 좌표 적용
/**
 * temps JSON 전체 좌표(단지·건물 폴리곤·건물 중심)를 "현재 단지 도심 기준 rotDeg 회전 → center로 이동" 변환.
 * 수동 보정도 같은 함수를 쓴다: center = 현재 도심 + (dx,dy) m.
 */
export function applyGeoref(data: any, t: { rotDeg: number; center?: LL; dxM?: number; dyM?: number }, meta: Record<string, any> = {}): any {
  const cLL = complexRingLL(data);
  if (!cLL) throw new Error('단지/건물 폴리곤이 없습니다.');
  const f0 = new LocalFrame(cLL[0][0], cLL[0][1]);
  const frame = new LocalFrame(...f0.toLL(ringCentroid(closeOpen(cLL.map(p => f0.toXY(p))))));
  const tgt: XY = t.center ? frame.toXY(t.center) : [t.dxM || 0, t.dyM || 0];
  const c = Math.cos(t.rotDeg * D2R), s = Math.sin(t.rotDeg * D2R);
  const tf = (p: LL): LL => {
    const q = frame.toXY(p);
    const r = frame.toLL([c * q[0] - s * q[1] + tgt[0], s * q[0] + c * q[1] + tgt[1]]);
    return [Number(r[0].toFixed(8)), Number(r[1].toFixed(8))];
  };
  const out = JSON.parse(JSON.stringify(data));
  if (out.complex?.polygon) out.complex.polygon = out.complex.polygon.map(tf);
  for (const b of out.buildings || []) {
    if (Array.isArray(b.polygon)) b.polygon = b.polygon.map(tf);
    if (Array.isArray(b.center) && b.center.length === 2) b.center = tf(b.center);
  }
  const prev = out.georeference || {};
  out.georeference = {
    ...prev,
    rotation_deg_ccw: Number(((((Number(prev.rotation_deg_ccw) || 0) + t.rotDeg) % 360 + 360) % 360).toFixed(2)),
    ...meta,
    history: [...(Array.isArray(prev.history) ? prev.history : []),
      { at: new Date().toISOString(), rotDeg: Number(t.rotDeg.toFixed(3)), shiftM: Number(Math.hypot(tgt[0], tgt[1]).toFixed(1)), method: meta.method || 'manual' }],
  };
  return out;
}
