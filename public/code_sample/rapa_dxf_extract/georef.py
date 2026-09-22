"""지오레퍼런싱: 지적 라벨 GCP + Helmert(similarity) 적합.
geocoder: callable(addr_str)->(lat,lon)|None. 폐쇄망이면 gcp_file(json)로 대체."""
import json, math, re
import numpy as np

PARCEL_PAT = re.compile(r'^(\d{1,4}(?:-\d{1,3})?)(대|도|전|답|잡|공|천|구|유)$')

def cadastral_gcp_candidates(flat, R, site_center, n_sectors=8, dmin=15000, dmax=150000,
                             want=6):
    """단지 주변 지번 라벨에서 GCP 후보를 고른다.

    섹터당 1개만 남기는 건 GCP가 한쪽에 몰리지 않게 하려는 '선호'이지, 후보를
    버리는 규칙이 아니다. 지번 라벨이 단지 한쪽에만 있는 도면에서 이걸 강제하면
    멀쩡한 후보를 버려 GCP가 3개 미만이 되고 지오레퍼런싱이 통째로 실패한다
    (실측: m-RAPA-1712-03-02-2847 — 거리조건 통과 라벨 5개가 섹터 5·6에 몰려
    있어 2개로 줄고 전멸). 그래서 섹터 대표를 먼저 뽑되, want에 못 미치면
    남은 후보를 거리순으로 채운다. 섹터가 이미 고르게 찬 도면(2202: 8섹터 8개)은
    채울 게 없어 동작이 그대로다."""
    labs = []
    for e in flat:
        if e['T'] == 'TEXT':
            m = PARCEL_PAT.match((e.get('t') or '').strip())
            if m and R[0] <= e.get('p', (0, 0))[0] <= R[1] and R[2] <= e['p'][1] <= R[3]:
                labs.append((m.group(1), e['p'][0], e['p'][1]))
    cx, cy = site_center
    sel, rest = {}, []
    for j, x, y in labs:
        d = math.hypot(x - cx, y - cy)
        if not (dmin < d < dmax):
            continue
        k = int((math.degrees(math.atan2(y - cy, x - cx)) + 180) // (360 / n_sectors))
        cand = (j, x, y, d)
        if k not in sel:
            sel[k] = cand
        elif d < sel[k][3]:
            rest.append(sel[k]); sel[k] = cand
        else:
            rest.append(cand)
    out = list(sel.values())
    if len(out) < want and rest:
        rest.sort(key=lambda t: t[3])
        out += rest[:want - len(out)]
    return [(j, x, y) for j, x, y, _ in out]

def local_meters(lat0, lon0):
    phi = math.radians(lat0)
    mlat = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
    mlon = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)
    return mlat, mlon

def fit_helmert(gcps, fix_scale=None):
    """gcps: [(x_mm, y_mm, lat, lon)]. 반환 transform dict."""
    lat0 = float(np.mean([g[2] for g in gcps]))
    lon0 = float(np.mean([g[3] for g in gcps]))
    mlat, mlon = local_meters(lat0, lon0)
    pts = [(x, y, (lon - lon0) * mlon, (lat - lat0) * mlat) for x, y, lat, lon in gcps]
    if fix_scale is None:
        A, b = [], []
        for x, y, E, N in pts:
            A.append([x, -y, 1, 0]); b.append(E)
            A.append([y,  x, 0, 1]); b.append(N)
        a, bb, tx, ty = np.linalg.lstsq(np.array(A, float), np.array(b, float), rcond=None)[0]
        S = math.hypot(a, bb); th = math.atan2(bb, a)
    else:
        S = fix_scale
        best = None
        for thd in np.arange(0, 360, 0.002):
            t = math.radians(thd); c, s = math.cos(t), math.sin(t)
            Ep = [S * (x * c - y * s) for x, y, _, _ in pts]
            Np = [S * (x * s + y * c) for x, y, _, _ in pts]
            tx = float(np.mean([E - e for (_, _, E, _), e in zip(pts, Ep)]))
            ty = float(np.mean([N - n for (_, _, _, N), n in zip(pts, Np)]))
            r = math.sqrt(np.mean([(e + tx - E) ** 2 + (n + ty - N) ** 2
                                   for (_, _, E, N), e, n in zip(pts, Ep, Np)]))
            if best is None or r < best[0]:
                best = (r, t, tx, ty)
        _, th, tx, ty = best
    c, s = math.cos(th), math.sin(th)
    res = [math.hypot(S * (x * c - y * s) + tx - E, S * (x * s + y * c) + ty - N) for x, y, E, N in pts]
    return dict(S=S, theta=th, theta_deg=math.degrees(th), tx=tx, ty=ty,
                lat0=lat0, lon0=lon0, mlat=mlat, mlon=mlon,
                rms_m=float(np.sqrt(np.mean(np.square(res)))), max_m=float(max(res)), n_gcp=len(gcps))

