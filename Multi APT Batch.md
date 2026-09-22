# Multi APT Batch — 대량 아파트 배치 분석 (스케줄링 분석)

> **최종 업데이트**: 2026-08-17
> **상태**: Phase 0~4 구현·검증 완료 (마무리 재작업 4건 반영 중) · 282건 실전 완주(Phase 5) 대기
> **참조**: [TODOLIST.md](TODOLIST.md)(실행 계획 원본), [WALKTHROUGH.md](WALKTHROUGH.md)(기술 상세),
> [docs/00-pm/los_batch_spec.md](docs/00-pm/los_batch_spec.md)(사내망 파이프라인 연계)

---

## 1. 개요 — 왜 이 기능인가

27년 경영계획 대상 **282개 아파트 단지**의 LOS 커버리지 분석은 단지당 5~10분이 걸린다.
사용자가 한 건씩 실행하고 기다리는 방식으로는 전체 분석이 불가능하다 (직렬 23시간+).

Multi APT Batch는 이를 해결한다:

- **일괄 실행**: 전체 리스트에서 대상을 체크박스로 선택(또는 전체/실패만) → 한 번의 실행으로 백그라운드 분석
- **백그라운드 워커**: 서버가 자식 프로세스 워커 풀(동시 2~4개)로 순차 소화 — UI는 계속 사용 가능
- **결과 DB화**: 모든 결과가 JSON 저장소에 축적되어 대시보드·지도에서 조회/비교/복원
- **수동 분석 통합**: 지도 탭에서 수동 튜닝한 결과도 같은 저장소에 등록 (`source: 'manual'`)

> **용어 정리 — "스케줄링"의 현재 범위**: 현재 구현은 **온디맨드 배치**(사용자가 실행 버튼을 누르면
> 큐에 등록되어 백그라운드로 순차 처리)이다. 시간 예약 실행(예: 매일 02:00 자동 실행)은
> 후속 항목으로, 큐/워커 구조가 이미 있으므로 트리거만 추가하면 된다 (§9 참조).

---

## 2. 사용자 플로우

### 2.1 대시보드 배치 실행 (기본 경로)

```
[전체 리스트 탭]
  ├─ 요약 카드: 전체 / 완료(OK) / 경고(WARN) / 실패(NOK) / 미분석 / 평균 커버리지 / 총 Site·Sector
  ├─ 테이블: 체크박스 선택 · 상태 배지 · 커버리지 바 · 필터(본부/시도/읍면동/상태) · 정렬 · 검색
  │
  ├─ [선택 단지 시뮬레이션] ──▶ 배치 시작 모달
  │     · 대상 요약 (선택 N건, 예상 소요시간)
  │     · 기존 분석 건: 건너뛰기(Skip) / 강제 재분석 선택
  │     · 파라미터: 사이드바 값 프리필 + [표준 기본값 리셋] (65° / 150m / 60%)
  │     · 동시 워커 수 (1~4, 기본 2)
  │
  ├─ 실행 중: 요약 카드 영역이 진행 헤더로 전환
  │     진행 n/N · 활성 워커 · 현재 실행 단지 · 예상 잔여시간 · [배치 취소]
  │     (2.5초 폴링 — 탭을 벗어나도 배치는 서버에서 계속 진행)
  │
  ├─ [실패/경고 재시도]: NOK·WARN 건만 모아 강제 재분석으로 실행
  │
  └─ 행 클릭 ──▶ 상세 Drawer
        Rank1 요약 · 건물별 커버리지 바 · Top1~5 비교(SVG 미니맵) · [지도에서 열기] · [결과 삭제]
```

### 2.2 수동 분석 결과 등록 (지도 → 리스트)

