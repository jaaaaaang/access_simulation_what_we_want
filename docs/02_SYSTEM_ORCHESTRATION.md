# 전체 시스템 오케스트레이션 및 인터페이스 규격서

> 2026-09-04 개정: 실제 코드(`server.ts`, `src/lib/pyApi.ts`, `CadUploadPanel.tsx`)와 대조하여 정합.
> 이전 판의 `backend/` 신설 · `/api/cad/parse` 동기 응답 스펙은 폐기.

## 0. 전제 (반드시 읽을 것)

### 0-1. 환경 구분 — 문서에 나오는 경로의 의미

| 환경 | 역할 | 이 문서에서의 표기 |
|---|---|---|
| **맥북 (J 개발 PC)** | 소스 원본이 있는 곳. **실행 환경 아님.** | `~/Downloads/...` 등 홈 경로 — *어디서 코드를 가져올지* 알려주는 참조 전용. 코드·설정·배포 스크립트 어디에도 이 경로가 들어가면 안 된다. |
| **로컬 실행** | 개발 중 확인용. React(vite, `server.ts`) + Flask(`python app.py`, 8080) 두 프로세스를 맥북에서 띄움 | `localhost:8080` — 로컬 확인 절차에만 등장 |
| **사내 앱서버 (DIY)** | **실제 동작 환경.** React는 nginx 정적 서빙(`Diyfile.yaml`), Flask는 별도 인스턴스. 둘 다 GitLab push → CI 로 배포 | 같은 도메인 아래 `/eng-apt-cover-windows/` (React) · `/daily-tmap-data-querying-l/` (Flask) path 분기 |

> 원칙: 사내 앱서버는 맥북 파일시스템을 볼 수 없으므로, 런타임이 필요로 하는 모든 파일(파서, pkl)은 **각 리포 안에 커밋**되어 CI로 함께 올라가야 한다. 03 Task 0 이 바로 그 이관 작업이다.

### 0-2. 현재 상태

| 항목 | 실제 상태 |
|---|---|
| Flask 앱 위치 | **별도 리포 `playground-daily-tmap-data-querying-l`** (이 리포에 `backend/` 없음) |
| 로컬 주소 | `http://localhost:8080`, prefix `/daily-tmap-data-querying-l` (`python app.py`) |
| 사내 주소 | `https://playground.idcube.sktelecom.com/daily-tmap-data-querying-l/` — React 앱과 **같은 도메인, path 분기** |
| CORS | **불필요**. 프론트는 상대경로로 same-origin 호출 (`VITE_PY_API_BASE` 비워둘 것, 2026-08-28 사내 확인) |
| 로컬 프록시 | `server.ts`(express)가 `/daily-tmap-data-querying-l/*` → `PY_API_URL` 로 전달 (10분 타임아웃, multipart 스트림 통과) |
| 긴 작업 | **job 방식** — 시작 시 `jobId` 반환 → `GET /los/job/{id}` 폴링 → 완료 시 결과 조회 (`waitForPyJob`) |
| 프론트 클라이언트 | `src/lib/pyApi.ts` 단일 파일. 새 API는 여기에만 추가 (별도 `apiService.js` 만들지 말 것) |
| CAD 파서 | `rapa_dxf_extract` v6 — **원본 위치(맥북, 참조용)**: `~/Downloads/LOS_CAD/rapa_dxf_extract_v6`. 런타임 위치는 Flask 리포 `rapa_dxf_extract/` (03 Task 0 에서 이관) |
| LightGBM | **원본 위치(맥북, 참조용)**: `~/Downloads/pickle/no_polygon_model_lgb-mae-0.38499.pkl` (+ 학습셋 `db2-v2.pkl`). 런타임 위치는 Flask 리포 `models/` (03 Task 0 에서 이관) |

## 1. 서비스 간 통신 토폴로지

```
[React UI (eng-apt-cover-windows)]
│   src/lib/pyApi.ts  ── 모든 Flask 호출은 여기서만
│
├─ (기존) CAD → 폴리곤
│    POST /los/cad/upload   (multipart: rapaKey, file)          → {rapaKey, fileName, sizeBytes}
│    POST /los/cad/extract  (json: rapaKey, complexName, …)     → {jobId}
│    GET  /los/job/{jobId}  (폴링)                              → PyJob
│    GET  /los/job/{jobId}/result                               → {buildings[], georeferenced, …}
│
├─ (기존) DB 폴리곤/안테나
│    POST /los/geo, /los/bundle/job, /los/antenna …
│
├─ (신규) LightGBM 물량 예측   ◀── 이번 작업 범위
│    POST /los/ml/predict   (json: 6개 피처)                    → 동기 응답 (수십 ms, job 불필요)
│
└─ In-Memory: 수신 JSON → LOS Simulator Core → 시뮬레이션/렌더링
        Step2 패널(App.tsx `activePanel === 'model'`)에 예측값 카드 표출
```

## 2. API I/O 스펙

### (1) CAD 파싱 — 기존 구현, 변경 없음 (참조용)

- 업로드: `POST /los/cad/upload` — `multipart/form-data` (`rapaKey`, `file`) → 서버에 `<rapaKey>.dxf` 저장
- 추출: `POST /los/cad/extract` → `{jobId}` → 폴링 → 결과
- 결과 필수 필드 (프론트 `CadUploadPanel.handleExtract`가 참조):
  - `buildings: Array<{dong, polygon, floors?, is_conduit_dong?}>`
  - `georeferenced: boolean` — false면 로컬 mm 좌표 (경고 배지 표시)
  - `complex_polygon`, `surrounding_buildings` (65m)
