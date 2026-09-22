# LOS 시뮬레이터 전체 자동화 워크플로우 및 시스템 연동 개발 계획서
> **Document Identifier**: `workflow_plan_gemini.md`  
> **Author**: Access Eng팀  
> **Date**: 2026-07-29 (최신 검토 내역 반영)  
> **Target Project**: `playground-eng-apt-cover-windows` (LOS Simulator & Auto Planner)

---

## 1. 전체 개요 및 자동화 비전

본 문서의 목적은 외부 시작 시스템인 **RAPA**, 기존 기지국/장비 관리 시스템인 **ATOM**, 핵심 커버리지 분석/배치 엔진인 **LOS 시뮬레이터**, 최종 통계/설계 실행 시스템인 **CellPlan (MOIRA)** 간의 데이터 흐름을 정립하고, 무인 배치(Headless) 전개 분석 프로세스를 구축하기 위한 연동 사양과 단계별 개발 계획을 수립하는 것입니다.

```
+------------------+         +----------------------------+         +--------------------------+
|  1. RAPA 시스템   |  (Input) |   2. LOS 시뮬레이터 엔진   | (Output) |   3. CellPlan (MOIRA)    |
| (독립 자동화 시스템) | -------> |   (우리 개발 대상 시스템)    | -------> |   (독립 분석 시스템)     |
| - 아파트/관로동 생성|          | - 분석영역/건물Fit/베란다  |          | - 공용 DB 데이터 수신    |
+------------------+         | - 기존장비(ATOM)+관로동검토|          | - "아파트최적설계" 자동실행|
                             | - 풀오토 최적배치/수량산출 |          +--------------------------+
                             +----------------------------+
                                           ^
                                           | (기존 장비 정보 조회/전달)
                                   [ ATOM 시스템 ]
```

---

## 2. 연동 시스템 간 Input / Output 주요 데이터 사양표 (Data Interface Table)

시스템 간 입출력 데이터 표준 규격은 아래 표와 같이 정의하며, 연동 API / 공용 DB 메시지 구조의 기본 단위가 됩니다.

### 2.1 [RAPA / ATOM System $\rightarrow$ LOS Simulator] 전달 데이터 (INPUT)

| 구분 | Field Name (EN) | Field Name (KR) | Data Type | Sample / Example | Mandatory | 설명 및 비고 |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| **식별자** | `rapa_key` | RAPA 작업 키 | String (UUID/ID) | `RAPA-2026-APT-00892` | **Y** | 전체 워크플로우의 유일한 작업 식별 키 |
| **대상 정보** | `address` | 아파트 지번/도로명 주소 | String | `서울특별시 서초구 반포동 123` | **Y** | GIS 건물 폴리곤 검색 기준 키 |
| | `apt_name` | 아파트 단지명 | String | `반포 래미안 파크` | **Y** | 단지 식별 및 건물 그룹핑 용도 |
| | `center_latitude` | 아파트 대표 위도 | Float (WGS84) | `37.504123` | **Y** | 건물 공간 검색(Spatial Query) 센터값 |
| | `center_longitude` | 아파트 대표 경도 | Float (WGS84) | `127.001456` | **Y** | 건물 공간 검색(Spatial Query) 센터값 |
| **관로동 정보** | `pipe_building_exist`| 관로동 존재 여부 | Boolean | `true` / `false` | **Y** | 관로동 제약 알고리즘 적용 여부 판정 |
| | `pipe_buildings` | 관로동 건물 리스트 | Array[Object] | 아래 세부 사양 참조 | N | 관로동 설치 가능 건물 목록 |
| *(관로동 세부)*| `--> building_id` | 관로동 건물 식별자 | String | `BLDG-101` | Y | 아파트 동(Building) ID |
| *(관로동 세부)*| `--> building_name`| 관로동 동명 | String | `101동` | Y | 동 번호/이름 |
| *(관로동 세부)*| `--> latitude` | 관로동 중심 위도 | Float (WGS84) | `37.504200` | Y | 건물 옥상 Candidate Site 설치 위치 |
| *(관로동 세부)*| `--> longitude` | 관로동 중심 경도 | Float (WGS84) | `127.001500` | Y | 건물 옥상 Candidate Site 설치 위치 |
| **기존 장비** | `existing_equipments`| **기존 주변 장비 리스트**| Array[Object] | 아래 세부 사양 참조 | **Y** | **[필수] ATOM 기반 주변 기지국 정보** |
| *(장비 세부)* | `--> cell_id` | 기지국 Cell ID | String | `CELL-08912` | Y | 기존 장비 식별자 |
| *(장비 세부)* | `--> latitude` | 장비 위도 | Float (WGS84) | `37.504800` | Y | 기지국 위치 |
| *(장비 세부)* | `--> longitude` | 장비 경도 | Float (WGS84) | `127.001900` | Y | 기지국 위치 |
| *(장비 세부)* | `--> azimuth` | 안테나 방위각 | Float (Degree) | `240.0` | Y | 기존 장비 지향각 |
| *(장비 세부)* | `--> pci` | PCI 값 | Integer | `45` | Y | PCI 색상 시각화 및 중첩 분리용 |