지도 탭에서 단건 분석(베란다 수정·수동 장비 튜닝 포함) 후 **[전체 리스트에 저장]** 버튼으로
현재 결과(선택된 Rank 기준)를 저장소에 등록한다. 배치 결과와 동일 스키마이며 `source: 'manual'`
배지로 구분된다. 기존 결과가 있으면 기존/신규 수치를 비교하는 덮어쓰기 확인 후 저장된다.
(RAPA Key로 로드된 단지 + 지리 좌표 매핑 존재 시에만 활성화 — SHP/이미지 배경 제외.
Save Topology/Download export와는 별개 기능.)

### 2.3 저장 결과 지도 복원 (리스트 → 지도)

상세 Drawer의 **[지도에서 열기]**: 해당 단지 토폴로지를 로드하고 저장된 결과(장비 위치·각도,
커버리지 수치, 커버 샘플 오버레이, Top5 랭크)를 **재시뮬레이션 없이** 화면에 복원한다.
복원 상태에서 이어서 튜닝 → 다시 수동 저장하는 왕복 워크플로우를 지원한다.

### 2.4 CLI / API (자동화·검증용)

```bash
# 단건 헤드리스 실행
npm run batch:run -- m-RAPA-1908-4586

# 배치 시작 (API)
curl -X POST http://localhost:3000/api/batch/start \
  -H "Content-Type: application/json" \
  -d '{"rapaKeys":["m-RAPA-2208-4608","m-RAPA-2402-0382"],"concurrency":2,"skipAnalyzed":true}'
```

---

## 3. 아키텍처

```
[DashboardView.tsx]                [server.ts (Express, npm run dev)]
  실행/폴링/취소/조회  ◀──REST──▶   BatchManager (server/batchManager.ts)
                                     ├─ 잡 큐 + AsyncLock 직렬화 + 원자적 파일쓰기(tmp+rename)
                                     ├─ 큐 영속화: data/batch/queue.json
                                     └─ Worker Pool: child_process.fork × 동시 2~4
                                          └─ scripts/losRunner.ts (헤드리스 단건, CLI 겸용)
                                               temps/<key>.json → scenePrep → verandaAi
                                               → runSimulation → resultSerializer → 결과 JSON
[App.tsx 지도 탭]
  수동 저장 ──POST /api/results/save──▶ BatchManager.saveManualResult (동일 락·쓰기 경로)
  지도 복원 ◀──GET /api/results/:key────┘

공용 모듈 (브라우저·헤드리스 동일 코드 = 결과 일치 보장):
  src/lib/scenePrep.ts        장면 구성 (등방 매핑, 단지별 PPM 자동 산출, 베란다 자동 생성)
  src/lib/resultSerializer.ts 결과 조립 buildBatchResult() (site 그룹핑, Top5, WARN 판정)
  src/lib/pathUtils.ts        validateRapaKey / safeFilePath / atomicWriteJson
```

### 핵심 설계 결정

| 결정 | 이유 |
|---|---|
| 워커 = `child_process.fork` | 시뮬레이션이 동기 CPU-bound(대형 단지 ~5분) — 서버 프로세스에서 직접 돌리면 API가 멎음 |
| 장면 구성·결과 조립을 공용 모듈로 추출 | 브라우저 단건과 배치가 **같은 코드**를 쓰게 하여 결과 불일치 원천 차단 (3-way 일치 검증 완료) |
| 저장소 = JSON 파일 | temps 패턴과 일관, 사내망 DIY 서버에 DB 설치 없이 이관 가능. 추후 MariaDB 변환은 어댑터만 교체 |
| PPM(축척)은 단지별 자동 산출 | 배치 파라미터는 화이트리스트(빔폭/거리/목표/strict/모드)만 전파 — 축척·분석영역 오염 이중 방어(FE+BE) |
| 파라미터 기록 | 결과 JSON에 최종 유효 파라미터를 저장(재현성). PPM/analysisArea가 결과에 있는 것은 기록용으로 정상 |

### 표준 파라미터 (2026-08-17 확정)

