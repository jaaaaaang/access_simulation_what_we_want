"""엔드투엔드 파이프라인: DXF → m-RAPA JSON.
사용:
    from rapa_dxf_extract.pipeline import run
    result = run('2202.dxf', rapa_key='m-RAPA-2202-0846',
                 geocoder=my_geocoder,        # callable('대구 동구 신암동 226-17')->(lat,lon)
                 gcp_file=None)               # 또는 사전 지오코딩된 GCP json
"""
import json, math, re
from . import dxf_io, flatten as fl, siteplan, annotations as ann, footprints as fp, georef, output

def _pip(pt, vs):
    x, y = pt; inside = False; n = len(vs)
    for i in range(n):
        x1, y1 = vs[i]; x2, y2 = vs[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            if x1 + (y - y1) * (x2 - x1) / (y2 - y1) > x:
                inside = not inside
    return inside

def _dist_poly(pt, vs):
    def seg(p, a, b):
        ax, ay = a; bx, by = b; px, py = p
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy + 1e-9)))
        return math.hypot(px - ax - t * dx, py - ay - t * dy)
    return min(seg(pt, vs[i], vs[(i + 1) % len(vs)]) for i in range(len(vs)))

def run(dxf_path, rapa_key='', complex_name='', geocoder=None, gcp_file=None,
        parcel_fetcher=None, parcel_address=None,
        north_anchor_latlon=None,
        addr_prefix='', floors_below=None, res_mm=50.0, log=print,
        allow_local_coords=False):
    """
    geocoder: callable(addr:str)->(lat,lon)|None. 지번 라벨이 도면에 있는 경우.
    gcp_file: 사전 확보한 GCP. (아래 두 포맷 지원, README 참고)
    parcel_fetcher: callable(addr:str)->[(lat,lon),...]|None. 도면에 지번 라벨이
              없을 때 쓰는 대안 — 단지/구역 경계 폴리곤 '형태'를 실제 지적
              경계와 대조해 회전+위치를 동시에 구한다 (georef.fit_by_shape).
              geocoders.VWorldParcelFetcher 등을 주입. parcel_address와 함께 사용.
    parcel_address: parcel_fetcher에 넘길 주소 문자열 (예: "서울 서초구 잠원동 65-33").
    north_anchor_latlon: (lat,lon) 단일 앵커점. 지번도 필지폴리곤 fetcher도 없을 때
              최후 수단 — 도면 자체 방위표(자동탐지, georef.find_north_arrow)로
              회전을, 이 앵커점으로 위치를 구한다. 회전 신뢰도는 높으나 위치는
              지오코딩 정확도에 그대로 의존(대형 단지는 수십m 오차 가능).
    우선순위: geocoder/gcp_file(점매칭) > parcel_fetcher(형태매칭)
              > north_anchor_latlon(방위표+단일앵커) > allow_local_coords
    allow_local_coords: ...
    우선순위: geocoder/gcp_file(지번 점 매칭) > parcel_fetcher(형태매칭) > allow_local_coords
    """
    pstats = {}
    model, blocks, base = dxf_io.parse(dxf_path, stats=pstats)
    log(f"[1/7] parse: model={len(model)} blocks={len(blocks)} "
        f"({pstats.get('acadver') or '버전미상'}/{pstats.get('encoding')})")
    # 곡선 엔티티를 버리고도 조용히 그럴듯한 폴리곤을 내놓는 게 이 파이프라인의
    # 가장 위험한 실패 유형이다 — 버렸으면 반드시 말한다.
    for line in dxf_io.lossy_report(pstats):
        log("  " + line)
    flat = fl.flatten(model, blocks, base)
    log(f"[2/7] flatten: {len(flat)} entities")
    R = siteplan.find_siteplan_region(flat)
    log(f"[3/7] 옥외배치도 영역: x[{R[0]:.0f},{R[1]:.0f}] y[{R[2]:.0f},{R[3]:.0f}]")

    labels = ann.dong_labels(flat, R)
    if not labels:
        raise RuntimeError("동 라벨 미검출")
    polys, srcblk, score = fp.extract_polygons(flat, blocks, R, labels, res=res_mm)
    log(f"[4/7] footprint: {len(polys)}개 동 (src블록={srcblk}, 라벨매칭 {score:.0%})")

    fts = ann.floor_texts(flat, R)
    floors = {n: [] for n in polys}
    for f, u, x, y in fts:
        hit = next((n for n, d in polys.items() if _pip((x, y), d['poly'])), None)
        if hit is None:
            hit = min(polys, key=lambda n: _dist_poly((x, y), polys[n]['poly']))
        floors[hit].append((f, u))
    blue, red = ann.symbol_circles(flat, R)
    MAX_ASSIGN_DIST_MM = 15000  # 15m — 이보다 멀면 어느 동에도 속하지 않는 것으로 간주
    # (실제 배치 심볼은 대상 동 외곽에서 2~6m 이내가 보통. 15m 넘게 떨어진 원은
    #  설치예시도/이동통신인입 예시 같은 인셋 도해 안의 아이콘일 확률이 높음 —
    #  "SCALE: NONE"이 붙은 그런 인셋을 실배치로 오인해 가장 가까운 동에 강제
    #  할당하던 버그가 실제로 있었음(m-RAPA-2202-0846.dxf 201동 오탐 사례).)
    def assign(pts):
        r = {n: 0 for n in polys}
        orphaned = []
        for p in pts:
            hit = next((n for n, d in polys.items() if _pip(p, d['poly'])), None)
            if hit is None:
                cand_n, cand_d = min(
                    ((n, _dist_poly(p, d['poly'])) for n, d in polys.items()),
                    key=lambda t: t[1])
                if cand_d <= MAX_ASSIGN_DIST_MM:
                    hit = cand_n
                else:
                    orphaned.append((p, cand_n, round(cand_d / 1000, 1)))
                    continue
            r[hit] += 1
        return r, orphaned
    duct_c, orphan_blue = assign(blue)
    roof_c, orphan_red = assign(red)
    for p, near_n, dist_m in orphan_red + orphan_blue:
        log(f"  ⚠ 심볼 {p} 제외됨 — 최근접 {near_n}동까지 {dist_m}m (15m 초과, 실배치로 보지 않음. "
            f"인셋/예시도 도해일 가능성)")
    log(f"[5/7] 층수텍스트 {len(fts)} / 파란점 {len(blue)} / 빨간점 {len(red)}")

    cplx_mm, cplx_area = fp.complex_polygon(flat, R)
    cx = sum(p[0] for p in cplx_mm) / len(cplx_mm)
    cy = sum(p[1] for p in cplx_mm) / len(cplx_mm)

    # ---- v3: 앙상블 지오레퍼런싱 — 가용한 신호를 전부 계산해 상호 검증 ----
    # (방위표는 항상 계산해서 다른 방법의 회전과 대조한다. 우선순위로 하나만
    #  고르고 끝내지 않는다 — 그게 이전 버전에서 검증 없이 값을 내놓던 문제였다.)
    gcps = []
    if gcp_file:
        raw = json.load(open(gcp_file, encoding='utf-8'))
        if isinstance(raw, dict):
            cands = georef.cadastral_gcp_candidates(flat, R, (cx, cy))
            for j, x, y in cands:
                key = f"{addr_prefix} {j}".strip()
                if key in raw:
                    lat, lon = raw[key]
                    gcps.append((x, y, lat, lon))
        else:
            gcps = [tuple(g) for g in raw]
        log(f"[6/7] gcp_file: {len(gcps)}개 GCP 로드")
    elif geocoder:
        cands = georef.cadastral_gcp_candidates(flat, R, (cx, cy))
        if not cands:
            log("[6/7] 도면 내 지번 라벨 0개 — geocoder를 호출할 대상이 없음 "
                "(정규식/API 문제 아님. parcel_fetcher/north_anchor 사용을 고려하세요)")
        failed = []
        for j, x, y in cands:
            addr = f"{addr_prefix} {j}".strip()
            ll = geocoder(addr)
            if ll:
                gcps.append((x, y, ll[0], ll[1]))
            else:
                failed.append(addr)
        if cands:
            log(f"[6/7] GCP 지오코딩 {len(gcps)}/{len(cands)}"
                + (f" (실패: {failed})" if failed else ""))

    ref_ring = None
    if parcel_fetcher and parcel_address:
        ref_ring = parcel_fetcher(parcel_address)
        if not ref_ring:
            log(f"[6/7] ⚠ parcel_fetcher가 '{parcel_address}'에 대한 폴리곤을 반환하지 않음")

    resolved = georef.resolve_georeference(
        flat, R, cplx_mm,
        cadastral_gcps=gcps if len(gcps) >= 3 else None,
        parcel_ref_ring=ref_ring,
        north_anchor_latlon=north_anchor_latlon,
        log=log,
    )
    T = resolved['transform']

    if T is not None:
        method = T.get('method', resolved.get('chosen'))
        rms_str = f" RMS/잔차={T['rms_m']:.2f}" if T.get('rms_m') is not None else ""
        log(f"[6/7] 최종 채택: {method} rot={T['theta_deg']:.3f}°{rms_str} "
            f"confidence={T.get('confidence','?')}")
        to_w = georef.make_to_wgs_shape(T) if '_center_drawn_mm' in T else georef.make_to_wgs(T)
    elif allow_local_coords:
        log("[6/7] ⚠ 계산 가능한 지오레퍼런싱 신호 없음 — allow_local_coords=True로 "
            "DXF 원본 mm 좌표를 'ungeoreferenced'로 표시하여 산출합니다. WGS84 아님, 지도 오버레이 불가.")
        to_w = lambda x, y: [round(x, 1), round(y, 1)]
    else:
        raise RuntimeError(
            "지오레퍼런싱 실패: geocoder/gcp_file(지번 점매칭), parcel_fetcher+parcel_address"
            "(지적경계 형태매칭), north_anchor_latlon(방위표+단일앵커) 중 아무것도 유효하지 않습니다. "
            "WGS84 변환 없이 결과를 내면 좌표가 틀린 채로 조용히 나가므로 기본적으로 중단합니다. "
            "디버그 목적이면 allow_local_coords=True를 명시하세요."
        )

    buildings = []
    for n in sorted(polys):
        poly = polys[n]['poly']
        w = [to_w(x, y) for x, y in poly]
        if w and w[0] != w[-1]:
            w.append(w[0])
        pcx = sum(p[0] for p in poly) / len(poly)
        pcy = sum(p[1] for p in poly) / len(poly)
        cw = to_w(pcx, pcy)
        fmax = max((f for f, u in floors[n]), default=None)
        # 관로동(is_duct_building) 정의 — 중요: "화단형(파란점) 심볼이 있는 동"이 아니라
        # "장비(옥상형이든 화단형이든)가 실제로 설치/예정된 동 = 관로가 깔린 동"이다.
        # 옥상형 안테나 위치도 관로를 통해 급전선/광케이블이 인입되므로, 설치 마커가
        # 하나라도 확인된 동은 전부 관로동이다. duct_marker_count/rooftop_repeater_count로
        # 어떤 방식인지는 별도로 남겨두되, is_duct_building은 이 둘의 합으로 판정한다.
        has_equipment = (duct_c[n] + roof_c[n]) > 0
        buildings.append({
            'ciss_bld_cd': f"N{cw[0]:.5f} {cw[1]:.5f}" if T else None,
            'bld_nm': f"{n}동",
            'floors_above': fmax,
            'floors_below': floors_below,
            'height': round(fmax * 2.9, 1) if fmax else None,
            'height_note': 'estimated: floors_above x 2.9m',
            'is_duct_building': has_equipment,
            'duct_marker_count': duct_c[n],
            'rooftop_repeater_count': roof_c[n],
            'equipment_install_method': (
                'rooftop+flowerbed' if duct_c[n] > 0 and roof_c[n] > 0 else
                'rooftop' if roof_c[n] > 0 else
                'flowerbed' if duct_c[n] > 0 else None),
            'floor_marks': sorted({f"{f}F({u}U)" if u else f"{f}F" for f, u in floors[n]}, reverse=True),
            'center': cw,
            'polygon': w,
            'footprint_area_m2': polys[n]['area_m2'],
        })
    cplx_w = [to_w(x, y) for x, y in cplx_mm]
    if cplx_w[0] != cplx_w[-1]:
        cplx_w.append(cplx_w[0])
    result = output.build_json(rapa_key, complex_name, cplx_w, buildings, T,
                               f"dxf_extraction({dxf_path.split('/')[-1]} 옥외배치도)")
    result['complex']['area_m2'] = round(cplx_area, 1)
    if T is None:
        result['georeference'] = {
            'method': 'NONE — ungeoreferenced',
            'warning': 'geocoder/gcp_file 미제공. polygon/center 좌표는 WGS84가 아닌 '
                        'DXF 원본 mm 좌표입니다. 지도 오버레이·거리계산에 사용 금지.'}
    log(f"[7/7] JSON 완성: {len(buildings)}개 동, 단지 {cplx_area:.0f}m2")
    return result