- 구현 위치: Flask 리포 `/los/cad/*` + 파서 `rapa_dxf_extract` (`auto.py` → `pipeline.py` → `georef.py` → `footprints.py`)

### (2) LightGBM 물량 예측 — **신규**

- **Endpoint**: `POST /los/ml/predict`
- **동기 응답** (모델 추론은 ms 단위, job 래핑하지 않음)
- **Request Body**:
```json
{
  "rapaKey": "APT_092",
  "wide_area": "서울특별시",
  "sigungu": "마포구",
  "total_dong_count": 7,
  "household_count": 1015,
  "building_area": 164403.0,
  "avg_floor_count": 28.0
}
```
- **Response Body** (성공):
```json
{
  "result": "success",
  "data": {
    "rapaKey": "APT_092",
    "raw_prediction": 5.84,
    "predicted_site_count": 6,
    "confidence_interval": [5, 7],
    "model_info": {
      "model_name": "LightGBM Regressor (no_polygon)",
      "model_file": "no_polygon_model_lgb-mae-0.38499.pkl",
      "mae": 0.38499,
      "formula": "round(raw_prediction + 0.05)"
    }
  }
}
```
- **Response Body** (실패) — 기존 Flask 응답 관례 `{"result":"fail","error":"..."}` 를 따른다. HTTP 400(피처 누락/타입 오류), 503(모델 미로드).

#### 입력 피처 매핑 (학습셋 `db2-v2.pkl` 기준 6개 필수)

| API 필드명 | 학습 피처명 | 타입 | 설명 | 예시 |
|---|---|---|---|---|
| `wide_area` | `WIDE_AREA` | String | 광역시도 | "서울특별시" |
| `sigungu` | `SIGUNGU` | String | 시군구 | "마포구", "성남시 분당구" |
| `total_dong_count` | `GCHM_PK (COUNT)` | Integer | 단지 내 총 동수 | 7 |
| `household_count` | `SEDE_CNT (SUM)` | Integer | 총 세대수 | 1015 |
| `building_area` | `BLD_AREA (SUM)` | Float | 건물 바닥면적 합 (m²) — 대지면적 아님 | 164403.0 |
| `avg_floor_count` | `LND_FLOOR_CNT (MEAN)` | Float | 평균 지상 층수 | 28.0 |
| `rapaKey` | (메타) | String | 단지 식별자, 응답에 그대로 반환 | "APT_092" |

> **주의**: 범주형(`WIDE_AREA`, `SIGUNGU`)의 인코딩 방식(category dtype / label map)과 피처 **순서**는 학습 시점과 동일해야 한다.
> pkl 내부 `booster.feature_name()` 을 기준으로 DataFrame 컬럼을 맞출 것. 학습셋에 없는 시군구 값은 400이 아니라 "unknown" 처리 후 응답 `model_info.warnings` 에 기록.

#### 출력 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `raw_prediction` | Float | 회귀 원시값 |
| `predicted_site_count` | Integer | `round(raw + 0.05)` 보정 후 권장 SITE 수 |
| `confidence_interval` | [Int, Int] | `[floor(raw-MAE), ceil(raw+MAE)]` |
| `model_info` | Object | 모델 파일명, MAE, 보정식, warnings |

## 3. 배포 및 동기화 수칙

- 두 리포 모두 GitLab push → 사내 CI → DIY 앱서버 재배포. React는 nginx 정적 서빙(`Diyfile.yaml`), Flask는 별도 인스턴스.
- Flask 리포에 파서 v6와 pkl을 **리포 내부 경로**(`rapa_dxf_extract/`, `models/`)로 커밋해야 사내 배포본에서 동작한다. `~/Downloads` 참조 금지.
- Flask 리포에 `lightgbm` 의존성 추가 → `requirements.txt` 갱신 → 사내 pip 미러에서 설치 가능한지 확인 (불가 시 `idcube_hive_connector` 건과 동일하게 DIY 담당자 문의).
- ping(`/los/ping`) 의 `capabilities` 에 `lightgbm: bool` 추가 → 프론트가 모델 미탑재 환경에서 버튼을 비활성화할 수 있게.

## 4. 에이전트별 세부 작업 명세서

- 🛠️ **Gemini 구현**: [03_GEMINI_IMPLEMENTATION_TASKS.md](./03_GEMINI_IMPLEMENTATION_TASKS.md)
  - Task 0: 파서 v6 · pkl 을 Flask 리포로 이관
  - Task 1: Flask `/los/ml/predict` 구현 (싱글톤 로드, 피처 매핑, 보정식)
  - Task 2: `pyApi.ts` `predictSiteCount()` + App.tsx Step2 스캐폴딩 연결
- 🔍 **Claude 리뷰/감사**: [04_CLAUDE_REVIEW_TASKS.md](./04_CLAUDE_REVIEW_TASKS.md)
  - 피처 순서/인코딩 학습 파이프라인 동일성
  - `georef.py` 좌표 정합 · 방위각 회전 정밀도
  - 임시 파일/메모리 · 싱글톤 · 에러 응답 규격