def make_to_wgs(T):
    c, s = math.cos(T['theta']), math.sin(T['theta'])
    def to_wgs(x, y):
        E = T['S'] * (x * c - y * s) + T['tx']
        N = T['S'] * (x * s + y * c) + T['ty']
        return [round(T['lon0'] + E / T['mlon'], 8), round(T['lat0'] + N / T['mlat'], 8)]
    return to_wgs

def find_north_arrow(flat, R=None, name_hints=('방위', 'north', 'N-'), verbose=False):
    """방위표를 블록 '이름'이 아니라 '구조'로 찾는다: 같은 src(블록) 안에
    CIRCLE 하나와, 그 원 크기와 비슷한 닫힌 폴리곤(화살표 모양, 6~10 꼭짓점)이
    함께 있는 그룹을 후보로 본다. 화살표는 보통 '중심에서 가장 먼 꼭짓점(팁)'
    방향으로 북쪽을 가리키도록 그려진다 (RAPA 표준 관례).
    반환: {'src':.., 'bearing_deg':.., 'circle':.., 'arrow_tip':..} 또는 None
    (여러 후보가 있으면 이름 힌트에 맞는 것 우선, 그다음 원 반지름이 큰 것 우선)
    """
    # 0순위: 도면 내 'N' / 'NORTH' / '북' 텍스트 기반 정식 방위표 탐색
    n_texts = [e for e in flat if e['T'] in ('TEXT', 'ATTRIB') and (e.get('t') or '').strip() in ('N', 'NORTH', '북', '방위', '방위표')]
    if R:
        n_in_R = [e for e in n_texts if R[0] <= e['p'][0] <= R[1] and R[2] <= e['p'][1] <= R[3]]
        if n_in_R:
            n_texts = n_in_R
    for nt in n_texts:
        np_pos = nt['p']
        for e in flat:
            if e['T'] == 'CIRCLE' and math.hypot(e['c'][0]-np_pos[0], e['c'][1]-np_pos[1]) < 25000:
                cc, cr = e['c'], e.get('r', 1000)
                needle_cands = []
                for pe in flat:
                    if pe['T'] == 'POLYLINE':
                        vs = pe.get('verts', [])
                        if len(vs) >= 2:
                            d0 = math.hypot(vs[0][0]-cc[0], vs[0][1]-cc[1])
                            d1 = math.hypot(vs[-1][0]-cc[0], vs[-1][1]-cc[1])
                            if (d0 < cr * 0.3 and cr * 0.7 <= d1 <= cr * 2.0) or (d1 < cr * 0.3 and cr * 0.7 <= d0 <= cr * 2.0):
                                tip = vs[-1] if d0 < d1 else vs[0]
                                ang = math.degrees(math.atan2(tip[1]-cc[1], tip[0]-cc[0]))
                                needle_cands.append((tip, ang))
                    elif pe['T'] == 'LINE':
                        p0, p1 = pe.get('a'), pe.get('b')
                        if p0 and p1:
                            d0 = math.hypot(p0[0]-cc[0], p0[1]-cc[1])
                            d1 = math.hypot(p1[0]-cc[0], p1[1]-cc[1])
                            if (d0 < cr * 0.3 and cr * 0.7 <= d1 <= cr * 2.0) or (d1 < cr * 0.3 and cr * 0.7 <= d0 <= cr * 2.0):
                                tip = p1 if d0 < d1 else p0
                                ang = math.degrees(math.atan2(tip[1]-cc[1], tip[0]-cc[0]))
                                needle_cands.append((tip, ang))
                if needle_cands:
                    best_tip, bearing = min(needle_cands, key=lambda cand: math.hypot(cand[0][0]-np_pos[0], cand[0][1]-np_pos[1]))
                    if verbose:
                        print(f"[find_north_arrow] N-text match: src={e.get('src')} bearing={bearing:.2f}°")
                    return {'src': e.get('src', 'N-symbol'), 'bearing_deg': bearing, 'method': 'N-text-needle'}
                bearing = math.degrees(math.atan2(np_pos[1]-cc[1], np_pos[0]-cc[0]))
                if verbose:
                    print(f"[find_north_arrow] N-text bearing: src={e.get('src')} bearing={bearing:.2f}°")
                return {'src': e.get('src', 'N-symbol'), 'bearing_deg': bearing, 'method': 'N-text-bearing'}

    from collections import defaultdict
    groups = defaultdict(lambda: {'circles': [], 'polys': [], 'lines': []})
    for e in flat:
        src = e.get('src')
        if not src:
            continue
        if R and e['T'] in ('CIRCLE', 'POLYLINE'):
            p = e.get('c') or (e.get('verts') or [(None, None)])[0]
            if p[0] is not None and not (R[0] <= p[0] <= R[1] and R[2] <= p[1] <= R[3]):
                continue
        if e['T'] == 'CIRCLE':
            groups[src]['circles'].append(e)
        elif e['T'] == 'LINE':
            groups[src]['lines'].append(e)
        elif e['T'] == 'POLYLINE':
            vs = e.get('verts') or []
            if len(vs) >= 2 and math.hypot(vs[0][0]-vs[-1][0], vs[0][1]-vs[-1][1]) < 1e-6:
                vs = vs[:-1]  # 닫힘 중복 꼭짓점 제거 (중심점 왜곡 방지)
            closed = e.get('closed') or (len(vs) >= 3)
            if closed and 4 <= len(vs) <= 11:
                groups[src]['polys'].append(vs)

    cands = []
    for src, g in groups.items():
        if len(g['circles']) != 1:
            continue
        circ = g['circles'][0]
        ccenter, cr = circ['c'], circ['r']
        # 방식 A: 닫힌 화살표 폴리곤 (팁 = 중심에서 가장 먼 꼭짓점)
        for vs in g.get('polys', []):
            xs = [v[0] for v in vs]; ys = [v[1] for v in vs]
            diag = math.hypot(max(xs)-min(xs), max(ys)-min(ys))
            pcx, pcy = sum(xs)/len(xs), sum(ys)/len(ys)
            if math.hypot(pcx-ccenter[0], pcy-ccenter[1]) > cr * 2:
                continue
            if not (0.4 * cr * 2 <= diag <= 3.0 * cr * 2):
                continue
            tip = max(vs, key=lambda v: math.hypot(v[0]-pcx, v[1]-pcy))
            bearing = math.degrees(math.atan2(tip[1]-pcy, tip[0]-pcx))
            name_score = 1 if any(h.lower() in str(src).lower() for h in name_hints) else 0
            cands.append((name_score, cr, src, bearing, 'polygon-tip'))
        # 방식 B(폴백): SOLID 등으로 화살표가 그려져 폴리곤이 없는 경우 —
        # 원 주변의 '비수평' 직선(수직에 가까운 지시선)을 북쪽 방향으로 간주
        # (2202류 도면 관례: 짧은 두 변 각도가 지시선)
        if not g.get('polys'):
            angs = []
            for e2 in g.get('lines', []):
                dx, dy = e2['b'][0]-e2['a'][0], e2['b'][1]-e2['a'][1]
                L = math.hypot(dx, dy)
                if L > 0:
                    angs.append((math.degrees(math.atan2(dy, dx)), L))
            verts = [a for a, L in angs if abs(((a % 180) + 180) % 180 - 90) > 30]
            if verts:
                name_score = 1 if any(h.lower() in str(src).lower() for h in name_hints) else 0
                cands.append((name_score, cr, src, verts[0], 'line-fallback'))
    if not cands:
        return None
    cands.sort(key=lambda c: (-c[0], -c[1]))
    _, cr, src, bearing, method = cands[0]
    if verbose:
        print(f"[find_north_arrow] src={src} bearing={bearing:.2f}° method={method} "
              f"(원 r={cr:.0f}, 후보 {len(cands)}개 중 선택)")
    return {'src': src, 'bearing_deg': bearing, 'method': method}


