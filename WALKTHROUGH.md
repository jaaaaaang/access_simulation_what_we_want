# Walkthrough — LOS 대량 배치 분석 (Phase 0~2)

> **문서 버전**: v1.0.0 (2026-08-17)  
> **관련 계획서**: [TODOLIST.md](file:///Users/1109425/playground-eng-apt-cover-windows/TODOLIST.md) §5 Phase 0~2  
> **상태**: 구현 및 E2E 검증 완료

본 문서는 **LOS 시뮬레이터 대량 배치 분석(Phase 0~2)** 의 아키텍처, 구현 명세, 레이스 컨디션 및 원자성 방어 설계, 그리고 테스트 결과를 정리한 기술 문서입니다.

---

## 1. 주요 변경 및 모듈 구성

### 1) Phase 0 — 공통 기반 (Common Foundation)
- [src/lib/scenePrep.ts](file:///Users/1109425/playground-eng-apt-cover-windows/src/lib/scenePrep.ts):
  - `App.tsx` 내 분산되어 있던 투영 등방화 매핑(`fitIsotropicMapping`, `squareUpMapping`, `pixelsPerMeterFromMapping`)과 MOIRA temps JSON → 캔버스 좌표계 변환 및 `generateAutoVerandas` 호출 로직을 순수 함수 `prepareSceneFromMoira`로 추출.
- [src/types.ts](file:///Users/1109425/playground-eng-apt-cover-windows/src/types.ts):
  - TODOLIST §3 및 `docs/00-pm/los_batch_spec.md` Step 4 규격에 맞춘 타입 추가 (`BatchResult`, `Rank1Detail`, `TopRankSummary`, `BatchStepReport`, `ResultIndex`, `BatchJobStatus` 등).
  - 커버리지 0%/0site 상태를 식별하기 위한 `BatchResultStatus` (`'OK' | 'WARN' | 'NOK'`) 도입.
- [src/lib/pathUtils.ts](file:///Users/1109425/playground-eng-apt-cover-windows/src/lib/pathUtils.ts):
  - `validateRapaKey`: 특수문자 및 Path Traversal (`..`, `%2F` 등) 차단.
  - `safeFilePath`: 루트 탈출 방지 경로 산출.
  - `atomicWriteJson`: 임시 파일 작성 후 `fs.rename`을 통한 원자적(Atomic) 파일 교체.
- [src/App.tsx](file:///Users/1109425/playground-eng-apt-cover-windows/src/App.tsx):
  - `scenePrep.ts`를 import하도록 리팩토링하여 브라우저 UI 동작 및 단건 분석 무영향(Zero Regression) 보장.

### 2) Phase 1 — 헤드리스 러너 (Headless Runner)
- [scripts/losRunner.ts](file:///Users/1109425/playground-eng-apt-cover-windows/scripts/losRunner.ts):
  - 단일 RAPA 단지 대상 헤드리스 실행 CLI 및 자식 프로세스 모듈.
  - 실행 흐름: `temps JSON 로드` → `scenePrep` → `verandaAi` → `runSimulation` → `Rank1 상세 + Top5 기하 요약 직렬화` → `atomicWriteJson`으로 `data/results/<rapaKey>.json` 저장.
  - Fail-safe 예외 처리: 데이터 누락 또는 시뮬레이션 오류 시 Step 4 리포트 포맷에 맞추어 `status: 'NOK'`로 기록하고 정상 종료.

### 3) Phase 2 — 배치 매니저 & REST APIs
- [server/batchManager.ts](file:///Users/1109425/playground-eng-apt-cover-windows/server/batchManager.ts):
  - **Job Queue**: 상태 전이 관리 (`pending` → `running` → `completed` | `failed` | `skipped`).
  - **Worker Pool**: `child_process.fork`로 `scripts/losRunner.ts`를 격리 실행 (동시성 2~4개 제어, Express 이벤트 루프 차단 방지).
  - **Race Condition 방지**: `AsyncLock` 기반 Promise 직렬화로 다중 워커의 동시 종료 시 `_index.json` 및 `queue.json` 갱신 유실 완전 차단.
  - **State Persistence**: 큐 상태를 `data/batch/queue.json`에 원자적 영속화하고 서버 재시작 시 안전하게 복구.
  - **Index 관리**: 완료 건 발생 시 `data/results/_index.json` 원자적 갱신.
- [server.ts](file:///Users/1109425/playground-eng-apt-cover-windows/server.ts):
  - `POST /api/batch/start` — rapaKeys, params, concurrency, skipAnalyzed 일괄 시작
  - `GET /api/batch/status` — 진행률, 활성 워커, 잔여 예상시간(ETA), 개별 잡 상태 폴링
  - `POST /api/batch/cancel` — 활성 워커 프로세스 graceful kill 및 큐 취소
  - `GET /api/results/list` — `_index.json` 기반 전체 분석 결과 목록
  - `GET /api/results/:rapaKey` — 특정 단지 상세 결과 JSON 조회
  - `DELETE /api/results/:rapaKey` — 특정 단지 결과 및 인덱스 항목 삭제

### 4) Phase 3 — 전체 리스트 대시보드 UI (Dashboard View)
- [src/components/DashboardView.tsx](file:///Users/1109425/playground-eng-apt-cover-windows/src/components/DashboardView.tsx):
  - **요약 카드 및 진행 헤더 전환**: 평상시에는 7개 요약 메트릭(전체, OK, WARN, NOK, 미분석, 평균 커버리지, 총 사이트/섹터)을 표시하고, 배치 실행 중에는 실시간 진행률, 활성 워커 수, 현재 대상 단지, ETA 잔여시간 계산, 취소 버튼이 있는 실시간 진행 헤더로 자동 전환.
  - **테이블 & 필터링 & 검색**: 288개 단지 목록(`apt_list.csv`)과 `_index.json` 실시간 조인. 체크박스(전체/필터결과 선택), 상태 배지(완료/경고/실패/실행중/대기/미분석), 커버리지 진행 바(60% 이상 초록, 30~59% 주황, 30% 미만 빨강), 본부/시도/읍면동 연동 필터, 실시간 텍스트 검색 및 다중 컬럼 정렬 지원.
  - **원클릭 실패/경고 재시도**: `summary.nokCount + summary.warnCount > 0`일 때 실패/경고 단지만 자동 선택하여 재분석 모달 호출.
  - **배치 시작 모달**: 선택 대상 요약, 완료 건 건너뛰기(Skip) vs 강제 재분석 라디오, 동시 실행 워커 수(1~4, 기본 2), 공통 파라미터(빔폭, 도달거리, 목표 커버리지, 공용 기지국 엄격 모드) 프리필 및 예상 소요시간 산출.
  - **상세 Drawer**: 행 클릭 시 우측 슬라이딩 패널 오픈. Rank 1 최적 배치 요약, 배치된 장비 위치 및 좌표, 건물별 커버리지 진행 바, 그리고 Top 1~5 순위별 배치 후보에 대한 **SVG 벡터 미니맵**(건물 외곽선 + 65° 안테나 빔 부채꼴 + 사이트 점 오버레이) 렌더링.
  - **결과 관리**: Drawer 내 "결과 삭제" 버튼(확인 다이얼로그 후 `DELETE /api/results/:rapaKey` 호출 및 인덱스 실시간 갱신)과 "지도에서 열기 (Phase 4)" 슬롯 마련.
- [src/App.tsx](file:///Users/1109425/playground-eng-apt-cover-windows/src/App.tsx):
  - 상단 탭 `mainView === 'list'`에 `<DashboardView />` 컴포넌트를 마운트하여 기존 지도 탭 및 단건 분석 기능과 완벽히 공존하도록 연결.

---

## 2. 레이스 컨디션 및 원자성 방어 설계

1. **`_index.json` / `queue.json` 갱신 직렬화**:
   - `AsyncLock` 큐를 통해 `updateIndex()` 및 `persistQueue()` 호출을 직렬화하여 동시 종료 시 발생하는 read-modify-write 레이스 컨디션 방지.
2. **원자적 파일 교체 (Atomic Rename)**:
   - `atomicWriteJson()`은 `.tmp.<pid>.<timestamp>` 파일에 먼저 JSON을 기록하고 `fs.rename`을 수행하므로, 작업 도중 SIGTERM으로 프로세스가 종료되어도 손상된(corrupted) JSON이 잔존하지 않음.
3. **경로 탐색 공격(Path Traversal) 방지**:
   - `validateRapaKey`로 영숫자, `_`, `-`, `.` 외 특수문자나 상위 디렉토리 접근(`..`)을 원천 차단하고 `path.resolve`를 통해 `data/results/` 외부 파일 접근 차단.
4. **0%/0site 상태 WARN 분류**:
   - 단지 내 베란다 후보 부재 또는 목표 미달로 0%/0site가 나오는 경우 `status: 'WARN'`과 사유(`warningMsg`)를 기록하여 대시보드에서 분석 대상 없음 상태를 명확히 식별 가능.

---

## 3. 검증 결과 (Verification Results)

### 1) 자동화 E2E 테스트 스위트 실행
```bash
npm run test:batch
```

**결과 출력:**
```
================================================================
🧪 LOS Batch Simulation E2E & Pilot Verification (Test Env)
================================================================

[TEST 1] Headless Pipeline Consistency & JSON Serialization...
 - Direct Pipeline Coverage: 48.7%, Sites: 1
 - Headless Runner Coverage:  48.7%, Sites: 1
 ✅ [TEST 1 PASS] 헤드리스 장면 구성 및 시뮬레이션 직렬화 결과가 일치합니다.

[TEST 2] BatchManager Worker Pool & Status Classification (OK, WARN, NOK)...
 - Batch started: Total 4, Queued 4
 - Batch finished with status: completed
 - Completed: 3, Failed: 1, Skipped: 0
 ✅ [TEST 2 PASS] 유효 단지 3건(OK/WARN) 완료 + 비정상 단지 1건 NOK 격리 확인 완료.

[TEST 3] _index.json 상태 구분 (OK / WARN / NOK) 검증...
 - Index status summary:
   * m-RAPA-2107-4632: status=OK, coverage=48.7%, error=none, warning=none
   * m-RAPA-2407-1978: status=WARN, coverage=0%, error=none, warning=커버리지 0% (배치 대상 베란다/후보점 부재 또는 목표 커버리지 미도달)
   * m-RAPA-2207-4073: status=WARN, coverage=0%, error=none, warning=커버리지 0% (배치 대상 베란다/후보점 부재 또는 목표 커버리지 미도달)
   * m-RAPA-INVALID-NONEXISTENT: status=NOK, coverage=undefined, error=temps 데이터 파일을 찾을 수 없습니다, warning=none
 ✅ [TEST 3 PASS] _index.json 에 OK, WARN, NOK 상태가 명확히 분류되어 기록되었습니다.

[TEST 4] Skip Analyzed 기능 검증 (이미 분석된 단지 자동 건너뛰기)...
 - Total: 3, Queued: 1, Skipped: 2
 ✅ [TEST 4 PASS] 이미 분석된 2건을 정확히 Skip하고 신규 1건만 Queue에 등록했습니다.

[TEST 5] Batch Cancellation (작업 즉시 취소 & 프로세스 정리 검증)...
 - Cancelled: true, Stopped processes: 2
 ✅ [TEST 5 PASS] 배치 취소 정상 처리 및 워커 프로세스 회수 완료.

[TEST 6] Result Detail & Delete API 검증...
 - Result loaded: Rank1 Coverage 48.7%, 2nd Samples 0, VerandaSource verandaAi-v2.2
 - Delete NOK result: true
 ✅ [TEST 6 PASS] 결과 조회 및 삭제 후 인덱스 갱신 정상 작동 확인.

[TEST 7] 10개 단지 실전 배치 종합 E2E 테스트...
 - 10-item batch started: 10 queued
 🎉 10건 배치 완료: 성공 10건, 실패 0건 (상태: completed)
 - 테스트 임시 디렉토리 정리 완료.
 ✅ [TEST 7 PASS] 10건 배치 종합 E2E 완료!

================================================================
🏆 ALL TESTS PASSED! Phase 0~2 All Requirements Verified
================================================================
```

### 2) 브라우저 서브에이전트 실 UI 검증
- **전체 리스트 탭**: 288개 단지와 요약 카드(완료 8건, 경고 3건, 실패 0건) 및 필터/검색 테이블 정상 렌더링.
- **다중 선택 & 모달**: 체크박스 선택 후 배치 시작 모달 호출, 파라미터/예상 소요시간(약 4분)/건너뛰기 라디오 옵션 정상 표시.
- **상세 Drawer & SVG 미니맵**: 행 클릭 시 우측 패널 오픈, Rank 1 요약, 건물별 커버리지, Top 1~5 비교 카드 및 벡터 빔 미니맵 SVG 렌더링 확인.
- **단건 분석 회귀 방지**: 기존 지도 탭 및 단건 AI 베란다 세팅, 모델 예측, 수동/자동 최적화 시뮬레이션 정상 작동 유지.

### 3) 정적 분석 검사
```bash
npm run lint
```
- TypeScript 컴파일러(`tsc --noEmit`): 오류 0개 (Exit Code 0)
