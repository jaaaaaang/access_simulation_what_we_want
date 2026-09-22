# MOIRA 단지 폴리곤 매칭 분석 보고서

> **작성일**: 2026-08-20
> **분석 대상**: `public/apt_list.csv` (2027년 준공 예정 아파트)
> **DB 테이블**: `o_moira.ap_bld_cplx_inf` (아파트 단지 폴리곤)

---

## 📊 전체 요약

### 대상 데이터
- **총 아파트 수**: 288개 (CSV에서 유효한 위경도 보유)
- **조사 방법**: AWS Athena를 통한 공간 쿼리 (`ST_Contains`)
- **샘플 조사**: 30개 (전체의 10.4%)

### 매칭 결과
| 구분 | 샘플 (30개) | 전체 추정 (288개) |
|------|-------------|-------------------|
| ✅ **매칭** | 20개 (66.7%) | **약 191개 (66.7%)** |
| ❌ **미매칭** | 10개 (33.3%) | **약 96개 (33.3%)** |

---

## 🎯 분석 의미

### 매칭된 아파트 (66.7%)
**의미**: MOIRA DB에 해당 위치의 단지 폴리곤 데이터가 **존재**
- 단지 경계(polygon) 정보 사용 가능
- `athena/query_moira.py` 스크립트로 단지 내 건물 조회 가능
- LOS 시뮬레이션에 실제 단지 범위 적용 가능

**매칭 예시** (확인된 케이스):
```
✅ m-RAPA-2208-4903 → 단지ID: 24162 (송도자이풍경채그라노블4단지)
✅ m-RAPA-1811-6729 → 단지ID: 24317 (성남도환중1구역)
✅ m-RAPA-1909-5217 → 단지ID: 24495 (구리 딸기원2지구)
```

### 미매칭 아파트 (33.3%)
**의미**: MOIRA DB에 해당 위치의 단지 폴리곤 데이터가 **부재**

**원인 추정**:
1. **신규 단지**: 2027년 준공 예정이라 아직 MOIRA DB에 등록 전
2. **좌표 오차**: 등록된 좌표가 실제 단지 폴리곤 밖에 위치
3. **데이터 누락**: MOIRA DB 업데이트 지연

**미매칭 예시** (확인된 케이스):
```
❌ m-RAPA-2202-0846 (대구 신암동 삼정그린코아 더베스트)
❌ m-RAPA-1712-03-02-2847 (행신 2-1구역 주택재건축)
```

**대응 방안** (현재 `athena/query_moira.py` 구현됨):
- 단지 미발견 시 → **가상 400m 사각형 영역** 생성
- 해당 영역 내 건물만 조회 (`ac_bld_bas` 테이블)
- `buildingSource: 'virtual_400m_bbox'` 로 표시

---

## 🔍 상세 조회 방법

### 전체 아파트 매칭 분석 실행
프로젝트에 준비된 스크립트를 사용하세요:

```bash
# 사내망/MyDesk 환경 필요 (idcube_hive_connector)
cd /Users/1109425/playground-eng-apt-cover-windows
python3 athena/analyze_matching_results.py
```

**출력 파일**:
- `athena/matched_apartments.json` - 매칭된 아파트 목록 (RAPA Key, 건물명, 단지ID 포함)
- `athena/unmatched_apartments.json` - 미매칭 아파트 목록

### 개별 조회
```bash
# 단일 아파트 조회 (RAPA Key, 위도, 경도)
python athena/query_moira.py single \
  --rapa-key m-RAPA-2305-1745 \
  --lat 37.40080703 \
  --lng 126.9472091
```

---

## 📈 DB 접근 확인

### 테스트 쿼리
```sql
SELECT bld_cplx_inf_id, cplx_mcl_nm, cplx_scl_nm
FROM o_moira.ap_bld_cplx_inf
WHERE cplx_mcl_nm = '아파트'
LIMIT 10;
```

### 공간 조인 쿼리 (예시)
```sql
SELECT
    bld_cplx_inf_id,
    cplx_scl_nm
FROM o_moira.ap_bld_cplx_inf
WHERE cplx_mcl_nm = '아파트'
  AND ST_Contains(
    ST_GeomFromBinary(pygn_geo),
    ST_Point(126.9472091, 37.40080703)  -- lng, lat 순서
  )
LIMIT 1;
```

**✅ DB 접근 성공 확인**: Playground MCP 통해 정상 조회됨

---

## 🛠️ 다음 단계 권장사항

1. **전체 매칭 분석 실행**
   - 사내망 환경에서 `analyze_matching_results.py` 실행
   - 매칭/미매칭 전체 목록 확보

2. **미매칭 대상 검토**
   - 좌표 정확도 확인 (수동 지도 검증)
   - MOIRA DB 업데이트 요청 가능 여부 검토

3. **LOS 시뮬레이션 적용**
   - 매칭: 실제 단지 폴리곤 사용
   - 미매칭: 400m 가상 영역 사용 (현재 구현됨)

4. **주기적 재조회**
   - MOIRA DB 업데이트 시 매칭률 향상 기대
   - 준공일 임박 시 재확인 권장

---

## 📚 관련 문서

- DB 스키마: [`docs/00-pm/db_schema_relations.md`](db_schema_relations.md)
- 쿼리 스크립트: [`athena/query_moira.py`](../athena/query_moira.py)
- 분석 스크립트: [`athena/analyze_matching_results.py`](../athena/analyze_matching_results.py)
- CSV 데이터: [`public/apt_list.csv`](../public/apt_list.csv)
