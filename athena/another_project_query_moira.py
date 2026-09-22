#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MOIRA Athena 조회 스크립트 — apt_list.csv 대상(RAPA Key, 위경도)을 기준으로
o_moira.ap_bld_cplx_inf(단지 폴리곤) → o_moira.ac_bld_bas(건물 폴리곤)를
DB_structure.pdf §3-2/§3-4 에 정의된 공간조인(ST_CONTAINS) 그대로 재현한다.

연결 방식은 장영우님이 주신 daily_tmap_querying_k() 예시와 동일하게
idcube_hive_connector.connector.connect_idcube_athena() + pandas.read_sql_query 사용.
사내망(idcube 접근 가능한 환경)에서만 동작하며, 이 저장소 자체(Cowork 샌드박스)에서는
idcube_hive_connector 패키지가 없어 실행/테스트가 불가능함 — 사내망에서 직접 검증 필요.

사용법:
  # 1) 단건 조회 (Node 서버가 child_process로 호출하는 용도, stdout에 JSON 1줄만 출력)
  python athena/query_moira.py single --rapa-key m-RAPA-2305-1745 --lat 37.40080703 --lng 126.9472091

  # 2) 배치 조회 (apt_list.csv 전체를 미리 조회해 정적 JSON 캐시로 저장 — 프론트가 오프라인/사내망 밖에서도 볼 수 있게)
  python athena/query_moira.py batch --csv apt_list.csv --out public/complex_polygons.json

옵션:
  --bld-usg-filter  ac_bld_bas.bld_lcl_nm 필터값 (기본 '주택', bbox 폴백 쿼리에만 적용 — PDF §3-3과 동일)
  --complex-buffer  단지 폴리곤을 못 찾았을 때 폴백으로 쓰는 BBox 반경(도 단위, 기본 0.005 ≈ 약 500m, PDF §3-3과 동일)
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone


def log(*args):
    """stdout은 single 모드에서 JSON 전용으로 써야 하므로 로그는 항상 stderr로."""
    print(*args, file=sys.stderr)


# ---------------------------------------------------------------------------
# WKT 파서 (Presto/Trino ST_AsText 출력 형식: "POLYGON((lon lat, lon lat, ...))")
# shapely가 있으면 그걸 쓰고, 없으면 의존성 추가 없이 직접 파싱한다.
# ---------------------------------------------------------------------------
def parse_wkt_polygon(wkt: str):
    if not wkt:
        return None
    try:
        from shapely import wkt as shapely_wkt  # type: ignore
        geom = shapely_wkt.loads(wkt)
        if geom.geom_type == 'Polygon':
            return [[x, y] for x, y in geom.exterior.coords]
        if geom.geom_type == 'MultiPolygon':
            first = list(geom.geoms)[0]
            return [[x, y] for x, y in first.exterior.coords]
        return None
    except ImportError:
        pass
    except Exception as e:
        log(f"[WARN] shapely 파싱 실패, 수동 파서로 폴백: {e}")

    # 수동 파서: POLYGON((...)) / MULTIPOLYGON(((...)))의 첫 번째 링만 추출
    m = re.search(r'\(\(([^()]+)\)\)', wkt)
    if not m:
        return None
    ring_txt = m.group(1)
    points = []
    for pair in ring_txt.split(','):
        parts = pair.strip().split()
        if len(parts) >= 2:
            try:
                points.append([float(parts[0]), float(parts[1])])
            except ValueError:
                continue
    return points if len(points) >= 3 else None


# ---------------------------------------------------------------------------
# Athena 연결 (idcube_hive_connector) — 사내망 전용, 이 저장소에서는 import 시점에 실패함
# ---------------------------------------------------------------------------
def get_connection():
    from idcube_hive_connector import connector  # noqa: 사내 전용 패키지
    return connector.connect_idcube_athena()


