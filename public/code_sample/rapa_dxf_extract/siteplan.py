"""옥외배치도 시트 영역 자동 탐지 (RAPA 표준 도곽 ATTRIB 타이틀 기반)."""
import re

# RAPA 도면은 배치도 시트를 '옥외배치도' 또는 '단지배치도'로 쓴다 (도면 세트마다 다름).
# 하나만 알면 다른 쪽 도면이 통째로 '배치도 없음'으로 오판된다 — 실측: m-RAPA-2310-3755,
# m-RAPA-1712-03-02-2847 둘 다 '이동통신 구내중계설비 단지배치도'.
SHEET_TITLE_PAT = re.compile(r'(?:옥외|단지)\s*배치도')

def find_siteplan_region(flat, y_top=None):
    """타이틀 ATTRIB/TEXT('...옥외배치도') x좌표와 인접 시트 타이틀 간격으로 시트 x범위 추정.
    반환: (X0, X1, Y0, Y1)"""
    big, small = [], []
    for e in flat:
        t = e.get('t', '') or ''
        if e['T'] in ('TEXT', 'ATTRIB') and SHEET_TITLE_PAT.search(t):
            # 도곽 하단 정식 타이틀: '이동통신 구내중계설비 옥외배치도' (h 큼) — 시트 중심 x에 위치
            (big if ('이동통신' in t and e.get('h', 0) >= 2000) else small).append(e['p'])
    if not (big or small):
        raise RuntimeError("옥외배치도 타이틀을 찾지 못함")
    tx, ty = (big or small)[0]
    # 모든 시트 타이틀 후보('이동통신 구내중계설비 ...') x 좌표 → 간격 중앙값
    all_t = sorted(set(round(e['p'][0]) for e in flat
                       if e['T'] in ('TEXT', 'ATTRIB')
                       and '이동통신' in (e.get('t', '') or '') and e.get('h', 0) > 2000))
    gaps = [b - a for a, b in zip(all_t, all_t[1:]) if b - a > 50000]
    W = min(gaps) if gaps else 340000
    X0, X1 = tx - W / 2, tx + W / 2
    H = W * 0.75                       # 시트 높이 (도곽 가로:세로 비)

    # y창은 '도면이 CAD 공간 어디에 놓였는지'를 가정하면 안 된다.
    # 이전 버전은 Y0=0으로 고정했는데, 그건 2202 도면이 우연히 y≈0에 있었기 때문이고
    # 도면마다 다르다 — m-RAPA-1712-03-02-2847은 전체가 y≈-150만에 있어서
    # y창이 [0, -1315293]이라는 뒤집힌 빈 구간이 되고 동라벨이 0개가 됐다.
    # 절대값도 답이 아니다(|y|=131만~159만이라 [0, H]와 여전히 안 겹친다).
    # 그래서 가정하지 않고 찾는다: x창 안 텍스트의 y를 훑어 폭 H짜리 창 중
    # 텍스트가 가장 빽빽한 구간을 고른다. 배치도 시트는 텍스트가 몰려 있고
    # 시트 사이 여백은 비어 있어 경계가 자연히 잡힌다. 부호도 원점도 안 가정한다.
    ys = sorted(e['p'][1] for e in flat if e['T'] in ('TEXT', 'ATTRIB')
                and X0 <= e['p'][0] <= X1)
    if y_top is not None:
        return X0, X1, 0, min(y_top, H)
    if not ys:
        return X0, X1, 0, H
    best_n, Y0, j = -1, ys[0], 0
    for i, y in enumerate(ys):
        if j < i:
            j = i
        while j < len(ys) and ys[j] <= y + H:
            j += 1
        if j - i > best_n:
            best_n, Y0 = j - i, y
    return X0, X1, Y0, Y0 + H