**beamWidth 65° / maxRange 150m / targetCoverage 60%** — 단일 상수(`STANDARD_SIM_PARAMS`)로
정의하고 사이드바 초기값·러너 기본값·모달 리셋 버튼이 모두 참조한다. 배치 모달은 사이드바 값을
프리필하되(확정 사양) 리셋 버튼으로 표준값 복귀 가능. **전체 리스트의 커버리지 수치는 이 표준
파라미터 기준일 때만 상호 비교 가능하다.**

---

## 4. API 명세

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/batch/start` | 배치 시작. body: `{ rapaKeys[], params(화이트리스트), concurrency(1~4), skipAnalyzed, forceRerun }` |
| GET | `/api/batch/status` | 진행 상태 폴링 (진행 수, 활성 워커, 현재 단지, ETA, 항목별 상태) |
| POST | `/api/batch/cancel` | 실행 중 배치 취소 (자식 프로세스 SIGTERM, pending은 건너뜀 처리) |
| GET | `/api/results/list` | `_index.json` 기반 전체 결과 요약 목록 |
| GET | `/api/results/:rapaKey` | 단지 상세 결과 JSON |
| POST | `/api/results/save` | 수동 분석 결과 등록 (`source:'manual'`, 5MB 상한) |
| DELETE | `/api/results/:rapaKey` | 결과 삭제 (파일 + 인덱스 동시 정리) |

모든 rapaKey는 `^[A-Za-z0-9._-]+$` 검증 + 경로 재확인(path traversal 차단)을 통과해야 한다.

---

## 5. 결과 데이터 스키마

```
data/
├── batch/queue.json                # 배치 큐 상태 (영속화, 원자적 갱신)
└── results/
    ├── _index.json                 # 대시보드용 요약 인덱스 (전 단지 1항목씩)
    └── <rapaKey>.json              # 단지별 상세 결과
