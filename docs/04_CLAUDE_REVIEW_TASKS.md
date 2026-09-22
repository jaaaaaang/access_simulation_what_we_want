# Claude 코드 검토 및 아키텍처 감사 명세서

> 2026-09-04 개정. 리뷰 대상은 03의 Task 0~2 산출물(`docs/05_IMPL_REPORT.md` 기준).

## 1. 역할 정의
- Gemini 구현 코드의 버그·성능 병목·아키텍처 정합성 검토.
- 통신 도메인 특수성(좌표 정합 정밀도, 모델 입력 정합성) 기반 심층 리뷰.
- 03 의 "하지 말 것" 위반 여부(중복 클라이언트, `backend/` 신설, CORS 추가) 를 최우선으로 확인.

## 2. 중점 점검 항목

### (1) 모델 입력 정합성 (최우선)
- `booster.feature_name()` 과 요청 → DataFrame 컬럼 **순서·이름** 일치 여부.
- 범주형(`WIDE_AREA`, `SIGUNGU`) 인코딩이 학습 시점과 동일한지 — `db2-v2.pkl` 의 dtype/카테고리 집합과 대조. 미학습 값 처리(unknown) 가 silent 오답을 내지 않는지.
- `building_area` 가 대지면적이 아닌 `BLD_AREA (SUM)` 으로 들어오는지 (프론트 바인딩 출처 확인).
- 보정식 `round(raw+0.05)` 와 CI 계산, 최소값 1 처리. 결측/음수/NaN 입력 시 동작.
- 샘플 3~5개 단지로 pkl 직접 추론값과 API 응답값 일치 확인.

### (2) GIS 좌표 정합 (`rapa_dxf_extract` v6, Task 0 이관본)
- `georef.py` 의 로컬 도면 좌표 → WGS84 변환 시 방위각 회전 행렬·원점 오프셋 계산 오류 여부.
- `auto.py` 도면 유형(A/B/XREF/C) 판정 실패 시 fallback 경로와 `georeferenced:false` 반환 정확성.
- `is_conduit_dong` 과 건물 폴리곤 1:1 매핑 누락 가능성.
- 추출 결과가 `CadUploadPanel.onExtracted` → LOS Simulator 입력 구조(`src/types.ts` `Polygon = Point[]`)로 손실 없이 변환되는지.

### (3) 리소스·성능
- 모델 싱글톤: 요청마다 `pickle.load` 하지 않는지, 멀티 워커(gunicorn) 환경에서 워커별 1회 로드인지.
- 기존 `/los/cad/upload` 임시 파일 정리, 대용량 DXF 파싱 중 메모리 상한.
- 동기 `/los/ml/predict` 가 job 큐를 우회해도 되는 응답 시간(<1s)인지 실측.

### (4) 배포 정합
- pkl·파서가 리포 내부 경로로 참조되는지(`~/Downloads` 잔존 금지), `LOS_ML_MODEL_PATH` 기본값.
- `lightgbm` 버전이 pkl 생성 버전과 호환되는지, 사내 pip 미러 설치 가능 여부.
- 프론트가 `capabilities.lightgbm=false` 환경에서 깨지지 않는지.

## 3. 산출물
- `docs/06_REVIEW_REPORT.md`: 항목별 판정(OK/수정필요) + 근거 + 재현 절차
- 수정 필요 건은 파일별 diff 패치 또는 대체 코드 제안
