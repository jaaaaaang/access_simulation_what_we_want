#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
전체 단지 리스트 및 LOS 시뮬레이션 분석 결과 통합 CSV 내보내기 스크립트
(Dashboard 전체 리스트 뷰와 100% 일치하는 정합 데이터 생성)
"""

import os
import csv
import json
import glob
from datetime import datetime, timezone, timedelta

def norm_key(k: str) -> str:
    """m- 접두사 정규화 키 반환"""
    if not k:
        return ""
    return k[2:] if k.startswith("m-") else k

def format_kst(iso_str: str) -> str:
    """ISO 8601 UTC 문자열을 KST 포맷으로 변환"""
    if not iso_str:
        return ""
    try:
        # Z 처리
        clean_iso = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean_iso)
        kst_dt = dt.astimezone(timezone(timedelta(hours=9)))
        return kst_dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return iso_str

def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    apt_csv_path = os.path.join(base_dir, "public", "apt_list.csv")
    index_json_path = os.path.join(base_dir, "data", "results", "_index.json")
    results_dir = os.path.join(base_dir, "data", "results")
    temps_dir = os.path.join(base_dir, "public", "temps")
    plans_dir = os.path.join(base_dir, "plans")
    public_plans_dir = os.path.join(base_dir, "public", "plans")
    
    # 1. 시뮬레이션 결과 인덱스 로드
    idx_items = {}
    if os.path.exists(index_json_path):
        with open(index_json_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
            idx_items = raw.get("items", {})

    # 2. temps 디렉토리의 폴리곤 상태 로드
    polygon_status = {}
    for p in glob.glob(os.path.join(temps_dir, "*.json")):
        fname = os.path.basename(p)
        key = fname[:-5] # .json 제거
        try:
            with open(p, "r", encoding="utf-8") as tf:
                tdata = json.load(tf)
            has_complex = bool(tdata.get("complex", {}).get("polygon")) and len(tdata["complex"]["polygon"]) >= 3
            b_count = len(tdata.get("buildings", []))
            b_source = tdata.get("buildingSource", "")
            status_item = {
                "hasComplex": has_complex,
                "buildingCount": b_count,
                "source": b_source or ""
            }
            polygon_status[key] = status_item
            polygon_status[norm_key(key)] = status_item
        except Exception:
            polygon_status[key] = {"hasComplex": False, "buildingCount": 0, "source": "error"}

    # 3. 도면(Plan) 파일 보유 여부 로드
    plan_keys = set()
    for pd in [plans_dir, public_plans_dir]:
        if os.path.exists(pd):
            for p in glob.glob(os.path.join(pd, "*")):
                base = os.path.splitext(os.path.basename(p))[0]
                plan_keys.add(base)
                plan_keys.add(norm_key(base))

    # 4. 원본 단지 목록 로드 (apt_list.csv)
    with open(apt_csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        apt_rows = list(reader)

    # 5. 매칭 헬퍼 함수
    def find_idx_item(rapa_key: str):
        if rapa_key in idx_items:
            return idx_items[rapa_key]
        nkey = norm_key(rapa_key)
        if nkey in idx_items:
            return idx_items[nkey]
        mkey = f"m-{nkey}"
        if mkey in idx_items:
            return idx_items[mkey]
        return None

    def find_polygon_status(rapa_key: str):
        if rapa_key in polygon_status:
            return polygon_status[rapa_key]
        nkey = norm_key(rapa_key)
        if nkey in polygon_status:
            return polygon_status[nkey]
        mkey = f"m-{nkey}"
        if mkey in polygon_status:
            return polygon_status[mkey]
        return {"hasComplex": False, "buildingCount": 0, "source": ""}

    def has_plan(rapa_key: str) -> bool:
        return (rapa_key in plan_keys) or (norm_key(rapa_key) in plan_keys) or (f"m-{norm_key(rapa_key)}" in plan_keys)

    # 6. CSV 통합 레코드 생성
    output_rows = []
    
    for idx, row in enumerate(apt_rows, start=1):
        rapa_key = (row.get("RAPA식별코드") or "").strip()
        poly_st = find_polygon_status(rapa_key)
        res_item = find_idx_item(rapa_key)
        plan_exist = has_plan(rapa_key)

        # 분석 상태
        if res_item:
            status_code = res_item.get("status", "OK")
            status_label = {
                "OK": "완료 (OK)",
                "WARN": "경고 (WARN)",
                "NOK": "실패 (NOK)"
            }.get(status_code, status_code)
            cov_ratio = f"{res_item.get('coverageRatio', 0):.1f}" if res_item.get("coverageRatio") is not None else ""
            site_cnt = res_item.get("siteCount", "")
            sec_cnt = res_item.get("sectorCount", "")
            dur_sec = res_item.get("durationSec", "")
            analyzed_at = format_kst(res_item.get("analyzedAt", ""))
            source = "배치(자동)" if res_item.get("source") == "batch" else ("화면(수동)" if res_item.get("source") == "manual" else (res_item.get("source") or ""))
            warn_msg = res_item.get("warningMsg") or ""
            err_msg = res_item.get("errorMsg") or ""
            notes = " / ".join(filter(None, [warn_msg, err_msg]))
        else:
            status_label = "미분석"
            cov_ratio = ""
            site_cnt = ""
            sec_cnt = ""
            dur_sec = ""
            analyzed_at = ""
            source = ""
            notes = ""

        # 관로동 전처리
        conduit = (row.get("관로동") or "").strip()
        if not conduit or conduit in ["-", "해당없음", "해당사항없음"]:
            conduit_str = "미지정"
        else:
            conduit_str = conduit

        record = {
            "순번": idx,
            "RAPA식별코드": rapa_key,
            "공사명": row.get("공사명", "").strip(),
            "건물명/도로명": row.get("건물명/도로명", "").strip(),
            "본부": row.get("본부", "").strip(),
            "시도": row.get("시도", "").strip(),
            "시군구": row.get("시군구", "").strip(),
            "읍면동": row.get("읍면동", "").strip(),
            "주소": row.get("주소", "").strip(),
            "세대수": row.get("세대수", "").strip(),
            "동수": row.get("동", "").strip(),
            "관로동": conduit_str,
            "위도": row.get("위도", "").strip(),
            "경도": row.get("경도", "").strip(),
            "폴리곤확보여부": "확보" if poly_st.get("hasComplex") else "미확보",
            "단지건물수(폴리곤)": poly_st.get("buildingCount", 0) if poly_st.get("hasComplex") else 0,
            "건물데이터출처": poly_st.get("source", ""),
            "도면보유여부": "보유" if plan_exist else "미보유",
            "분석상태": status_label,
            "종합커버리지(%)": cov_ratio,
            "설치Site수": site_cnt,
            "설치Sector수": sec_cnt,
            "분석소요시간(초)": dur_sec,
            "분석일시(KST)": analyzed_at,
            "분석출처": source,
            "특이사항/에러": notes,
            "사업년도": row.get("사업년도", "").strip(),
            "준공예정일": row.get("준공예정일", "").strip(),
            "준공사": row.get("준공사", "").strip(),
        }
        output_rows.append(record)

    # 7. CSV 파일 저장 (utf-8-sig: 엑셀 한글 깨짐 방지)
    out_csv_main = os.path.join(base_dir, "total_apt_list_results.csv")
    out_csv_kr = os.path.join(base_dir, "전체단지_시뮬레이션_결과_리스트.csv")
    
    fieldnames = list(output_rows[0].keys())
    
    for path in [out_csv_main, out_csv_kr]:
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(output_rows)
        print(f"✅ CSV 생성 완료: {path} (총 {len(output_rows)}개 단지)")

    # 8. 요약 출력
    completed_cnt = sum(1 for r in output_rows if "완료" in r["분석상태"])
    warn_cnt = sum(1 for r in output_rows if "경고" in r["분석상태"])
    nok_cnt = sum(1 for r in output_rows if "실패" in r["분석상태"])
    unanalyzed_cnt = sum(1 for r in output_rows if r["분석상태"] == "미분석")
    poly_cnt = sum(1 for r in output_rows if r["폴리곤확보여부"] == "확보")

    print("\n[전체 통계 요약]")
    print(f"- 전체 단지 수: {len(output_rows)}개")
    print(f"- 폴리곤 확보 단지: {poly_cnt}개 ({poly_cnt/len(output_rows)*100:.1f}%)")
    print(f"- 시뮬레이션 완료: {completed_cnt}개")
    print(f"- 경고(WARN): {warn_cnt}개")
    print(f"- 실패(NOK): {nok_cnt}개")
    print(f"- 미분석: {unanalyzed_cnt}개")

if __name__ == "__main__":
    main()
