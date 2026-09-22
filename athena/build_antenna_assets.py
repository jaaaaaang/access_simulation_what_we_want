#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
인접 무선시설(안테나) 배치 캐시 빌더 — o_iam.celp_fgru_antenna

규격서: public/guide/ant_remote_asset.md (v2)

athena/antenna_batch_query.sql 실행 결과(CSV)를 앱이 읽는
public/antenna_assets.json 형식으로 변환한다.

앱 런타임에서 Athena 직결이 불가하므로(DIY 앱서버에 idcube_hive_connector 없음),
complex_polygons.json과 동일하게 배치 캐시 방식으로 공급한다.

사용법:
  python athena/build_antenna_assets.py \
      --csv antenna_query_result.csv \
      --out public/antenna_assets.json \
      --dt 20260826

입력 CSV에 기대하는 컬럼 (antenna_batch_query.sql의 SELECT 그대로):
  rapa_key, lat, lon, azimuth, enb_id, sector, pci, tx_ant, aau_type,
  h_beamwidth, tx_tilt, tx_e_tilt, tower_height, dup_cnt

lat/lon 대신 원본 DMS 문자열(xpos/ypos)이 들어와도 자동 변환한다.
"""

import argparse
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# 장비 필터 — 규격서 §3 (TS의 isOutdoorMacroAntenna와 동일 규칙)
# ---------------------------------------------------------------------------
EXCLUDE_PREFIX = ('RO-', 'T_RO-', 'RORO-', 'RHU-', 'PRU', 'OPRU')
INCLUDE_PREFIX = ('AAU', 'ARRU', 'DBRRU', 'RRU', 'RRH')

_warned = set()


def is_outdoor_macro(tx_ant):
    """아웃도어 매크로 안테나인지 판정. 인빌딩/중계기/28GHz는 제외."""
    if not tx_ant:
        return False
    # ① 제외 접두어 먼저 — RO-AAU…, RO-PRU… 를 올바로 걸러내기 위함
    if tx_ant.startswith(EXCLUDE_PREFIX):
        return False
    # ② 28GHz는 O2I 침투가 사실상 불가
    if '-28G-' in tx_ant:
        return False
    # ③ 포함 접두어
    if tx_ant.startswith(INCLUDE_PREFIX):
        return True
    # ④ 미지 장비명은 기본 제외 + 경고
    if tx_ant not in _warned:
        _warned.add(tx_ant)
        print(f'[WARN] 미분류 장비명, 제외 처리: {tx_ant}', file=sys.stderr)
    return False


def dms_to_deg(v):
    """'DDD-MM-SS.sss' → 십진도. 형식이 아니면 None."""
    if v is None:
        return None
    v = str(v).strip()
    if not v:
        return None
    parts = v.split('-')
    if len(parts) != 3:
        return None
    try:
        d, m, s = (float(p) for p in parts)
    except ValueError:
        return None
    return d + m / 60 + s / 3600


def to_float(v):
    if v is None:
        return None
    v = str(v).strip()
    if v == '' or v.upper() in ('NULL', 'NONE', '-'):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def norm_azimuth(v):
    """0~360 밖(NULL·이상치)은 버린다. 360은 0으로 정규화."""
    f = to_float(v)
    if f is None or f < 0 or f > 360:
        return None
    return 0.0 if f == 360 else f


def pick(row, *names):
    for n in names:
        if n in row and str(row[n]).strip() != '':
            return row[n]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', help='antenna_batch_query.sql 실행 결과 CSV')
    ap.add_argument('--json', help='Athena 쿼리 결과 JSON (los_antenna_assets.json)')
    ap.add_argument('--out', default='public/antenna_assets.json')
    ap.add_argument('--dt', default='', help='소스 파티션 (예: 20260826)')
    args = ap.parse_args()

    if not args.csv and not args.json:
        ap.error('--csv 또는 --json 인자가 필요합니다.')

    targets = defaultdict(list)
    stats = {'read': 0, 'kept': 0, 'drop_filter': 0, 'drop_azimuth': 0, 'drop_coord': 0, 'drop_key': 0}
    seen = set()  # (rapa_key, lat, lon, azimuth) — CSV/JSON 단계 중복 방어

    if args.json:
        with open(args.json, encoding='utf-8') as f:
            raw_rows = json.load(f)
            if isinstance(raw_rows, dict) and 'targets' in raw_rows:
                # 이미 변환된 형식인 경우 flatten
                rows = []
                for rk, items in raw_rows['targets'].items():
                    for item in items:
                        rows.append({'rapa_key': rk, **item})
            else:
                rows = raw_rows
    else:
        with open(args.csv, encoding='utf-8-sig', newline='') as f:
            rows = list(csv.DictReader(f))

    for row in rows:
        stats['read'] += 1

        rapa_key = pick(row, 'rapa_key', 'rapaKey', 'RAPA식별코드')
        if not rapa_key:
            stats['drop_key'] += 1
            continue
        rapa_key = str(rapa_key).strip()

        tx_ant = pick(row, 'tx_ant', 'txAnt')
        tx_ant = str(tx_ant).strip() if tx_ant else None
        if not is_outdoor_macro(tx_ant):
            stats['drop_filter'] += 1
            continue

        azimuth = norm_azimuth(pick(row, 'azimuth', 'tx_orient'))
        if azimuth is None:
            stats['drop_azimuth'] += 1
            continue

        lat = to_float(pick(row, 'lat'))
        lon = to_float(pick(row, 'lon', 'lng'))
        if lat is None:
            lat = dms_to_deg(pick(row, 'ypos'))
        if lon is None:
            lon = dms_to_deg(pick(row, 'xpos'))
        # 한반도 범위 게이트
        if lat is None or lon is None or not (33 <= lat <= 39) or not (124 <= lon <= 132):
            stats['drop_coord'] += 1
            continue

        lat = round(lat, 6)
        lon = round(lon, 6)
        az = round(azimuth)

        dedup_key = (rapa_key, lat, lon, az)
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        targets[rapa_key].append({
            'lat': lat,
            'lon': lon,
            'azimuth': az,
            'enbId': (str(pick(row, 'enb_id', 'enbId') or '').strip() or None),
            'sector': (str(pick(row, 'sector') or '').strip() or None),
            'txAnt': tx_ant,
            'hBeamwidth': to_float(pick(row, 'h_beamwidth', 'hBeamwidth')),
            'txTilt': to_float(pick(row, 'tx_tilt', 'txTilt')),
            'txETilt': to_float(pick(row, 'tx_e_tilt', 'txETilt')),
            'towerHeight': to_float(pick(row, 'tower_height', 'towerHeight')),
            'dupCnt': to_float(pick(row, 'dup_cnt', 'dupCnt')),
        })
        stats['kept'] += 1

    out = {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'sourceTable': 'o_iam.celp_fgru_antenna',
        'dt': args.dt,
        'filterRule': 'include AAU|ARRU|DBRRU|RRU|RRH / exclude RO-|T_RO-|RORO-|RHU-|PRU|OPRU|-28G-',
        'targets': {k: sorted(v, key=lambda a: (a['lat'], a['lon'], a['azimuth']))
                    for k, v in sorted(targets.items())},
    }

    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    print(f"[OK] {args.out}", file=sys.stderr)
    print(f"  읽은 행      : {stats['read']}", file=sys.stderr)
    print(f"  채택         : {stats['kept']}  (단지 {len(targets)}곳)", file=sys.stderr)
    print(f"  장비필터 제외: {stats['drop_filter']}", file=sys.stderr)
    print(f"  방위각 제외  : {stats['drop_azimuth']}", file=sys.stderr)
    print(f"  좌표 제외    : {stats['drop_coord']}", file=sys.stderr)
    if stats['drop_key']:
        print(f"  키 없음 제외 : {stats['drop_key']}", file=sys.stderr)


if __name__ == '__main__':
    main()
