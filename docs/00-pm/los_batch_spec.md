# LOS 시뮬레이션 자동 배치 — 상세 스펙 정의서

> **최종 업데이트**: 2026-08-08  
> **상태**: 설계 정의 단계 (개발 착수 전)  
> **참조**: [workflow_architecture.md](./workflow_architecture.md), [db_schema_relations.md](./db_schema_relations.md)

## 이 문서를 언제 참조하는가

| 상황 | 참조 문서 |
|---|---|
| 전체 흐름이 뭔지 파악할 때 | [workflow_architecture.md](./workflow_architecture.md) |
| **Step 2 개발을 시작할 때** | ✅ **이 문서** (los_batch_spec.md) |
| ATOM과 LOS 간 충돌 이슈 검토 | [workflow_architecture.md](./workflow_architecture.md) §3 핵심 설계 결정 |
| **관로동 로직 어떻게 구현할지** | ✅ **이 문서** Step 2.3~2.5 |
| 어떤 DB 컬럼이 연결되는지 | [db_schema_relations.md](./db_schema_relations.md) |

> **한 줄 정리**: 이 문서를 읽으면 **"Step 2를 코드로 어떻게 구현하는지"** 알 수 있습니다.  
> `workflow_architecture.md`(Why/What) → 이 문서(How) 순서로 읽으세요.  
> 두 문서는 **계층 관계**이지 중복이 아닙니다.

---

## 전체 흐름 요약

```
Step 1: toupilji_registration 쿼리 → 신규 APT 추출
  ↓
Step 2: APT 단지별 루프
  ├─ 2.1 단지/건물 폴리곤 조회 (MOIRA 공간 조인)
  ├─ 2.2 단지 반경 150m 기존 시설 조회
  ├─ 2.3 관로동 확인 (장비 설치 가능 건물 식별)
  ├─ 2.4 건물별 베란다 설정
  ├─ 2.5 불필요 폴리곤 삭제 + 설치X동 마킹
  ├─ 2.6 LOS 시뮬레이션 실행 (헤드리스)
  └─ 2.7 ailayer 업데이트 데이터 생성
  ↓
Step 3: ailayer_apt_5g 업데이트
  ↓
Step 4: OK/NOK 리포트 생성 & 저장
```

---

## Step 1: 신규 APT 대상 추출

### 입력
- `new_coverage.toupilji_registration` (PostgreSQL)

### 처리 로직
```sql
SELECT 
    management_no AS ina_no,
    place_name    AS apt_name,
    latitude      AS lat,
    longitude     AS lng,
    sido, sigungu, eupmyeondong,
    created_at
FROM new_coverage.toupilji_registration
WHERE service_category_minor = '아파트단지'
  AND network_type = '5G'
  AND created_at >= :cutoff_date
  AND management_no NOT IN (
      SELECT ina_no FROM los_analysis_history
  )
```

### 출력
| 컬럼 | 설명 |
|---|---|
| `ina_no` | APT 관리번호 (Loop 기준 키) |
| `apt_name` | 단지명 |
| `lat` / `lng` | 단지 대표 위경도 |

### 미확인 이슈
> ⚠️ **Issue A**: `los_analysis_history` 별도 이력 테이블 구조 미정의.
> → 신규 감지 기준 결정 필요: (1) cutoff_date 방식, (2) 이력 테이블 방식, (3) 두 방식 병행

---

## Step 2: APT 단지별 루프

각 APT(`ina_no`)에 대해 서브스텝 순서대로 실행.
**어느 서브스텝에서 실패해도 해당 APT는 NOK 처리 후 다음 APT로 진행.**

---

### Step 2.1: 단지/건물 폴리곤 조회

#### 처리 로직
```python
# 1. ailayer 좌표로 단지 폴리곤 조회 (ap_bld_cplx_inf)
cplx = query("""
    SELECT bld_cplx_inf_id, pygn_geo
    FROM o_moira.ap_bld_cplx_inf
    WHERE cplx_mcl_nm = '아파트'
      AND ST_CONTAINS(ST_GeomFromBinary(pygn_geo), ST_Point(lng, lat))
""")

# 2. 단지 폴리곤 내 건물 폴리곤 조회 (ac_bld_bas)
buildings = query("""
    SELECT ciss_bld_cd, bld_nm, grud_flor_cnt, bld_hght,
           bld_in_lng, bld_in_lat, geo, codn_ary_val
    FROM o_moira.ac_bld_bas
    WHERE ST_CONTAINS(ST_GeomFromBinary(cplx.pygn_geo),
                      ST_Point(bld_in_lng, bld_in_lat))
""")
```