def find_complex_polygon(conn, lat: float, lng: float):
    """DB_structure.pdf §3-2 공간조인: ailayer.lat/lng ∈ ap_bld_cplx_inf.pygn_geo
    여기서는 ailayer_apt_5g 테이블 대신 apt_list.csv에서 얻은 lat/lng를 직접 리터럴로 사용."""
    import pandas as pd

    query = f"""
        SELECT
            bld_cplx_inf_id,
            cplx_type_div_id,
            cplx_lcl_nm,
            cplx_mcl_nm,
            cplx_scl_nm,
            ST_AsText(ST_GeomFromBinary(pygn_geo)) AS wkt
        FROM o_moira.ap_bld_cplx_inf
        WHERE cplx_mcl_nm = '아파트'
          AND ST_Contains(ST_GeomFromBinary(pygn_geo), ST_Point({lng:.8f}, {lat:.8f}))
        LIMIT 1
    """
    df = pd.read_sql_query(query, conn)
    if df.empty:
        return None
    row = df.iloc[0]
    polygon = parse_wkt_polygon(row['wkt'])
    if not polygon:
        return None
    return {
        'bld_cplx_inf_id': int(row['bld_cplx_inf_id']) if row['bld_cplx_inf_id'] is not None else None,
        'cplx_scl_nm': row.get('cplx_scl_nm'),
        'polygon': polygon,
    }


def find_buildings_in_complex(conn, complex_id: int, buffer_deg: float = 0.00135):
    """DB_structure.pdf §3-4 공간포함: ap_bld_cplx_inf ⋈ ac_bld_bas (ST_Buffer 150m 확장)"""
    import pandas as pd

    query = f"""
        SELECT
            b.ciss_bld_cd, b.bld_nm, b.bld_lcl_nm, b.bld_scl_nm,
            b.grud_flor_cnt, b.bsmt_flor_cnt, b.bld_hght,
            b.bld_in_lng, b.bld_in_lat,
            ST_AsText(ST_GeomFromBinary(b.geo)) AS wkt
        FROM o_moira.ap_bld_cplx_inf c
        JOIN o_moira.ac_bld_bas b
          ON ST_Intersects(ST_Buffer(ST_GeomFromBinary(c.pygn_geo), {buffer_deg:.6f}), ST_Point(b.bld_in_lng, b.bld_in_lat))
        WHERE c.bld_cplx_inf_id = '{complex_id}'
    """
    return pd.read_sql_query(query, conn)


def find_buildings_bbox_fallback(conn, lat: float, lng: float, buffer_deg: float = 0.0036, bld_usg_filter: str = None):
    """단지 미발견 시: ~400m 반경 건물 조회."""
    import pandas as pd

    where_filter = f"AND bld_lcl_nm = '{bld_usg_filter}'" if bld_usg_filter else ""
    query = f"""
        SELECT
            ciss_bld_cd, bld_nm, bld_lcl_nm, bld_scl_nm,
            grud_flor_cnt, bsmt_flor_cnt, bld_hght,
            bld_in_lng, bld_in_lat,
            ST_AsText(ST_GeomFromBinary(geo)) AS wkt
        FROM o_moira.ac_bld_bas
        WHERE bld_in_lng BETWEEN {lng - buffer_deg:.8f} AND {lng + buffer_deg:.8f}
          AND bld_in_lat BETWEEN {lat - buffer_deg:.8f} AND {lat + buffer_deg:.8f}
          {where_filter}
    """
    return pd.read_sql_query(query, conn)


def buildings_df_to_list(df):
    buildings = []
    for _, row in df.iterrows():
        polygon = parse_wkt_polygon(row.get('wkt'))
        buildings.append({
            'ciss_bld_cd': row.get('ciss_bld_cd'),
            'bld_nm': row.get('bld_nm'),
            'floors_above': None if pd_isna(row.get('grud_flor_cnt')) else int(row.get('grud_flor_cnt')),
            'floors_below': None if pd_isna(row.get('bsmt_flor_cnt')) else int(row.get('bsmt_flor_cnt')),
            'height': None if pd_isna(row.get('bld_hght')) else float(row.get('bld_hght')),
            'center': [row.get('bld_in_lng'), row.get('bld_in_lat')],
            'polygon': polygon,
        })
    return buildings


