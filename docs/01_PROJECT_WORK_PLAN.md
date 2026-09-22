# 5G 인프라 LOS 시뮬레이터 & CAD/ML 파이프라인 통합 작업 계획서

## 1. 프로젝트 개요 및 배경
- **목적**: 신축 아파트 단지 대상 최적의 무선 통신 시설 배치(Line of Sight, LOS) 자동화 및 물량 예측 시스템 구축.
- **현황**:
  - **React 기반 LOS Simulator**: 공간 분석 및 시뮬레이션 알고리즘 독립 모듈 완성.
  - **데이터 한계**: 2027년 경영계획 대상 282개 단지 중 92개 단지가 공간 폴리곤 및 관로동 정보 누락.
  - **해결책**: RAPA(한국전파진흥협회) CAD 도면(DWG -> DXF)을 파싱하여 폴리곤/관로동 JSON을 자동 추출하고, 사전 구축된 LightGBM 시설 물량 예측 모델을 참조(Referral) 데이터로 연동.

## 2. 아키텍처 및 시스템 흐름
1. **Frontend (React)**:
   - CAD(DXF) 파일 업로드 UI 제공.
   - 백엔드(Flask) API 호출 및 분석 상태 폴링/응답 수신.
   - 수신된 단지/건물 폴리곤 기반 LOS 시뮬레이터 실행 및 LightGBM 예측 기준값 오버레이 표출.
2. **Backend Engine (Flask, 별도 리포 `playground-daily-tmap-data-querying-l`)**:
   - `/los/cad/upload` + `/los/cad/extract`(job): DXF 파싱 -> 건물/단지 폴리곤 추출 -> 좌표계/방위각 정합 -> 관로동 메타데이터 생성 -> JSON 반환. **(구현 완료)**
   - `/los/ml/predict`: 아파트 규모 및 단지 메타데이터 기반 LightGBM 물량 예측 추론 결과 반환. **(신규, 이번 범위)**
3. **배포 및 인프라 파이프라인**:
   - 로컬 환경(macOS) -> GitLab 원격 저장소 -> 사내 배포 서버 CI/CD 자동 빌드 및 동기화.

## 3. 세부 마일스톤 및 산출물
- **Phase 1: API 규격화 및 엔드포인트 구축**
  - CAD 파서 v6·LightGBM pkl을 Flask 리포로 이관하고 `/los/ml/predict` 추가 (CAD 엔드포인트는 기존 유지).
- **Phase 2: React 프론트엔드 통신 연동**
  - `pyApi.ts` 에 `predictSiteCount()` 추가, App.tsx Step2 스캐폴딩에 연결 (업로드 UI는 기존 `CadUploadPanel` 유지).
- **Phase 3: 엔드투엔드 파이프라인 정합성 검증**
  - 92개 누락 단지 중 샘플 DXF 대상 파싱 -> JSON 생성 -> LOS 시뮬레이션 가동 및 예측값 비교 테스트.