#### 출력
- 단지 폴리곤 (WKB → GeoJSON 변환)
- 건물 목록 (동별 폴리곤 + 높이 + 층수)

#### 미확인 이슈
> ⚠️ **Issue B**: `ailayer_apt_5g`의 `lat`/`lng`가 단지 폴리곤 밖에 있을 수 있음.
> → Fallback 필요: ST_CONTAINS 실패 시 반경 200m BBox로 재검색

---

### Step 2.2: 단지 반경 150m 기존 시설 조회

#### 처리
```python
# 반경 약 150m ≒ 위경도 ±0.00135도
existing_sites = query("""
    SELECT ...
    FROM [기존시설 테이블]
    WHERE lng BETWEEN ({lng} - 0.00135) AND ({lng} + 0.00135)
      AND lat BETWEEN ({lat} - 0.00135) AND ({lat} + 0.00135)
""")
```

#### 미확인 이슈
> 🔴 **Issue C (미확인)**: 기존 시설 정보 테이블이 어디 있는지 확인 필요.
> 후보: `p_common.ailayer_apt_5g` 기존 레코드? 별도 장비 설치 현황 테이블?
> → 확인 없이 진행 불가. 이 서브스텝은 보류 가능.

---

### Step 2.3: 관로동 확인 (장비 설치 가능 건물 식별)

#### 개념
- **관로동** = 관로(통신 케이블 배관)가 존재하여 장비를 설치할 수 있는 건물동
- 관로가 없는 동 = 베란다는 존재(LOS 수신 대상)하나, 장비 설치 불가

#### 처리
```python
for bld in buildings:
    bld['can_install'] = check_kanro(bld)  # True / False
```

#### 미확인 이슈
> 🔴 **Issue D (최우선)**: 관로동 데이터 소스 미확인.
> 다음 중 어디서 가져오는가?
> - `toupilji_registration`에 관로 정보 컬럼 있는가?
> - `ailayer_apt_5g`에 관련 컬럼 있는가?
> - 별도 관로 DB 또는 수동 입력인가?
> → **확인 필수. 관로동 미판별 시 시뮬레이션 의미 없음.**

---

### Step 2.4: 건물별 베란다 설정

#### 처리
- 건물 폴리곤의 각 변(edge)에서 외부 방향 면을 베란다 후보로 설정
- 향 방향(방위각), 건물 형태에 따라 1차/2차 구분

#### 출력 예시
```json
{
  "ciss_bld_cd": "N128.617 36.782",
  "first_verandas":  [{ "edge_idx": 2, "length_m": 45.3, "azimuth": 180 }],
  "second_verandas": [{ "edge_idx": 0, "length_m": 22.1, "azimuth": 0 }]
}
```

---

### Step 2.5: 불필요 폴리곤 삭제 + 설치X동 마킹

#### 건물 분류 체계
```
모든 건물 (ac_bld_bas 조회 결과)
├─ 아파트 주거 동 (LOS 대상)
│   ├─ 관로동   (can_install = True)   ← 장비 설치 가능
│   └─ 비관로동 (can_install = False)  ← 장비 설치 불가, 베란다는 있음
└─ 부속 건물 (관리사무소, 주차장 등)  → 폴리곤 삭제
```

#### 핵심 설계 결정: 설치X동 시뮬레이션 반영 방식

**문제**: "관로동이 아니면 장비 설치 불가인데, 현재 폴리곤이 있으면 장비를 설치하게 됨"

**해결**: `can_install` 플래그를 LOS 엔진(`simulation.ts`)의 후보 Site 탐색 로직에 반영

```typescript
// simulation.ts 수정 필요
// 장비 후보 위치: 관로동 옥상만
const candidateSites = buildings
  .filter(b => b.can_install === true)
  .map(b => b.rooftop_position);

// 베란다 LOS 계산: 모든 동 포함 (관로 여부 무관)
const verandas = buildings.flatMap(b => b.verandas);
```

---

### Step 2.6: LOS 시뮬레이션 실행 (헤드리스)

#### 입력
| 항목 | 설명 |
|---|---|
| 건물 폴리곤 목록 | `geo` + `bld_hght` |
| 베란다 정보 | 1차/2차 베란다 위치 및 길이 |
| 관로동 플래그 | `can_install` |
| 기존 시설 위치 | Step 2.2 결과 |