---

### 2.2 [LOS Simulator $\rightarrow$ CellPlan (MOIRA) / 공용 DB] 전달 데이터 (OUTPUT)

| 구분 | Field Name (EN) | Field Name (KR) | Data Type | Sample / Example | Mandatory | 설명 및 비고 |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| **식별자** | `rapa_key` | RAPA 작업 키 | String | `RAPA-2026-APT-00892` | **Y** | RAPA 매핑 및 이력 추적용 |
| **대상 정보** | `address` | 아파트 주소 | String | `서울특별시 서초구 반포동 123` | **Y** | CellPlan 아파트 단지 폴리곤 매핑용 |
| | `center_latitude` | 대표 위도 | Float (WGS84) | `37.504123` | **Y** | 공용 DB 인서트 기본 위도 |
| | `center_longitude` | 대표 경도 | Float (WGS84) | `127.001456` | **Y** | 공용 DB 인서트 기본 경도 |
| **관로동 정보** | `pipe_building_exist`| 관로동 적용 여부 | Boolean | `true` | **Y** | 실제 반영된 관로동 여부 |
| **최적화 결과**| `total_site_count` | 최적 신규 Site 수량 | Integer | `3` | **Y** | 배치된 신규 Site 수량 |
| | `total_sector_count`| 최적 신규 Sector 수량| Integer | `7` | **Y** | 배치된 신규 Sector 수량 (최대 3/site) |
| | `final_los_ratio` | 1차 베란다 커버리지(%)| Float | `84.5` | **Y** | 기존 장비 + 신규 장비 합산 LOS 커버리지 |
| **장비 상세** | `equipments` | 배치 장비/섹터 리스트 | Array[Object] | 아래 세부 사양 참조 | **Y** | CellPlan 공용 DB 테이블 인서트 단위 |
| *(세부)* | `--> site_id` | Site 식별자 | String | `SITE-1` | Y | 동일 PCI 그룹핑 단위 |
| *(세부)* | `--> sector_id` | Sector 식별자 | String | `SITE-1-A` | Y | 개별 안테나 식별자 |
| *(세부)* | `--> pci` | Physical Cell ID | Integer | `101` | Y | Site별 고유 PCI 값 |
| *(세부)* | `--> latitude` | 장비 위치 위도 | Float (WGS84) | `37.504310` | Y | CellPlan 공용 DB 전달 위도 |
| *(세부)* | `--> longitude` | 장비 위치 경도 | Float (WGS84) | `127.001610` | Y | CellPlan 공용 DB 전달 경도 |
| *(세부)* | `--> azimuth` | 안테나 방위각 | Float (Degree) | `120.0` | Y | 빔 지향각 (0°~360°) |
| *(세부)* | `--> tilt` | 안테나 틸트각 | Float (Degree) | `6.0` | Y | 안테나 틸트 각도 |
| *(세부)* | `--> host_bldg_id` | 장비 설치 건물 ID | String | `BLDG-101` | Y | 장비가 올려진 관로동/건물 식별자 |

