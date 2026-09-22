"""유형 자동 판정 + 자동 처리 — 사용자는 파일만 넘긴다.

    python -m rapa_dxf_extract.auto 도면.dxf                # 1개
    python -m rapa_dxf_extract.auto *.dxf --outdir out      # 배치
    python -m rapa_dxf_extract.auto *.dxf --vworld-key KEY  # 지오레퍼런싱까지

유형(A/B/XREF/C)은 코드가 판정하고 그에 맞는 처리를 알아서 고른다.
사용자가 미리 알아야 하는 건 없다. 진행할 수 없는 파일은 '왜 못 하는지'와
'무엇을 주면 되는지'를 한 줄로 알려준다.
"""
import argparse, json, os, sys, traceback

from . import dxf_io, flatten as fl, siteplan, annotations as ann, georef
from .pipeline import run
from .output import leaflet_html

# ── 유형 판정 ─────────────────────────────────────────────────────────
CASE_A, CASE_B, CASE_XREF, CASE_C = 'A', 'B', 'XREF', 'C'

CASE_DESC = {
    CASE_A: '지번 라벨 있음 → 점 GCP 지오코딩 (완전 자동)',
    CASE_B: '지번 없음, 배치도 있음 → 지적경계 형태매칭 (주소 1개 필요)',
    CASE_XREF: '외부참조(XREF) 미bind → 배치도가 파일 안에 없음 (재출력 필요)',
    CASE_C: 'RAPA 옥외배치도 규약 밖 → 수동 확인 필요',
}


def inspect(path):
    """도면을 열지 않고 유형을 판정한다. 반환: dict(진단 결과)."""
    d = {'file': os.path.basename(path), 'path': path}
    d['encoding'] = dxf_io.detect_encoding(path)
    pstats = {}
    model, blocks, base = dxf_io.parse(path, stats=pstats)
    flat = fl.flatten(model, blocks, base)
    d['n_entities'] = len(flat)
    d['acadver'] = pstats.get('acadver')
    d['lossy'] = {t: sum(l.values()) for t, l in (pstats.get('ignored') or {}).items()
                  if t in dxf_io.LOSSY_TYPES}
    d['lossy_report'] = dxf_io.lossy_report(pstats)

    # RAPA 키 / 미해결 XREF (원문 스캔 — code 1 필드는 엔티티에서 덮어써질 수 있다)
    import re as _re
    keys, xrefs = set(), set()
    for e in flat:
        for mm in _re.finditer(r'(m-RAPA-[\d\-]+)', e.get('t') or ''):
            keys.add(mm.group(1))
    dwg_pat = _re.compile(r'([^\s:*?"<>|]{1,120}\.dwg)', _re.I)
    with open(path, 'r', encoding=d['encoding'], errors='replace') as f:
        for line in f:
            if '.dwg' in line or '.DWG' in line:
                for mm in dwg_pat.findall(line.strip()):
                    nm = dxf_io.decode_acad_text(mm).replace(chr(92), '/')
                    xrefs.add(nm.split('/')[-1])
            elif 'm-RAPA-' in line:
                for mm in _re.finditer(r'(m-RAPA-[\d\-]+)', line):
                    keys.add(mm.group(1))
    d['rapa_key'] = sorted(keys)[0] if keys else None
    d['xrefs'] = sorted(xrefs)[:8]

    # 옥외배치도 시트
    try:
        R = siteplan.find_siteplan_region(flat)
        d['region'] = [round(v) for v in R]
    except Exception as e:
        R = None
        d['region'] = None
        d['region_error'] = str(e)

    # 배치도를 못 찾았을 때 '그럼 이 파일엔 뭐가 있었나'를 남긴다 — 시트명이 달라서
    # 실패한 건지 진짜로 배치도가 없는 건지 로그만 보고 구분할 수 있어야 한다.
    d['sheet_titles'] = sorted({(e.get('t') or '').strip() for e in flat
                                if e['T'] in ('TEXT', 'ATTRIB')
                                and '이동통신 구내중계설비' in (e.get('t') or '')
                                and e.get('h', 0) >= 1500})[:12]

    labels = ann.dong_labels(flat, R) if R else {}
    d['n_dong'] = len(labels)
    d['dong'] = sorted(labels)

    parcels = []
    if R:
        cx = (R[0] + R[1]) / 2, (R[2] + R[3]) / 2
        try:
            parcels = georef.cadastral_gcp_candidates(flat, R, cx)
        except Exception:
            parcels = []
    d['n_parcel'] = len(parcels)
    d['parcel'] = [p[0] for p in parcels[:8]]

    # ── 판정 ──
    if R and labels and len(parcels) >= 3:
        d['case'] = CASE_A
    elif R and labels:
        d['case'] = CASE_B
    elif d['xrefs']:
        d['case'] = CASE_XREF
    else:
        d['case'] = CASE_C
    d['case_desc'] = CASE_DESC[d['case']]
    return d


