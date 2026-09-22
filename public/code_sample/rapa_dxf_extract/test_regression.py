"""회귀 테스트 — 인코딩 자동판정 + LWPOLYLINE 지원이 깨지지 않는지 확인.

    python test_regression.py [도면폴더]

기준선: 같은 DWG를 서로 다른 프로그램으로 변환한 2202.dxf(R12/cp949)와
2202-0846.dxf(AC1032/utf-8)가 **동일한 결과**를 내야 한다.
"""
import json, os, sys, math

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
PKG = os.path.basename(HERE)
_m = __import__(PKG, fromlist=['dxf_io'])
dxf_io, fl, siteplan, ann, fp = (_m.dxf_io, _m.flatten, _m.siteplan,
                                 _m.annotations, _m.footprints)
run = _m.run

EXPECTED_FLOORS = {'101': 19, '102': 21, '103': 22, '104': 23, '105': 23,
                   '106': 23, '107': 21, '108': 20, '109': 10, '201': 13}
EXPECTED_AREA = 21410      # m2, ±1
EXPECTED_VERTS = 89        # 단지경계 꼭짓점

fails = []


def check(cond, msg):
    print(('  ✓ ' if cond else '  ✗ ') + msg)
    if not cond:
        fails.append(msg)


def test_parse(path, want_enc):
    name = os.path.basename(path)
    print(f"\n[{name}]")
    enc = dxf_io.detect_encoding(path)
    check(enc == want_enc, f"인코딩 자동판정 = {enc} (기대 {want_enc})")

    model, blocks, base = dxf_io.parse(path)
    flat = fl.flatten(model, blocks, base)

    # 한글이 깨지지 않았는지 — 지번 라벨(한글 지목)이 살아 있어야 한다
    import re
    parcel = re.compile(r'^\d{1,4}(?:-\d{1,3})?(대|도|전|답|잡|공|천|구|유)$')
    n_parcel = sum(1 for e in flat if e['T'] == 'TEXT'
                   and parcel.match((e.get('t') or '').strip()))
    check(n_parcel > 100, f"지번 라벨 {n_parcel}개 (한글 정상, >100 기대)")

    R = siteplan.find_siteplan_region(flat)
    labels = ann.dong_labels(flat, R)
    check(len(labels) == 10, f"동 라벨 {len(labels)}개 (기대 10)")

    poly, area = fp.complex_polygon(flat, R)
    check(len(poly) == EXPECTED_VERTS, f"단지경계 {len(poly)}꼭짓점 (기대 {EXPECTED_VERTS})")
    check(abs(area - EXPECTED_AREA) < 2, f"단지 면적 {area:.0f}m2 (기대 {EXPECTED_AREA})")
    return flat


def test_pipeline(path, gcp, prefix):
    name = os.path.basename(path)
    print(f"\n[{name}] 파이프라인")
    res = run(path, rapa_key='test', gcp_file=gcp, addr_prefix=prefix,
              floors_below=4, log=lambda *a: None)
    got = {b['bld_nm'][:3]: b['floors_above'] for b in res['buildings']}
    check(got == EXPECTED_FLOORS, f"층수 10개동 일치 ({got if got != EXPECTED_FLOORS else 'OK'})")
    g = res['georeference']
    check(g.get('confidence') == 'high', f"confidence = {g.get('confidence')} (기대 high)")
    check(g.get('gcp_rms_m', 99) < 5, f"GCP RMS = {g.get('gcp_rms_m')}m (기대 <5)")
    return res


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else HERE
    r12 = os.path.join(d, '2202.dxf')
    ac32 = os.path.join(d, '2202-0846.dxf')
    gcp = os.path.join(HERE, 'example_gcp_addr_2202.json')
    prefix = "대구 동구 신암동"

    missing = [p for p in (r12, ac32) if not os.path.exists(p)]
    if missing:
        sys.exit(f"기준 도면 없음: {missing}\n사용: python test_regression.py <도면폴더>")

    print("=" * 60)
    print("회귀 테스트: 같은 DWG → 두 가지 DXF 변환본이 동일 결과를 내야 함")
    print("=" * 60)
    test_parse(r12, 'cp949')     # R12 / 구식 POLYLINE
    test_parse(ac32, 'utf-8')    # AC1032 / LWPOLYLINE

    a = test_pipeline(r12, gcp, prefix)
    b = test_pipeline(ac32, gcp, prefix)

    print("\n[두 변환본 일치 검증]")
    ca = {x['bld_nm']: x['center'] for x in a['buildings']}
    cb = {x['bld_nm']: x['center'] for x in b['buildings']}
    check(set(ca) == set(cb), f"동 목록 동일 ({len(ca)}개)")
    if set(ca) == set(cb):
        dmax = max(math.dist(ca[k], cb[k]) * 111000 for k in ca)
        check(dmax < 0.01, f"동 중심좌표 최대 차이 {dmax:.4f}m (기대 <0.01)")

    print("\n" + "=" * 60)
    if fails:
        print(f"실패 {len(fails)}건:")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("전체 통과")


if __name__ == '__main__':
    main()
