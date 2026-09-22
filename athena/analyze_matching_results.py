#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apt_list.csv의 모든 아파트에 대해 단지 폴리곤 매칭 여부를 확인하고
매칭/미매칭 목록을 생성하는 스크립트
"""

import csv
import json
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
    if not df.empty:
        return True, int(df.iloc[0]['bld_cplx_inf_id']), df.iloc[0]['cplx_scl_nm']
    return False, None, None


def main():
    csv_path = 'public/apt_list.csv'
    output_matched = 'athena/matched_apartments.json'
    output_unmatched = 'athena/unmatched_apartments.json'

    log(f'CSV 파일 읽기: {csv_path}')

    # CSV 읽기 (건물명 포함)
    apartments = []
    with open(csv_path, encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rapa_key = row.get('RAPA식별코드', '')
            building_name = row.get('공사명', row.get('건물명/도로명', ''))
            try:
                lat = float(row.get('위도', ''))
                lng = float(row.get('경도', ''))
                if lat and lng:
                    apartments.append({
                        'rapa_key': rapa_key,
                        'building_name': building_name,
                        'lat': lat,
                        'lng': lng
                    })
            except (ValueError, TypeError):
                pass

    log(f'유효한 아파트: {len(apartments)}개')

    # Athena 연결
    try:
        conn = get_connection()
        log('Athena 연결 성공\n')
    except Exception as e:
        log(f'Athena 연결 실패: {e}')
        sys.exit(1)

    # 조회 진행
    matched = []
    unmatched = []

    try:
        from tqdm import tqdm
        iterator = tqdm(apartments, file=sys.stderr, desc="단지 폴리곤 매칭 확인")
    except ImportError:
        iterator = apartments

    for apt in iterator:
        try:
            is_matched, complex_id, complex_name = check_complex_polygon(
                conn, apt['lat'], apt['lng']
            )
            if is_matched:
                matched.append({
                    'rapa_key': apt['rapa_key'],
                    'building_name': apt['building_name'],
                    'lat': apt['lat'],
                    'lng': apt['lng'],
                    'complex_id': complex_id,
                    'complex_name': complex_name
                })
            else:
                unmatched.append({
                    'rapa_key': apt['rapa_key'],
                    'building_name': apt['building_name'],
                    'lat': apt['lat'],
                    'lng': apt['lng']
                })
        except Exception as e:
            log(f'[ERROR] {apt["rapa_key"]}: {e}')
            unmatched.append({
                'rapa_key': apt['rapa_key'],
                'building_name': apt['building_name'],
                'lat': apt['lat'],
                'lng': apt['lng'],
                'error': str(e)
            })

    # 결과 저장
    matched_result = {
        'timestamp': datetime.now().isoformat(),
        'total': len(matched),
        'apartments': matched
    }

    unmatched_result = {
        'timestamp': datetime.now().isoformat(),
        'total': len(unmatched),
        'apartments': unmatched
    }

    with open(output_matched, 'w', encoding='utf-8') as f:
        json.dump(matched_result, f, ensure_ascii=False, indent=2)

    with open(output_unmatched, 'w', encoding='utf-8') as f:
        json.dump(unmatched_result, f, ensure_ascii=False, indent=2)

    # 요약 출력
    log('\n' + '='*80)
    log('📊 최종 결과')
    log('='*80)
    log(f'총 아파트 수: {len(apartments)}개')
    log(f'✅ 매칭: {len(matched)}개 ({len(matched)/len(apartments)*100:.1f}%)')
    log(f'❌ 미매칭: {len(unmatched)}개 ({len(unmatched)/len(apartments)*100:.1f}%)')
    log('='*80)
    log(f'\n매칭 결과 저장: {output_matched}')
    log(f'미매칭 결과 저장: {output_unmatched}')

    # stdout으로 간단한 요약
    print(json.dumps({
        'total': len(apartments),
        'matched': len(matched),
        'unmatched': len(unmatched),
        'match_rate': round(len(matched)/len(apartments)*100, 2),
        'output_matched': output_matched,
        'output_unmatched': output_unmatched
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