# ── 자동 처리 ─────────────────────────────────────────────────────────
def process(path, outdir='.', vworld_key=None, addr_prefix='', parcel_address=None,
            floors_below=None, gcp_file=None, html=True, log=print, allow_local=False):
    """유형을 판정하고 그에 맞는 처리를 자동 선택해 실행한다."""
    d = inspect(path)
    key = d['rapa_key'] or os.path.splitext(d['file'])[0]
    log(f"\n■ {d['file']}  →  유형 {d['case']}  ({d['case_desc']})")
    log(f"   엔티티 {d['n_entities']:,} · {d.get('acadver') or '버전미상'}/{d['encoding']} · "
        f"동 {d['n_dong']}개 · 지번 {d['n_parcel']}개")
    # 유실 경고는 run() 안의 [1/7]에서 출력된다 — 여기서 또 찍으면 두 번 나온다.
    # (--dry-run은 run()을 안 타므로 main()에서 따로 출력한다.)

    # 유형 판정은 '로그와 원인 분류'를 위한 것이지 처리를 막는 게이트가 아니다.
    # 예전에는 XREF/C로 판정되면 여기서 return 해버려서, 실제로는 멀쩡한 도면이
    # (시트명이 '단지배치도'라는 이유만으로) 시도조차 안 되고 실패로 기록됐다.
    # 이제는 무엇이 의심스러운지만 남기고 끝까지 돌려본다 — 진짜 못 하면 run()이
    # 예외를 내고, 그 예외가 아래 except에서 원인과 함께 기록된다.
    if d['case'] == CASE_XREF:
        log(f"   ⚠ 배치도 영역 탐지 실패 + XREF 참조명 발견: {', '.join(d['xrefs'][:4])}")
        log("      (참조명은 bind된 XREF의 블록 이름 잔재일 수도 있어 단정하지 않습니다. 일단 진행합니다.)")
    elif d['case'] == CASE_C:
        log(f"   ⚠ 배치도 시트를 찾지 못함: {d.get('region_error','')}")
        if d.get('sheet_titles'):
            log(f"      이 파일에서 찾은 시트 타이틀: {' / '.join(d['sheet_titles'][:6])}")
        log("      (시트명·좌표계·XREF 중 무엇인지 미확정. 일단 진행합니다.)")

    # 지오레퍼런싱 소스는 '유형'이 아니라 '실제 지번 라벨 수'로 고른다 —
    # 유형 판정이 틀려도 처리 경로는 영향받지 않게 분리한다.
    kw = dict(rapa_key=key, floors_below=floors_below, addr_prefix=addr_prefix, log=log)
    if allow_local:
        kw['allow_local_coords'] = True
    if d['n_parcel'] >= 3:
        if gcp_file:
            kw['gcp_file'] = gcp_file
        elif vworld_key:
            from .geocoders import VWorldGeocoder
            kw['geocoder'] = VWorldGeocoder(vworld_key)
        elif not allow_local:
            log("   → 지번 GCP를 쓰려면 --vworld-key(실시간) 또는 --gcp-file(사전확보)이 필요합니다.")
            log("      좌표 없이 형상만 보려면 --allow-local 을 붙이세요.")
            d['status'] = 'need_key'
            return d
    else:  # 지번 부족 → 방위표+단일 앵커 / 형태매칭 경로
        addr = parcel_address or addr_prefix
        if vworld_key and addr:
            from .geocoders import VWorldGeocoder, VWorldParcelFetcher
            gc = VWorldGeocoder(vworld_key)
            try:
                pt = gc(addr)
                if pt:
                    kw['north_anchor_latlon'] = pt
                    kw['geocoder'] = gc
            except Exception as e:
                log(f"   ⚠ 앵커 주소 지오코딩 실패 ({addr}): {e}")
            if parcel_address:
                kw['parcel_fetcher'] = VWorldParcelFetcher(vworld_key)
                kw['parcel_address'] = parcel_address
        elif not allow_local:
            miss = []
            if not vworld_key:
                miss.append('--vworld-key')
            if not addr:
                miss.append('--parcel-address (또는 --addr-prefix) "시 구 동 [지번]"')
            log(f"   → 지오레퍼런싱에 {' 와 '.join(miss)} 이(가) 필요합니다.")
            log("      좌표 없이 형상만 보려면 --allow-local 을 붙이세요.")
            d['status'] = 'need_address'
            return d

    os.makedirs(outdir, exist_ok=True)
    # 같은 도면을 다른 프로그램으로 변환한 파일들은 도면 내부 RAPA 키가 동일하다
    # (예: 2202.dxf와 2202-0846.dxf 둘 다 m-RAPA-2202-0846). 배치 처리에서 키만
    # 쓰면 뒤 파일이 앞 결과를 조용히 덮어쓰므로, 충돌 시 원본 파일명을 붙인다.
    out = os.path.join(outdir, f"{key}.json")
    if os.path.exists(out):
        stem = os.path.splitext(d['file'])[0]
        if key != stem:
            key = f"{key}__{stem}"
            out = os.path.join(outdir, f"{key}.json")
            log(f"   · 출력명 충돌 회피 → {os.path.basename(out)}")
    try:
        res = run(path, **kw)
    except Exception as e:
        msg = str(e)
        log(f"   ✗ 처리 실패: {msg}")
        if 'footprint 소스 블록' in msg:
            log("      원인: 동 건물이 이름 있는 블록으로 묶이지 않은 도면입니다 "
                "(XREF bind 시 $TD_AUDIT_GENERATED_* 익명블록이 되는 경우 포함).")
            log("      README '알려진 미해결 이슈'의 3075.dxf 유형 — 자동 추출 미지원 구간입니다.")
        d['status'] = 'error'
        d['error'] = msg
        return d
    json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1)
    log(f"   ✓ 저장 {out}")
    # 관로동 = 옥상형/화단형 무관하게 설치 마커가 확인된 동 (pipeline.py 주석 참조)
    ducts = [b['bld_nm'] for b in res.get('buildings', []) if b.get('is_duct_building')]
    methods = sorted({b.get('equipment_install_method') for b in res.get('buildings', [])
                      if b.get('equipment_install_method')})
    log(f"   · 동 {len(res.get('buildings', []))}개 · 관로동 {len(ducts)}개"
        + (f" ({', '.join(ducts)})" if ducts else "")
        + (f" · 설치방식 {'/'.join(methods)}" if methods else ""))
    if html:
        h = os.path.join(outdir, f"{key}.html")
        open(h, 'w').write(leaflet_html(res, key))
        log(f"   ✓ 지도 {h}")
    d['status'] = 'ok'
    d['out'] = out
    return d


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog='python -m rapa_dxf_extract.auto',
        description='DXF 유형을 자동 판정해 알맞게 처리합니다. 파일만 넘기면 됩니다.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""예시:
  # 1) 무엇이든 일단 넣어본다 (유형만 보고 싶을 때)
  python -m rapa_dxf_extract.auto 도면.dxf --dry-run

  # 2) 지번이 있는 도면(A형) — 키만 주면 끝
  python -m rapa_dxf_extract.auto 도면.dxf --vworld-key KEY

  # 3) 지번이 없는 도면(B형) — 주소 1개 추가
  python -m rapa_dxf_extract.auto 도면.dxf --vworld-key KEY --parcel-address "강원 삼척시 교동 000-0"

  # 4) 폴더 전체 배치 처리
  python -m rapa_dxf_extract.auto *.dxf --outdir out --vworld-key KEY