def pd_isna(v):
    try:
        import pandas as pd
        return pd.isna(v)
    except Exception:
        return v is None


def query_one_target(conn, rapa_key: str, lat: float, lng: float, buffer_150m: float = 0.00135, fallback_400m: float = 0.0036, bld_usg_filter: str = None):
    result = {
        'rapaKey': rapa_key,
        'queriedAt': datetime.now(timezone.utc).isoformat(),
        'complex': None,
        'buildingSource': None,
        'buildings': [],
    }
    try:
        complex_info = find_complex_polygon(conn, lat, lng)
    except Exception as e:
        log(f"[{rapa_key}] 단지 폴리곤 조회 실패: {e}")
        complex_info = None

    if complex_info and complex_info.get('bld_cplx_inf_id'):
        # [케이스 1] 단지 발견 → 단지 ID로 외곽 150m 버퍼 확장 건물 조회
        result['complex'] = complex_info
        complex_id = complex_info['bld_cplx_inf_id']
        try:
            bdf = find_buildings_in_complex(conn, complex_id, buffer_150m)
            result['buildingSource'] = 'complex_150m_buffer'
        except Exception as e:
            log(f"[{rapa_key}] 단지 내 건물 조회 실패, 400m 가상 BBox 폴백 시도: {e}")
            bdf = find_buildings_bbox_fallback(conn, lat, lng, fallback_400m, bld_usg_filter)
            result['buildingSource'] = 'virtual_400m_bbox'
    else:
        # [케이스 2] 단지 미발견 → 400m 사각형 가상 단지 폴리곤 생성 및 해당 영역 건물 조회
        d = fallback_400m
        virtual_polygon = [
            [lng - d, lat - d],
            [lng + d, lat - d],
            [lng + d, lat + d],
            [lng - d, lat + d],
            [lng - d, lat - d],
        ]
        result['complex'] = {
            'bld_cplx_inf_id': None,
            'cplx_scl_nm': '가상영역(400m)',
            'polygon': virtual_polygon,
        }
        bdf = find_buildings_bbox_fallback(conn, lat, lng, fallback_400m, bld_usg_filter)
        result['buildingSource'] = 'virtual_400m_bbox'

    result['buildings'] = buildings_df_to_list(bdf)
    return result


def cmd_single(args):
    try:
        conn = get_connection()
    except Exception as e:
        print(json.dumps({'error': f'Athena 연결 실패 (idcube_hive_connector 확인 필요): {e}'}, ensure_ascii=False))
        sys.exit(1)

    try:
        result = query_one_target(
            conn,
            args.rapa_key,
            args.lat,
            args.lng,
            buffer_150m=args.buffer_150m,
            fallback_400m=args.fallback_400m,
            bld_usg_filter=args.bld_usg_filter
        )
    except Exception as e:
        print(json.dumps({'error': f'조회 실패: {e}'}, ensure_ascii=False))
        sys.exit(1)

    # single 모드는 stdout에 JSON 한 줄만 출력 (Node 쪽에서 그대로 파싱)
    print(json.dumps(result, ensure_ascii=False))


