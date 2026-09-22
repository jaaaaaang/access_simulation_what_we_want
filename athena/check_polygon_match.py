#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apt_list.csv의 모든 위경도에 대해 o_moira.ap_bld_cplx_inf 단지 폴리곤 매칭 여부 확인
"""

import csv
import sys
from datetime import datetime


def log(*args):
    """stderr로 로그 출력"""
    print(*args, file=sys.stderr)


def get_connection():
    from idcube_hive_connector import connector
    return connector.connect_idcube_athena()


def check_complex_polygon(conn, lat: float, lng: float):
    """단지 폴리곤 내부에 좌표가 포함되는지 확인"""
    import pandas as pd

    query = f"""
        SELECT bld_cplx_inf_id, cplx_scl_nm
        FROM o_moira.ap_bld_cplx_inf
        WHERE cplx_mcl_nm = '아파트'
          AND ST_Contains(ST_GeomFromBinary(pygn_geo), ST_Point({lng:.8f}, {lat:.8f}))
        LIMIT 1
    """
    df = pd.read_sql_query(query, conn)
    return not df.empty, df.iloc[0]['bld_cplx_inf_id'] if not df.empty else None


def main():
    csv_path = 'public/apt_list.csv'

    log(f'CSV 파일 읽기 시작: {csv_path}')

    # CSV 읽기
    coords = []
    with open(csv_path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rapa_key = row.get('RAPA식별코드', '')
            try:
                lat = float(row.get('위도', ''))
                lng = float(row.get('경도', ''))
                if lat and lng:
                    coords.append((rapa_key, lat, lng))
            except (ValueError, TypeError):
                pass

    log(f'유효한 좌표: {len(coords)}개')
    log('='*60)

    # Athena 연결
    try:
        conn = get_connection()
        log('Athena 연결 성공')
    except Exception as e:
        log(f'Athena 연결 실패: {e}')
        sys.exit(1)

    # 진행 상황 표시
    matched = 0
    unmatched = 0
    matched_list = []
    unmatched_list = []

    try:
        from tqdm import tqdm
        iterator = tqdm(coords, file=sys.stderr, desc="단지 폴리곤 매칭 확인")
    except ImportError:
        iterator = coords
        log('tqdm 미설치, 진행률 표시 없이 실행')

    for i, (rapa_key, lat, lng) in enumerate(iterator):
        try:
            is_matched, complex_id = check_complex_polygon(conn, lat, lng)
            if is_matched:
                matched += 1
                matched_list.append((rapa_key, complex_id))
            else:
                unmatched += 1
                unmatched_list.append(rapa_key)
        except Exception as e:
            log(f'[ERROR] {rapa_key}: {e}')
            unmatched += 1
            unmatched_list.append(rapa_key)

    # 결과 출력
    log('='*60)
    log('📊 최종 결과')
    log('='*60)
    log(f'총 아파트 수: {len(coords)}개')
    log(f'✅ 단지 폴리곤 매칭: {matched}개 ({matched/len(coords)*100:.1f}%)')
    log(f'❌ 단지 폴리곤 미매칭: {unmatched}개 ({unmatched/len(coords)*100:.1f}%)')
    log('='*60)

    # stdout으로 JSON 결과 출력 (프로그램에서 사용 가능)
    import json
    result = {
        'timestamp': datetime.now().isoformat(),
        'total': len(coords),
        'matched': matched,
        'unmatched': unmatched,
        'match_rate': round(matched/len(coords)*100, 2),
        'matched_list': [{'rapa_key': k, 'complex_id': int(c)} for k, c in matched_list[:10]],  # 처음 10개만
        'unmatched_list': unmatched_list[:10],  # 처음 10개만
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