#### 출력 (기존 + 신규 추가 필요)
| 항목 | 기존 | 추가 필요 |
|---|---|---|
| 총 LOS (%) | ✅ | |
| 건물별 LOS (%) | ✅ | |
| Site/Sector 목록 | ✅ 화면 표시만 | ✅ 저장 필요 |
| **장비 설치 위치 위경도** | ❌ | ✅ `[lng, lat]` per Site |
| **설치 건물동 목록** | ❌ | ✅ `ciss_bld_cd` list |
| **Site ID (정형화)** | 부분 | ✅ |
| **Sector ID (정형화)** | 부분 | ✅ |
| **시뮬레이션 실행 시간** | ❌ | ✅ |

---

### Step 2.7: ailayer 업데이트 데이터 생성

```python
los_record = {
    **original_ailayer_row,           # 기존 ATOM 데이터 유지
    'smtso_nm': f"[LOS] {original_ailayer_row['smtso_nm']}",
    'data_type': 2,                   # ATOM=1, LOS=2 구분
    'los_pct':   simulation_result['total_los_pct'],
    'site_cnt':  len(simulation_result['sites']),
    'sector_cnt': total_sector_count,
    'site_locations': json.dumps(site_lnglat_list),
    'bld_list':  json.dumps(installed_bld_ids),
    'dt': today
}
```

#### 미확인 이슈
> ⚠️ **Issue E**: `ailayer_apt_5g`에 LOS 결과 저장용 컬럼이 없을 수 있음.
> → ailayer 스키마 확장 vs 별도 LOS 결과 테이블 중 결정 필요

---

## Step 3: ailayer_apt_5g 업데이트

```python
connector.write_to_idcube(df_los_results, 'p_common', 'ailayer_apt_5g')
```

- ATOM 원본 레코드와 `[LOS]` 태그 레코드 공존
- `drop_duplicates` 전체 컬럼 비교 → `[LOS]` 태그 덕분에 충돌 없음 (검증 완료)

---

## Step 4: OK/NOK 리포트 생성 & 저장

### 리포트 구조
```python
report = {
    'run_date': today,
    'total_target': len(apt_list),
    'ok_count': ok_count,
    'nok_count': nok_count,
    'results': [
        {
            'ina_no':   apt['ina_no'],
            'apt_name': apt['apt_name'],
            'steps': {
                '2.1_polygon_fetch':  'OK|NOK|SKIP',
                '2.2_nearby_sites':   'OK|NOK|SKIP',
                '2.3_kanro_check':    'OK|NOK|SKIP',
                '2.4_veranda_setup':  'OK|NOK|SKIP',
                '2.5_polygon_filter': 'OK|NOK|SKIP',
                '2.6_los_simulation': 'OK|NOK|SKIP',
                '2.7_ailayer_prep':   'OK|NOK|SKIP',
                '3_ailayer_update':   'OK|NOK|SKIP',
            },
            'overall':   'OK|NOK',
            'error_msg': None,
            'los_pct':   85.3,
            'site_cnt':  3
        }
    ]
}
```

#### 미확인 이슈
> ⚠️ **Issue F**: 리포트 저장 위치 결정 필요.
> 후보: IDCube Athena 별도 테이블 vs 로컬 파일(CSV/JSON) vs 병행

---

## 미결 이슈 종합

| # | 이슈 | 중요도 | 결정 필요 사항 |
|---|---|---|---|
| A | 신규 대상 감지 방식 | 🔴 필수 | cutoff_date vs 이력 테이블 |
| B | ailayer lat/lng 폴리곤 밖 Fallback | 🟡 중요 | BBox 반경 결정 |
| C | 150m 기존 시설 DB 소스 | 🔴 필수 | 테이블명 확인 |
| D | **관로동 데이터 소스** | 🔴 **최우선** | DB/컬럼 확인 |
| E | ailayer 스키마 확장 여부 | 🔴 필수 | 구조 결정 |
| F | 리포트 저장 위치 | 🟡 중요 | 저장 방식 결정 |

---

## 개발 순서 (권장)

```
Phase 1 — 데이터 확인 (착수 전 선결)
  → Issue C, D 해결 (관로동 DB, 기존시설 DB 확인)
  → Issue E 결정 (ailayer 스키마 확장 여부)

Phase 2 — 파이프라인 스캐폴딩
  → Step 1 쿼리 구현
  → Loop 구조 + Step 4 리포트 틀

Phase 3 — 엔진 연결
  → simulation.ts 헤드리스화
  → Step 2.1~2.5 데이터 준비 로직
  → can_install 플래그 엔진 반영

Phase 4 — Write-back
  → Step 2.7 ailayer 포맷 변환
  → Step 3 IDCube 업데이트

Phase 5 — 통합 테스트
  → 1개 APT 단지 E2E 실행 검증
  → OK/NOK 리포트 확인
```