```

```jsonc
// <rapaKey>.json (요약)
{
  "rapaKey": "m-RAPA-1908-4586",
  "analyzedAt": "...", "durationSec": 280,
  "status": "OK",                       // OK | WARN | NOK
  "source": "batch",                    // batch | manual
  "warningMsg": null,                   // WARN 사유 (예: 커버리지 0%)
  "params": { "beamWidth":65, "maxRange":150, "targetCoverage":60, "pixelsPerMeter":2.392, ... },
  "scene":  { "buildingCount":..., "verandaSource":"verandaAi-v2.2", "pixelsPerMeter":... },
  "rank1": {                            // 채택안 상세
    "coverageRatio": 61.4,
    "sites": [{ "x","y","lng","lat","sectors":[{ "id","angle","type" }] }],
    "buildingCoverages": [...],         // 동별 달성률
    "coveredSamples": [...],            // 지도 복원용 커버 샘플 좌표 (0.1px 반올림)
    "secondCoveredSamplesPoints": [...],
    "logs": [...]                       // 상한 100건 (초과분 요약 절삭)
  },
  "topRanks": [                         // Rank1~5 요약 + 배치 기하 (SVG 미니맵 렌더용)
    { "rank":1, "coverageRatio":61.4, "siteCount":4, "sectorCount":8, "sites":[...] }, ...
  ],
  "stepReport": { ... }                 // los_batch_spec.md Step 4 OK/NOK/SKIP 포맷 (사내망 이관 호환)
}
```

**상태 분류**: 시뮬레이션이 완료됐어도 `커버리지 0% && site 0개`면 `WARN`으로 분류하고 사유를
기록한다 (단일동 단지는 구조상 0% — 맞은편 건물이 없어 LOS 성립 불가). 실행 실패는 `NOK` + 에러
메시지. 대시보드는 세 상태를 구분 표시한다.

---

## 6. 안정성 설계 (검증 완료 항목)

| 항목 | 구현 | 검증 방법 |
|---|---|---|
| 인덱스 동시 갱신 race | AsyncLock 직렬화 + tmp/rename 원자쓰기 | 동시 100건 해머테스트 → 100건 전부 기록 (유실 0) |
| 결과 파일 부분쓰기 | atomicWriteJson (취소 kill 시에도 corrupt 없음) | 코드 경로 검증 |
| IPC 메시지 유실 | 러너: send 콜백 후 exit / 매니저: 결과 파일 직접 읽기 폴백 | 이중 방어 |
| Path traversal | validateRapaKey + safeFilePath 전 경로 적용 | `../` 실공격 → 차단 확인 |
| 실패 격리 | 한 단지 실패는 NOK 기록 후 다음 단지 진행 | 무효 키 포함 배치 e2e |
| 파라미터 오염 | FE 화이트리스트 + BE strip 이중 방어 (PPM·분석영역 전파 금지) | 오염 시 79.3%→64.8% 왜곡 실증 후 차단 확인 |
| 취소 | SIGTERM graceful kill + 상태 전환 | e2e |
| 서버 재시작 | 큐 영속화, 중단 건은 failed 처리 (이어하기는 후속 결정) | init 로직 |

**결과 정합성 최종 검증**: 동일 단지(1908-4586, 39동급)를 ① 브라우저 UI 단건 실행,
② 로컬 헤드리스, ③ 클라우드 독립 재실행 — 3개 경로 모두 **61.4% / 4 Site / 8 Sector**로
결과 JSON까지 동일함을 확인 (표준 파라미터 기준).

---

## 7. 성능 실측과 운영 가이드

- 단지당 소요: 대형(39동급) **약 4.5~5분**, 중소형 1~20초 (건물 수·후보점 수에 초선형 비례)
- **282건 전체**: 직렬 약 23시간 → **동시 3워커 기준 약 8시간** — 야간 실행 권장
- 동시 워커 수는 로컬 장비 성능·발열 고려 기본 2, 최대 4
- 이미 분석된 단지는 기본 Skip — 신규/실패분만 소화하므로 재실행 비용 낮음
- 분석 시간 단축은 별도 성능 트랙 (프로파일링 선행 필요 — 사전필터 프로토타입은 25% 개선에 그침, 병목 미확정)

---

## 8. 사내망 이관 관점

- 결과가 표준 JSON이므로 사내망에서는 **JSON 직사용** 또는 **MariaDB 변환** 중 선택 (어댑터 계층만 추가)
- stepReport가 los_batch_spec.md Step 4 리포트 포맷과 정렬되어 있어 RAPA→LOS→CellPlan
  자동화 파이프라인(Step 2.6 헤드리스 실행)에 러너를 그대로 재사용 가능
- 입력(temps JSON)을 Athena/ATOM 쿼리 산출물로 교체하면 생성 자동화(P1)와 연결됨

---

## 9. 남은 항목

| 구분 | 내용 |
|---|---|
| 마무리 재작업 (진행 중) | express.json 100KB 제한 수정(6MB), source 필드 서버 정규화, 모달 표준값 리셋 버튼, STANDARD_SIM_PARAMS 단일 상수화 |
| Phase 5 | 282건 실전 완주 (야간, 표준 파라미터) → 실패 목록 원인 분류 |
| 시간 예약 실행 | 큐/워커 구조 재사용, 트리거(cron 유사)만 추가 — "매일 새벽 신규분 자동 분석" 형태 |
| 재기동 이어하기 | 서버 재시작 시 pending 자동 재개 여부 — 결정 대기 (현재: 실패 처리 후 "실패만 재시도" 버튼으로 커버) |
| rankResults 정렬 | Rank2~4가 Rank1보다 우세한 사례 발견 (61.8%/7sector > 61.4%/8sector) — simulation.ts 랭킹 기준 별도 조사 |
| 맵마커 | 지도 탭 단지 마커 — Drawer 미니맵으로 니즈 충족되어 백로그 강등 |
