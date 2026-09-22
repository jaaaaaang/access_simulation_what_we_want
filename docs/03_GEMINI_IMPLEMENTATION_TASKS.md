# Gemini 구현 태스크 명세서

> 2026-09-04 개정. 착수 전 [02_SYSTEM_ORCHESTRATION.md](./02_SYSTEM_ORCHESTRATION.md) §0 전제를 먼저 읽을 것.

## 1. 역할 정의
- 신규 기능(LightGBM 물량 예측)의 백엔드 엔드포인트 + 프론트 연결 구현 전담.
- **하지 말 것**:
  - 이 리포에 `backend/` 디렉토리나 새 Flask 앱을 만들지 않는다. Flask는 별도 리포 `playground-daily-tmap-data-querying-l`.
  - CAD 업로드/추출 기능은 이미 완성됨 (`pyApi.ts` `uploadCadFile`/`extractFromCadJob`, `CadUploadPanel.tsx`). 재구현·리팩터 금지.
  - `apiService.js` 등 별도 API 클라이언트를 만들지 않는다. 모든 Flask 호출은 `src/lib/pyApi.ts` 에 추가.
  - CORS 설정을 추가하지 않는다 (same-origin path 분기).

## 2. 세부 구현 요구사항

### Task 0: 리소스 이관 (Flask 리포) — Task 1 선행 조건
> 아래 `~/Downloads/...` 는 **맥북에 있는 원본의 위치**일 뿐이다. 복사한 뒤 코드는 리포 상대경로만 참조해야 하며, 사내 앱서버에는 이 경로가 존재하지 않는다.
- `~/Downloads/LOS_CAD/rapa_dxf_extract_v6/` → Flask 리포 `rapa_dxf_extract/` 로 교체 (기존 버전이 있으면 v6로 갱신, `auto.py` 도면 유형 자동 판정 포함).
- `~/Downloads/pickle/no_polygon_model_lgb-mae-0.38499.pkl` → Flask 리포 `models/` 로 복사. `db2-v2.pkl`(학습셋)은 피처명·인코딩 확인용으로만 사용, 배포본에 포함하지 않는다.
- `requirements.txt` 에 `lightgbm` (pkl 생성 버전과 메이저 일치) 추가.
- 모델 경로는 `os.path.join(os.path.dirname(__file__), 'models', ...)` 식 리포 상대경로를 기본값으로, 환경변수 `LOS_ML_MODEL_PATH` 로만 오버라이드. 절대경로 하드코딩 금지.
- 이관 후 `grep -rn "Downloads\|/Users/" .` 결과가 0건인지 확인.

### Task 1: Flask `/los/ml/predict` (Flask 리포)
- 기존 `/los/*` 블루프린트 구조와 응답 관례(`{"result":"success"|"fail", ...}`)를 그대로 따른다.
- **모델 싱글톤**: 앱 구동 시 1회 로드(`lru_cache` 또는 모듈 전역), 요청마다 `pickle.load` 금지. 로드 실패 시 앱은 뜨되 엔드포인트는 503 반환.
- **피처 매핑**: 02 §2-(2) 표의 6개 필드 → `booster.feature_name()` 순서로 DataFrame 구성. 범주형은 학습 시 dtype/카테고리 집합과 동일하게 캐스팅 (`db2-v2.pkl` 로 확인).
- **후처리**: `predicted_site_count = round(raw + 0.05)`, `confidence_interval = [floor(raw-0.38499), ceil(raw+0.38499)]`, 최소값 1.
- **검증**: 필수 필드 누락/타입 오류 → 400 + 어떤 필드인지 명시. 미학습 시군구 → unknown 처리 + `model_info.warnings`.
- `/los/ping` 응답 `capabilities` 에 `lightgbm: bool` 추가.
- 동기 응답 (job 래핑 불필요). 로컬 확인: `curl -X POST localhost:8080/daily-tmap-data-querying-l/los/ml/predict -H 'content-type: application/json' -d @sample.json`

### Task 2: React 연결 (이 리포)
- `src/lib/pyApi.ts` 에 추가:
  ```ts
  export type PredictRequest = { rapaKey: string; wide_area: string; sigungu: string;
    total_dong_count: number; household_count: number; building_area: number; avg_floor_count: number };
  export type PredictResult = { rapaKey: string; raw_prediction: number; predicted_site_count: number;
    confidence_interval: [number, number]; model_info: { model_name: string; model_file: string; mae: number; formula: string; warnings?: string[] } };
  export async function predictSiteCount(req: PredictRequest): Promise<PredictResult>  // postJson('/los/ml/predict')
  ```
  `PyPingResult.capabilities` 에 `lightgbm: boolean` 추가.
- `src/App.tsx` Step2 패널(`activePanel === 'model'`, 약 3337행~):
  - 피처 요약 카드의 `—` 4칸을 선택된 단지의 실제 값으로 바인딩 (세대수/동수/바닥면적/지상층수). 값 출처는 `/los/geo` 또는 bundle 결과의 단지 속성 — 없으면 사용자 입력 폼으로 폴백.
  - "⚡ AI 예측 실행" 버튼의 placeholder(`setAiPredResult({rawPred:3.82, finalPred:4})`)를 `predictSiteCount()` 호출로 교체. `aiPredResult` 타입에 `confidenceInterval`, `warnings` 추가.
  - 결과 카드 하단 문구 `onnxruntime-web · LightGBM` → `Flask · LightGBM (MAE 0.385)` 로 수정. 168~170행의 onnxruntime-web TODO 주석 삭제.
  - ping `capabilities.lightgbm === false` 이면 버튼 비활성 + 사유 표시 (`CadUploadPanel` 의 Flask 미연결 안내 패턴 재사용).
  - 로딩/에러: 버튼 busy 상태, 실패 시 `notify(…, 'error')`.

## 3. 산출물 체크리스트
- [ ] Task 0: Flask 리포에 `rapa_dxf_extract/`(v6) · `models/*.pkl` · `requirements.txt` 커밋
- [ ] Task 1: `POST /los/ml/predict` 동작 + 샘플 요청 curl 결과 첨부, `/los/ping` 에 `lightgbm` 플래그
- [ ] Task 2: `pyApi.ts` `predictSiteCount()` · App.tsx Step2 실제 추론 연결, placeholder 제거
- [ ] 에러 케이스 확인: 필드 누락(400), 모델 미로드(503), Flask 미연결(프론트 안내)
- [ ] 완료 후 04 리뷰를 위해 변경 파일 목록과 diff 요약을 `docs/05_IMPL_REPORT.md` 에 기록