---

## 3. LOS 시뮬레이터 핵심 분석 엔진 요구사항

### 3.1 분석 영역(Analysis Area) 자동 결정 및 Target Fitting 로직

> **[주요 검토 1] RAPA에서 아파트 위경도를 받은 후, 분석할 동들이 포함된 영역을 어떻게 자동으로 설정할 것인가?**

1. **자동 분석 영역(Analysis Area) 생성 알고리즘**:
   - RAPA에서 받은 좌표/주소를 기반으로 아파트 단지에 속한 모든 동(Building) 폴리곤을 수집.
   - 대상 동 폴리곤들의 외곽점을 연결하는 **Convex Hull (최소 포함 다각형)** 또는 **Bounding Polygon**을 자동 생성.
   - 해당 다각형 외곽으로 **안전 마진 Buffer (예: +30m~50m)**를 부여하여 `Analysis Area Polygon`을 확정.
2. **영역 내 요소 구분 처리**:
   - **분석 대상 건물 (Target Buildings)**: `Analysis Area` 내부에 속한 대상 아파트 동 (베란다 모수 및 LOS 평가 대상).
   - **주변 건물 (Shadowing Buildings - 선택/필수아님)**: `Analysis Area` 외곽 인접 건물 (신호 차폐/Shadowing 계산에만 참여).
   - **기존 주변 장비 (Existing Equipments - [필수])**: `Analysis Area` 내부 및 반경 내에 존재하는 기존 기지국 장비 (기존 커버리지 베이스라인 형성).

---

### 3.2 기존 주변 장비(ATOM) 수집 경로 검토 및 의사결정

> **[주요 검토 2 & 3] 기존 주변 장비 정보는 ATOM에서 붙여서 넘겨줘야 하나, 아니면 LOS 시뮬레이터에서 직접 조회해야 하나?**

| 비교 항목 | Option 1: RAPA/ATOM에서 Payload 주입 (추천) | Option 2: LOS 시뮬레이터에서 ATOM API 직접 조회 |
| :--- | :--- | :--- |
| **동작 방식** | RAPA가 작업 생성 시 ATOM DB/API를 통해 아파트 반경 내 기존 장비를 조회하여 Input Payload에 포함하여 LOS로 전달 | RAPA는 아파트 기본 정보만 전달하고, LOS 시뮬레이터가 작업 수행 시 ATOM API/DB를 직접 호출하여 조회 |
| **장점** | - **시스템 간 결합도(Coupling) 최소화**: LOS 시뮬레이터가 ATOM DB 접속 권한/인증을 직접 들고 있을 필요가 없음.<br>- **입력 데이터의 스냅샷 보장**: 분석 시점의 입력 데이터(기존 장비)가 Payload에 명확히 기록되어 재현성(Traceability) 확보. | - Input Payload 크기가 작아짐.<br>- 실시간으로 최신 ATOM DB 상태를 반영 가능. |
| **단점** | RAPA 시스템 측에서 ATOM 연동 모듈을 호출하는 개발 공수 발생 | - LOS 시뮬레이터가 ATOM DB/API 연결 인터페이스 및 망연동 권한을 추가로 개발 및 유지보수해야 함.<br>- ATOM 서버 장애 시 LOS 분석 프로세스 전체가 차단됨. |
| **최종 제언 & 결론** | **[Option 1 선호 / Option 2 Fallback]**: 대규모 자동화 큐(Queue) 구조에서는 RAPA/전단 Orchestrator가 ATOM 장비 목록을 사전 취합하여 Payload(`existing_equipments`)로 넘겨주는 방식(Option 1)이 구조적으로 가장 안정적이고 결합도가 낮음. |

---

### 3.3 관로동(Pipe Building) 제약 및 알고리즘 적용