def north_arrow_rotation(flat, R=None):
    """방위표(구조 기반 자동탐지)의 '북쪽' 방향 → 도면을 진북-업으로 맞추는
    회전각(CCW, deg). 못 찾으면 None. 화살표 로컬 +Y(팁 방향)=북 관례를 가정."""
    found = find_north_arrow(flat, R)
    if not found:
        return None
    return 90.0 - found['bearing_deg']


# ---------------------------------------------------------------------------
# 도형(폴리곤) 매칭 기반 지오레퍼런싱 — 지번 라벨이 없는 도면용.
# 도면에 그려진 단지/구역 경계선 자체를 실제 지적 경계 폴리곤(예: VWorld
# 연속지적도)과 형태 대조하여 회전+이동을 동시에 구한다. 점 대응 불필요.
# ---------------------------------------------------------------------------

def _point_seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 < 1e-12:
        return math.hypot(px - ax, py - ay)
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _point_ring_dist(p, ring):
    n = len(ring)
    return min(_point_seg_dist(p, ring[i], ring[(i + 1) % n]) for i in range(n))


def _resample_ring(ring, step_m):
    """폴리곤 둘레를 step_m 간격 점으로 재샘플링 (형태 비교용 점군)."""
    out = []
    n = len(ring)
    for i in range(n):
        a = ring[i]; b = ring[(i + 1) % n]
        seg_len = math.hypot(b[0] - a[0], b[1] - a[1])
        steps = max(1, int(seg_len // step_m))
        for k in range(steps):
            t = k / steps
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def fit_by_shape(drawn_ring_mm, ref_ring_latlon, scale_mm_to_m=1e-3,
                  theta_coarse_step=0.5, theta_fine_step=0.02, sample_step_m=2.0):
    """
    drawn_ring_mm: DXF에서 추출한 단지/구역 경계 폴리곤 [(x_mm,y_mm),...]
    ref_ring_latlon: 실제 지적 경계 폴리곤 [(lat,lon),...] (예: VWorld 연속지적도 응답)
    반환: fit_helmert()와 동일한 형태의 transform dict (+ 'coverage_ratio' 형태매칭 신뢰도)

    점 대응이 필요 없는 이유: 회전각을 촘촘히 스캔하며 두 폴리곤 둘레의
    재샘플링된 점들 사이 평균 최근접-경계 거리를 최소화하는 각도를 찾는다
    (Hausdorff류 형태 정합). 축척은 DXF 도면 축척(기본 1:1000)으로 고정.
    """
    lat0 = sum(p[0] for p in ref_ring_latlon) / len(ref_ring_latlon)
    lon0 = sum(p[1] for p in ref_ring_latlon) / len(ref_ring_latlon)
    mlat, mlon = local_meters(lat0, lon0)
    ref_m = [((lon - lon0) * mlon, (lat - lat0) * mlat) for lat, lon in ref_ring_latlon]

    drawn_m = [(x * scale_mm_to_m, y * scale_mm_to_m) for x, y in drawn_ring_mm]
    dcx = sum(p[0] for p in drawn_m) / len(drawn_m)
    dcy = sum(p[1] for p in drawn_m) / len(drawn_m)
    rcx = sum(p[0] for p in ref_m) / len(ref_m)
    rcy = sum(p[1] for p in ref_m) / len(ref_m)

    ref_samples = _resample_ring(ref_m, sample_step_m)

    def cost(theta_deg):
        t = math.radians(theta_deg)
        c, s = math.cos(t), math.sin(t)
        # drawn 중심 기준 회전 후, 두 도형 중심을 맞춤(평행이동)
        rot = [(c * (x - dcx) - s * (y - dcy), s * (x - dcx) + c * (y - dcy)) for x, y in drawn_m]
        samp = _resample_ring(rot, sample_step_m)
        tx = rcx - 0.0  # 중심정렬: rot는 이미 원점 중심이므로 tx,ty = ref 중심
        ty = rcy - 0.0
        pts = [(x + tx, y + ty) for x, y in samp]
        d = sum(_point_ring_dist(p, ref_m) for p in pts) / len(pts)
        return d, tx, ty

    best = None
    for i in range(int(360 / theta_coarse_step)):
        th = i * theta_coarse_step
        d, tx, ty = cost(th)
        if best is None or d < best[0]:
            best = (d, th, tx, ty)
    # 정밀화
    lo, hi = best[1] - theta_coarse_step, best[1] + theta_coarse_step
    th = lo
    while th <= hi:
        d, tx, ty = cost(th)
        if d < best[0]:
            best = (d, th, tx, ty)
        th += theta_fine_step

    d, theta_deg, tx, ty = best
    theta = math.radians(theta_deg)
    # 회전은 drawn 중심 (dcx,dcy) 기준으로 계산했으므로, mm 원좌표를 그대로
    # 되돌릴 수 있도록 중심을 mm 단위로도 보관해둔다. 실제 변환은
    # make_to_wgs_shape()의 클로저가 (x-dcx0mm 등) 순서 그대로 재현한다.
    x0 = dcx / scale_mm_to_m if scale_mm_to_m else 0
    y0 = dcy / scale_mm_to_m if scale_mm_to_m else 0
    coverage = 1.0 / (1.0 + d)  # 평균잔차(m)가 작을수록 1에 근접하는 대략적 지표

    return {
        'S': scale_mm_to_m, 'theta_deg': theta_deg, 'theta': theta,
        'lat0': lat0, 'lon0': lon0, 'mlat': mlat, 'mlon': mlon,
        'rms_m': d, 'max_m': None, 'n_gcp': None,
        'method': 'parcel_shape_match',
        'coverage_ratio': coverage,
        '_center_drawn_mm': (x0, y0), '_center_ref_m': (rcx, rcy),
    }


def fit_by_north_and_anchor(drawn_ring_mm, flat, anchor_latlon, scale_mm_to_m=1e-3, R=None):
    """지번 라벨도, 필지 형태 대조용 외부폴리곤도 없을 때 쓰는 마지막 수단:
    도면 자체의 방위표(find_north_arrow)로 회전을 구하고, 주소 지오코딩 좌표
    '한 점'을 drawn_ring_mm 중심에 앵커링해 이동을 구한다.
    ⚠ 회전은 방위표 기반이라 신뢰도가 높지만, 위치(이동)는 지오코딩 정확도에
    그대로 의존한다(대형 단지는 주소 지오코딩이 실제 중심에서 수십m 벗어날 수
    있음) — 정밀 위치가 필요하면 parcel_fetcher(형태매칭)나 지번GCP를 쓸 것.
    """
    na = find_north_arrow(flat, R)
    if na is None:
        return None
    theta_deg = 90.0 - na['bearing_deg']
    theta = math.radians(theta_deg)
    c, s = math.cos(theta), math.sin(theta)
    cx = sum(p[0] for p in drawn_ring_mm) / len(drawn_ring_mm)
    cy = sum(p[1] for p in drawn_ring_mm) / len(drawn_ring_mm)
    lat0, lon0 = anchor_latlon
    mlat, mlon = local_meters(lat0, lon0)
    return {
        'S': scale_mm_to_m, 'theta_deg': theta_deg, 'theta': theta,
        'lat0': lat0, 'lon0': lon0, 'mlat': mlat, 'mlon': mlon,
        'rms_m': None, 'max_m': None, 'n_gcp': None,
        'method': f"north_arrow({na['method']}) + single-address-anchor",
        '_center_drawn_mm': (cx, cy), '_center_ref_m': (0.0, 0.0),
    }


def make_to_wgs_shape(T):
    """fit_by_shape() 결과 전용 변환 함수 (중심-회전-재이동 방식이라
    make_to_wgs()와 아핀식이 다름)."""
    c, s = math.cos(T['theta']), math.sin(T['theta'])
    dcx, dcy = T['_center_drawn_mm']
    rcx, rcy = T['_center_ref_m']
    S = T['S']
    def to_wgs(x, y):
        xm, ym = (x - dcx) * S, (y - dcy) * S
        E = c * xm - s * ym + rcx
        N = s * xm + c * ym + rcy
        return [round(T['lon0'] + E / T['mlon'], 8), round(T['lat0'] + N / T['mlat'], 8)]
    return to_wgs


# ---------------------------------------------------------------------------
# v3: 앙상블 지오레퍼런싱 — 가용한 신호를 전부 계산해 상호 검증한다.
# 우선순위로 하나만 골라 쓰지 않는다: 방위표는 회전만 주지만 항상 계산해서
# 다른 방법(점GCP/형태매칭)의 회전과 맞는지 대조한다. 안 맞으면 경고.
# ---------------------------------------------------------------------------

def resolve_georeference(flat, R, cplx_mm, cadastral_gcps=None, parcel_ref_ring=None,
                          north_anchor_latlon=None, agree_tol_deg=5.0, log=print):
    """
    cadastral_gcps: [(x_mm,y_mm,lat,lon), ...] 이미 지오코딩된 지번 GCP (또는 None)
    parcel_ref_ring: [(lat,lon), ...] 실제 지적경계 폴리곤 (parcel_fetcher 결과, 또는 None)
    north_anchor_latlon: (lat,lon) 위치용 단일 앵커 (점GCP/형태매칭 둘 다 없을 때만 위치에 사용)

    반환: {'transform': <최종 채택 변환>, 'candidates': {...}, 'rotation_agreement': {...}}
    """
    candidates = {}

    if cadastral_gcps and len(cadastral_gcps) >= 3:
        candidates['point_gcp'] = fit_helmert(cadastral_gcps, fix_scale=1e-3)

    if parcel_ref_ring:
        candidates['parcel_shape'] = fit_by_shape(cplx_mm, parcel_ref_ring, scale_mm_to_m=1e-3)

    na = find_north_arrow(flat, R)
    if na:
        candidates['north_arrow'] = {'theta_deg': 90.0 - na['bearing_deg'],
                                      'method': f"north_arrow({na['method']})",
                                      'rotation_only': True}

    log(f"[georef] 계산된 방법: {list(candidates)}")

    # --- 회전각 상호검증 ---
    rot_items = [(k, v['theta_deg']) for k, v in candidates.items()]
    agreement = {'pairs': [], 'all_agree': True}
    for i in range(len(rot_items)):
        for j in range(i + 1, len(rot_items)):
            k1, r1 = rot_items[i]; k2, r2 = rot_items[j]
            diff = abs(((r1 - r2 + 180) % 360) - 180)
            ok = diff <= agree_tol_deg
            agreement['pairs'].append({'a': k1, 'b': k2, 'diff_deg': round(diff, 2), 'agree': ok})
            if not ok:
                agreement['all_agree'] = False
                log(f"[georef] ⚠ 회전각 불일치: {k1}={r1:.2f}° vs {k2}={r2:.2f}° (차이 {diff:.1f}° > 허용 {agree_tol_deg}°)")
    if len(rot_items) >= 2 and agreement['all_agree']:
        log(f"[georef] ✓ 회전각 상호검증 통과 ({len(rot_items)}개 방법 모두 {agree_tol_deg}° 이내 일치)")

    # --- 위치(이동) 포함 최종안 채택: 형태매칭 > 점GCP > 방위표+단일앵커 ---
    chosen_key = None
    if 'parcel_shape' in candidates:
        chosen_key = 'parcel_shape'
    elif 'point_gcp' in candidates:
        chosen_key = 'point_gcp'
    elif 'north_arrow' in candidates and north_anchor_latlon:
        chosen_key = 'north_arrow_anchor'
        cx = sum(p[0] for p in cplx_mm) / len(cplx_mm)
        cy = sum(p[1] for p in cplx_mm) / len(cplx_mm)
        theta_deg = candidates['north_arrow']['theta_deg']
        theta = math.radians(theta_deg)
        lat0, lon0 = north_anchor_latlon
        mlat, mlon = local_meters(lat0, lon0)
        candidates['north_arrow_anchor'] = {
            'S': 1e-3, 'theta_deg': theta_deg, 'theta': theta,
            'lat0': lat0, 'lon0': lon0, 'mlat': mlat, 'mlon': mlon,
            'rms_m': None, 'max_m': None, 'n_gcp': None,
            'method': candidates['north_arrow']['method'] + '+single-anchor',
            '_center_drawn_mm': (cx, cy), '_center_ref_m': (0.0, 0.0),
        }

    if chosen_key is None:
        return {'transform': None, 'candidates': candidates, 'rotation_agreement': agreement}

    T = dict(candidates[chosen_key])
    T['n_methods_agreeing'] = len(rot_items)
    T['rotation_agreement'] = agreement
    T['confidence'] = (
        'high' if len(rot_items) >= 2 and agreement['all_agree'] and chosen_key != 'north_arrow_anchor' else
        'medium' if agreement['all_agree'] else
        'low'
    )
    log(f"[georef] 최종 채택: {chosen_key} (confidence={T['confidence']})")
    return {'transform': T, 'candidates': candidates, 'rotation_agreement': agreement, 'chosen': chosen_key}