def run_batch(csv_path: str, out_path: str = None, rapa_keys=None, limit: int = None,
              buffer_150m: float = 0.00135, fallback_400m: float = 0.0036, bld_usg_filter: str = None, conn=None):
    """batch 조회의 핵심 로직. CLI(cmd_batch)와 Flask 라우트(api.py의 배치 엔드포인트) 양쪽에서
    같은 함수를 재사용한다 — Flask 쪽은 매 요청마다 서브프로세스를 띄우지 않고 이 함수를 직접 import해서 호출.
    out_path가 주어지면 그 경로에 JSON도 같이 저장하고(cmd_batch와 동일 동작), 항상 결과 dict를 반환한다.
    conn을 외부에서 주입할 수도 있음(예: Flask 앱이 커넥션을 재사용하고 싶은 경우) — 없으면 새로 연결."""
    import csv as csv_mod

    own_conn = conn is None
    if own_conn:
        conn = get_connection()

    with open(csv_path, encoding='utf-8-sig') as f:
        rows = list(csv_mod.DictReader(f))

    if rapa_keys:
        rows = [r for r in rows if r.get('RAPA식별코드') in rapa_keys]
    if limit:
        rows = rows[:limit]

    log(f'대상 {len(rows)}건 조회 시작')

    try:
        from tqdm import tqdm  # type: ignore
        iterator = tqdm(rows, file=sys.stderr)
    except ImportError:
        iterator = rows

    targets = {}
    failed = []
    for row in iterator:
        rapa_key = row.get('RAPA식별코드')
        try:
            lat = float(row.get('위도'))
            lng = float(row.get('경도'))
        except (TypeError, ValueError):
            log(f'[SKIP] {rapa_key}: 위경도 없음/파싱 실패')
            continue
        if not rapa_key:
            continue
        try:
            targets[rapa_key] = query_one_target(
                conn,
                rapa_key,
                lat,
                lng,
                buffer_150m=buffer_150m,
                fallback_400m=fallback_400m,
                bld_usg_filter=bld_usg_filter
            )
        except Exception as e:
            log(f'[FAIL] {rapa_key}: {e}')
            failed.append(rapa_key)

    output = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'sourceCsv': csv_path,
        'failed': failed,
        'targets': targets,
    }

    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        log(f'완료: {len(targets)}건 성공, {len(failed)}건 실패 → {out_path}')
    else:
        log(f'완료: {len(targets)}건 성공, {len(failed)}건 실패 (파일 저장 없음)')

    return output


def cmd_batch(args):
    try:
        conn = get_connection()
    except Exception as e:
        log(f'Athena 연결 실패 (idcube_hive_connector 확인 필요): {e}')
        sys.exit(1)

    run_batch(
        csv_path=args.csv,
        out_path=args.out,
        rapa_keys=args.rapa_key,
        limit=args.limit,
        buffer_150m=args.buffer_150m,
        fallback_400m=args.fallback_400m,
        bld_usg_filter=args.bld_usg_filter,
        conn=conn,
    )


def main():
    parser = argparse.ArgumentParser(description='MOIRA Athena 단지/건물 폴리곤 조회')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_single = sub.add_parser('single', help='RAPA Key 1건 조회 (Node 서버 child_process 호출용)')
    p_single.add_argument('--rapa-key', required=True)
    p_single.add_argument('--lat', required=True, type=float)
    p_single.add_argument('--lng', required=True, type=float)
    p_single.add_argument('--buffer-150m', type=float, default=0.00135, help='단지 외곽 확장 버퍼 (기본 150m = 0.00135도)')
    p_single.add_argument('--fallback-400m', type=float, default=0.0036, help='단지 미발견 시 가상 단지 BBox 반경 (기본 400m = 0.0036도)')
    p_single.add_argument('--bld-usg-filter', default=None, help='건물 용도 필터 (기본값 없음: 전체 용도)')
    p_single.set_defaults(func=cmd_single)

    p_batch = sub.add_parser('batch', help='apt_list.csv 전체(or 필터) 배치 조회 → JSON 캐시 파일 생성')
    p_batch.add_argument('--csv', default='apt_list.csv')
    p_batch.add_argument('--out', default='public/complex_polygons.json')
    p_batch.add_argument('--rapa-key', action='append', help='특정 RAPA Key만 조회 (반복 지정 가능)')
    p_batch.add_argument('--limit', type=int, default=None)
    p_batch.add_argument('--buffer-150m', type=float, default=0.00135, help='단지 외곽 확장 버퍼 (기본 150m = 0.00135도)')
    p_batch.add_argument('--fallback-400m', type=float, default=0.0036, help='단지 미발견 시 가상 단지 BBox 반경 (기본 400m = 0.0036도)')
    p_batch.add_argument('--bld-usg-filter', default=None, help='건물 용도 필터 (기본값 없음: 전체 용도)')
    p_batch.set_defaults(func=cmd_batch)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
