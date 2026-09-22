"""건물 footprint 추출: 후보 블록 스코어링 → 래스터 → 연결요소 → 폴리곤."""
import math, re
import numpy as np
import cv2
from collections import Counter

PARCEL_PAT = re.compile(r'^\d{1,4}(-\d{1,3})?(대|도|전|답|잡|공|천|구|유)$')

def _poly_area(vs):
    s = 0
    for i in range(len(vs)):
        x1, y1 = vs[i]; x2, y2 = vs[(i + 1) % len(vs)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2

def cadastral_block(flat, R):
    """지번 라벨을 가장 많이 포함한 src 블록 = 지적도 블록."""
    c = Counter()
    for e in flat:
        if e['T'] == 'TEXT' and e.get('src') and R[0] <= e.get('p', (0,0))[0] <= R[1]:
            if PARCEL_PAT.match((e.get('t') or '').strip()):
                c[e['src']] += 1
    return c.most_common(1)[0][0] if c else None

def candidate_blocks(flat, R, exclude):
    """영역 내 선형이 많은 depth-1 src 블록 후보."""
    c = Counter()
    for e in flat:
        if e['depth'] == 1 and e['T'] in ('LINE', 'POLYLINE') and e.get('src') not in exclude:
            p = e.get('a') or (e.get('verts') or [(None, None)])[0]
            if p[0] and R[0] <= p[0] <= R[1] and R[2] <= p[1] <= R[3]:
                c[e['src']] += 1
    return [k for k, v in c.most_common(12) if v > 200]

class Raster:
    def __init__(self, R, res=50.0):
        self.R, self.res = R, res
        self.W = int((R[1] - R[0]) / res)
        self.H = int((R[3] - R[2]) / res)
    def topx(self, p):
        return (int((p[0] - self.R[0]) / self.res), int((self.R[3] - p[1]) / self.res))
    def tomm(self, px, py):
        return (self.R[0] + px * self.res, self.R[3] - py * self.res)
    def draw(self, flat, srcs):
        img = np.zeros((self.H, self.W), np.uint8)
        srcset = set(srcs)
        n = 0
        for e in flat:
            if e.get('src') not in srcset:
                continue
            if e['T'] == 'LINE':
                a, b = e['a'], e['b']
                if self.R[0] <= a[0] <= self.R[1] and self.R[2] <= a[1] <= self.R[3]:
                    cv2.line(img, self.topx(a), self.topx(b), 255, 1); n += 1
            elif e['T'] == 'POLYLINE':
                vs = e.get('verts') or []
                if vs and self.R[0] <= vs[0][0] <= self.R[1] and self.R[2] <= vs[0][1] <= self.R[3]:
                    pts = np.array([self.topx(v) for v in vs], np.int32)
                    cv2.polylines(img, [pts], e.get('closed', False), 255, 1); n += 1
        return img, n

def components(img, res, dil=4, min_m2=100):
    k = np.ones((3, 3), np.uint8)
    d = cv2.dilate(img, k, iterations=dil)
    nlab, lab, stats, cent = cv2.connectedComponentsWithStats(d)
    comps = []
    for i in range(1, nlab):
        a = stats[i, cv2.CC_STAT_AREA] * res * res / 1e6
        if a >= min_m2:
            comps.append((i, a, cent[i]))
    return lab, comps, dil

def score_block(flat, R, src_with_children, labels, res=50.0):
    """블록(+자식) 래스터 → 동 라벨 최근접 comp 매칭율 스코어."""
    r = Raster(R, res)
    img, n = r.draw(flat, src_with_children)
    if n < 100:
        return 0, None, None
    lab, comps, dil = components(img, res)
    if not (len(labels) * 0.5 <= len(comps) <= len(labels) * 3):
        return 0, None, None
    matched = 0
    for name, p in labels.items():
        px = r.topx(p)
        best = min((math.hypot((c[0] - px[0]) * res, (c[1] - px[1]) * res) for _, _, c in comps), default=1e12)
        if best < 40000:  # 라벨-컴포넌트 중심 40m 이내
            matched += 1
    return matched / max(len(labels), 1), r, img

def extract_polygons(flat, blocks, R, labels, res=50.0, dil=4, eps_px=2.5):
    """자동 소스 선택 → 동별 폴리곤(mm) 반환 {dong: {'poly':[(x,y)..], 'area_m2':f}}"""
    cad = cadastral_block(flat, R)
    exclude = {cad} if cad else set()
    best = (0, None, None, None)
    for b in candidate_blocks(flat, R, exclude):
        fam = [b] + [e.get(2) for e in blocks.get(b, []) if e['T'] == 'INSERT']
        s, r, img = score_block(flat, R, fam, labels, res)
        if s > best[0]:
            best = (s, r, img, b)
    if best[0] < 0.7:
        raise RuntimeError(f"footprint 소스 블록 자동선택 실패 (best score={best[0]:.2f})")
    score, r, img, srcname = best
    lab, comps, _ = components(img, res, dil)
    k = np.ones((3, 3), np.uint8)
    out, used = {}, set()
    H, W = img.shape
    for name, p in labels.items():
        px = r.topx(p)
        cand = sorted(((math.hypot((c[0]-px[0])*res, (c[1]-px[1])*res), i) for i, a, c in comps if i not in used))
        if not cand:
            continue
        used.add(cand[0][1])
        m = (lab == cand[0][1]).astype(np.uint8) * 255
        ff = m.copy(); mask = np.zeros((H + 2, W + 2), np.uint8)
        cv2.floodFill(ff, mask, (0, 0), 255)
        m = cv2.bitwise_or(m, cv2.bitwise_not(ff))
        m = cv2.erode(m, k, iterations=dil)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        cnt = max(cnts, key=cv2.contourArea)
        ap = cv2.approxPolyDP(cnt, eps_px, True).reshape(-1, 2)
        out[name] = {'poly': [r.tomm(int(x), int(y)) for x, y in ap],
                     'area_m2': round(cv2.contourArea(cnt) * res * res / 1e6, 1)}
    return out, srcname, score

def complex_polygon(flat, R, min_m2=5000):
    """영역 내 최대 닫힌 링 = 단지 경계."""
    best = None
    for e in flat:
        if e['T'] != 'POLYLINE':
            continue
        vs = e.get('verts') or []
        if len(vs) < 4:
            continue
        xs = [v[0] for v in vs]; ys = [v[1] for v in vs]
        if min(xs) < R[0] or max(xs) > R[1] or min(ys) < R[2] or max(ys) > R[3]:
            continue
        ring = vs if e.get('closed') else (vs[:-1] if math.hypot(vs[0][0]-vs[-1][0], vs[0][1]-vs[-1][1]) < 50 else None)
        if not ring:
            continue
        a = _poly_area(ring)
        if a > min_m2 * 1e6 and (best is None or a > best[0]):
            best = (a, ring)
    if not best:
        raise RuntimeError("단지 경계 폴리곤 탐지 실패")
    return best[1], best[0] / 1e6