""")
    ap.add_argument('files', nargs='+', help='DXF 파일 (여러 개 가능)')
    ap.add_argument('--outdir', default='.', help='결과 저장 폴더 (기본: 현재 폴더)')
    ap.add_argument('--vworld-key', default=os.environ.get('VWORLD_KEY'),
                    help='VWorld API 키 (환경변수 VWORLD_KEY로도 지정 가능)')
    ap.add_argument('--parcel-address', default=None, help='B형에서 필요한 주소 1개')
    ap.add_argument('--addr-prefix', default='', help='A형 지번 앞에 붙일 주소 (예: "대구 동구 신암동")')
    ap.add_argument('--gcp-file', default=None, help='사전 확보 GCP json')
    ap.add_argument('--floors-below', type=int, default=None, help='지하 층수')
    ap.add_argument('--dry-run', action='store_true', help='유형만 판정하고 처리하지 않음')
    ap.add_argument('--allow-local', action='store_true',
                    help='지오레퍼런싱 없이 형상만 산출 (WGS84 아님, 지도 오버레이 금지)')
    ap.add_argument('--no-html', action='store_true', help='QA 지도 HTML 생략')
    ap.add_argument('--report', default=None, help='판정 결과 JSON 저장 경로')
    a = ap.parse_args(argv)

    rows = []
    for f in a.files:
        if not os.path.exists(f):
            print(f"\n■ {f}\n   ✗ 파일 없음")
            continue
        try:
            if a.dry_run:
                d = inspect(f)
                print(f"\n■ {d['file']}  →  유형 {d['case']}  ({d['case_desc']})")
                print(f"   엔티티 {d['n_entities']:,} · {d.get('acadver') or '버전미상'}/{d['encoding']} · "
                      f"동 {d['n_dong']}개 · 지번 {d['n_parcel']}개")
                for line in d.get('lossy_report') or []:
                    print("   " + line)
                if d['case'] == CASE_B:
                    print(f"   다음 단계: --vworld-key KEY --parcel-address \"<주소>\"")
                elif d['case'] == CASE_A:
                    print(f"   다음 단계: --vworld-key KEY")
                elif d['case'] == CASE_XREF:
                    print(f"   미해결 XREF: {', '.join(d['xrefs'][:4])} → bind 후 재출력")
            else:
                d = process(f, a.outdir, a.vworld_key, a.addr_prefix, a.parcel_address,
                            a.floors_below, a.gcp_file, not a.no_html,
                            allow_local=a.allow_local)
        except Exception as e:
            print(f"\n■ {os.path.basename(f)}\n   ✗ 오류: {e}")
            traceback.print_exc(limit=2)
            d = {'file': os.path.basename(f), 'case': 'ERROR', 'error': str(e)}
        rows.append(d)

    print("\n" + "─" * 58)
    for c in (CASE_A, CASE_B, CASE_XREF, CASE_C, 'ERROR'):
        n = sum(1 for r in rows if r.get('case') == c)
        if n:
            print(f"  유형 {c:<5} {n}건   {CASE_DESC.get(c,'')}")
    ok = sum(1 for r in rows if r.get('status') == 'ok')
    print(f"  완료 {ok}/{len(rows)}건")
    if a.report:
        json.dump(rows, open(a.report, 'w'), ensure_ascii=False, indent=1, default=str)
        print(f"  판정 결과 저장: {a.report}")


if __name__ == '__main__':
    main()
