"""동 라벨, 층수 텍스트, 안테나/관로 심볼 추출."""
import math, re
from collections import defaultdict

# 동번호는 3자리(101동)가 흔하지만 4자리(1601동)를 쓰는 단지도 있다.
# 실측: m-RAPA-2310-3755의 동라벨은 1601/1602/1603/1606.
DONG_PAT = re.compile(r'^(\d{3,4})(동)?$')
FLOOR_PAT = re.compile(r'^(\d{1,2})F(?:\((\d+)U\))?$')
LEGEND_TXT = ('화단형안테나', '옥상형 중계장치', '옥상형안테나 설치장소')
BLUE, RED = {5}, {1, 240, 10}

def _in(p, R):
    return R[0] <= p[0] <= R[1] and R[2] <= p[1] <= R[3]

def dong_labels(flat, R):
    """옥외배치도 내 동 번호 텍스트 (h>=1000, 3자리 숫자)."""
    out = {}
    for e in flat:
        if e['T'] == 'TEXT' and _in(e.get('p', (0, 0)), R) and e.get('h', 0) >= 1000:
            m = DONG_PAT.match((e.get('t') or '').strip())
            if m:
                out[m.group(1)] = (e['p'][0] + e['h'], e['p'][1] + e['h'] / 2)  # 대략 중심 보정
    return out

def floor_texts(flat, R):
    out = []
    for e in flat:
        if e['T'] in ('TEXT', 'ATTRIB') and _in(e.get('p', (0, 0)), R):
            m = FLOOR_PAT.match((e.get('t') or '').strip())
            if m:
                out.append((int(m.group(1)), int(m.group(2)) if m.group(2) else None,
                            e['p'][0], e['p'][1] + (e.get('h', 0) or 800) / 2))
    return out

def symbol_circles(flat, R):
    """(blue[], red[]) — 범례 텍스트 주변(반경 12m)은 제외, 동심원 중복 제거."""
    legend_pts = [e['p'] for e in flat
                  if e['T'] in ('TEXT', 'ATTRIB') and _in(e.get('p', (0, 0)), R)
                  and any(k in (e.get('t') or '') for k in LEGEND_TXT)]
    def near_legend(p):
        return any(math.hypot(p[0]-q[0], p[1]-q[1]) < 12000 for q in legend_pts)
    def is_symbol_src(s):
        s = str(s or '')
        return ('안테나' in s or '지정' in s) and '예시' not in s
    # 1차: RAPA 심볼 블록 유래 원만 (표준 도면), 없으면 2차: 색상 기반 fallback
    for strict in (True, False):
        blue, red = [], []
        for e in flat:
            if e['T'] == 'CIRCLE' and _in(e.get('c', (0, 0)), R) and 300 < e.get('r', 0) < 6000:
                if near_legend(e['c']) or '예시' in str(e.get('src') or ''):
                    continue
                if strict and not is_symbol_src(e.get('src')):
                    continue
                if e.get('color') in BLUE:
                    blue.append(e['c'])
                elif e.get('color') in RED:
                    red.append(e['c'])
        if blue or red:
            break
    def dedup(pts, tol=800):
        out = []
        for p in pts:
            if not any(math.hypot(p[0]-q[0], p[1]-q[1]) < tol for q in out):
                out.append(p)
        return out
    return dedup(blue), dedup(red)