1. **실무적 타당성 (Business Rationale)**: **매우 높음.**
   - 실제 현장 통신 장비 설치 시, 관로(Duct) 및 수배전반이 마련된 관로동 외에는 신규 배선 공사비(CAPEX) 및 주민 합의 문제로 설치가 불가능함.
2. **동작 로직**:
   - `pipe_building_exist == true`: Candidate Site 생성 시, 관로동 건물의 옥상 위경도로만 후보지(Candidate Site) 생성 영역 제한.
   - `pipe_building_exist == false`: 기존 알고리즘대로 아파트 단지 전체 건물 옥상/지상을 대상으로 후보지 탐색.

---

## 4. CellPlan (MOIRA) 연동 및 공용 DB 인서트 전략

### 4.1 Trigger 및 단지 폴리곤 포함 여부 검증
- CellPlan은 공용 DB 장비 인서트 시 자동 Trigger 실행.
- 입력 좌표가 분석 아파트 단지 폴리곤 내에 속하는지 LOS 시뮬레이터의 Exporter 모듈에서 사전 유효성 검증(`Containment Check`) 후 인서트 수행.

### 4.2 장비 수량 전달 방식 (Option B 확정)
- LOS 시뮬레이터에서 계산된 **최적 장비 수량 및 실제 위경도/방위각/틸트/PCI** 데이터를 공용 DB에 정확히 인서트하여, CellPlan이 O2I LOS 검증 및 CAPEX 다이어트가 적용된 기지국 배치를 바탕으로 최적 설계를 진행하도록 조율.

---

## 5. 추가 검토 내역 종합 요약표 (Summary of Key Review Items)

| 번호 | 검토 이슈 | 해결 방안 및 기술 규격 | 담당 모듈 |
| :---: | :--- | :--- | :--- |
| **1** | **분석 동 영역 자동 Capture** | 타겟 아파트 동 폴리곤의 Convex Hull + Buffer(+30m) 다각형 자동 생성 logic 적용 | `src/lib/gisFetcher.ts` |
| **2** | **주변 건물 및 기존 장비 포함** | 영역 내 인접 건물은 차폐(`Shadowing`)로 분류하고, 기존 주변 장비(`Existing Equipment`)는 초기 커버리지 베이스라인으로 필수 로딩 | `src/lib/simulation.ts` |
| **3** | **ATOM 기존 장비 데이터 출처** | **RAPA/전단 Orchestrator 주입(Option 1) 권장** (결합도 완화 및 스냅샷 보장). 미지원 시 LOS에서 ATOM API 직접 조회(Option 2) | `src/lib/batchEngine.ts` |

---

## 6. 개발 단계별 로드맵 (Development Roadmap)

```
[Phase 1] Core Engine Headless화 & Input Spec 확정
  ├── CLI / Batch 모드 API 래핑 (`runSimulationBatchJob`)
  └── ATOM 기존 장비(`existing_equipments`) 포함 Input JSON Spec 파싱

[Phase 2] GIS / Polygon Auto-Bounding & Target Fitting
  ├── 아파트 동 폴리곤 Convex Hull Buffer 기반 자동 Analysis Area 생성
  └── 차폐 전용 건물 분리 및 1차/2차 베란다 자동 생성

[Phase 3] 관로동 제약 및 기존 장비 베이스라인 반영
  ├── 관로동 옥상 candidate site 생성 검색 공간 제약
  └── 기존 주변 장비 커버리지 연산 후 남은 미커버 베란다 대상 신규 Site 배치

[Phase 4] CellPlan (MOIRA) Exporter & DB Trigger
  ├── 단지 폴리곤 좌표 포함 검증(Containment Check)
  └── LOS 최적 산출 수량/위치 공용 DB 인서트 & Trigger
```

---

*본 문서는 사용자 추가 요청 사항(분석 영역 자동 Capture, 주변 장비 포함, ATOM 수집 경로 검토)을 반영하여 `workflow_plan_gemini.md`에 업데이트되었습니다.*
