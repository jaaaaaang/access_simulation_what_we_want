# AI Agent / Development Session Onboarding Guide

> **역할**: 프로젝트 전체 오케스트레이션 마스터 인덱스  
> **최종 업데이트**: 2026-08-08 (los_batch_spec.md 추가)  
> **동기화 대상**: `CLAUDEmd` (이 파일과 항상 동일 내용 유지)

본 지침서는 새로운 AI 작업 세션이 시작되거나 개발자가 작업을 재개할 때, 프로젝트의 최신 사양·맥락·문서 체계를 신속하게 파악하기 위한 **마스터 온보딩 가이드**입니다.

---

## 1. 프로젝트 개요 (30초 요약)

**LOS Simulator & Auto Planner** — 아파트(APT) 인빌딩 RF 장비의 최적 배치를 위한 시뮬레이션 및 자동화 도구

| 구분 | 내용 |
|---|---|
| **목적** | O2I(실외→실내) 베란다 LOS 기반 RF 장비 최적 배치 시뮬레이션 |
| **작성** | 2026년 Access Eng팀 장영우 |
| **기술** | React + TypeScript + Three.js (프론트), Express (서버), IDCube/Athena (데이터) |
| **상용 연계** | MOIRA 최적설계분석 시스템과 `p_common.ailayer_apt_5g` 테이블로 연동 |

---

## 2. 문서 체계 (Document Map)

### 🔴 필수 확인 (세션 시작 시 반드시 읽기)

| 문서 | 목적 | 핵심 내용 |
|---|---|---|
| [README.md](file:///Users/1109425/playground-eng-apt-cover-windows/README.md) | 프로젝트 메인 가이드 | 전체 목적, 이론 배경, 3가지 분석 모드, UI 동작 |
| [enhancement_logic.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/enhancement_logic.md) | **최신 기획 사양 기준서** | Sector 구성 정책, 65° 빔폭, 60° 이격, 베란다 수치화 규칙 |

### 🟡 작업 영역별 참조 문서

#### 시뮬레이션 엔진 (LOS Core)
| 문서 | 목적 |
|---|---|
| [enhancement_logic.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/enhancement_logic.md) | RF 최적화 알고리즘 상세 규칙 |
| [temp_logic.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/temp_logic.md) | 시뮬레이션 로직 임시 정리/초안 |
| [code_logic_compare.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/code_logic_compare.md) | 코드 vs 기획 사양 대조 |

#### 상용 배치 & 데이터 파이프라인
| 문서 | 목적 |
|---|---|
| [workflow_architecture.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/workflow_architecture.md) | **상용 배치 워크플로우** (ATOM → LOS → 최적설계분석) |
| [db_schema_relations.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/db_schema_relations.md) | **4개 DB 테이블 스키마 & 공간 조인 구조** |
| [los_batch_spec.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/los_batch_spec.md) | **LOS 배치 자동화 상세 스펙** — 4단계 파이프라인, 관로동 설계, 미결 이슈 |

#### ML 모델 & AI
| 문서 | 목적 |
|---|---|
| [model_apply.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/model_apply.md) | SITE_COUNT 예측 모델 배포 검토서 |
| [AI_insight.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/AI_insight.md) | AI 기반 인사이트 분석 |

#### UI & 마이그레이션
| 문서 | 목적 |
|---|---|
| [UI_function_list.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/UI_function_list.md) | UI 기능 목록 및 사양 |
| [MIGRATION_GUIDE.md](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/MIGRATION_GUIDE.md) | 마이그레이션 가이드 |

### ⛔ 참조 금지 (Archived)

- **`docs/archive/`** 내 구버전 문서 (`RF_BUSINESS_LOGIC.md`, `LOGIC_BLUEPRINT.md`)
  - 폐지된 정책 포함 (3분기 고정, 45도 이격 등)
  - **절대 최신 기준으로 사용 금지** → `enhancement_logic.md` 참조

---

## 3. 코드 구조 (Code Map)

### 프론트엔드 (React + TypeScript + Three.js)
| 파일 | 역할 | 크기 |
|---|---|---|
| [App.tsx](file:///Users/1109425/playground-eng-apt-cover-windows/src/App.tsx) | 3D Canvas, 수동 장비 Sector 추가/삭제 UI, PCI 시각화 | ~124KB |
| [types.ts](file:///Users/1109425/playground-eng-apt-cover-windows/src/types.ts) | `SimulationMode`, `Equipment`, `CandidateSite` 등 타입 정의 | ~2KB |
| [simulation.ts](file:///Users/1109425/playground-eng-apt-cover-windows/src/lib/simulation.ts) | **LOS 엔진 핵심** — `evaluateRay`, `getSecondVerandas`, `runSimulation` | ~76KB |
| [sampleData.ts](file:///Users/1109425/playground-eng-apt-cover-windows/src/lib/sampleData.ts) | 샘플 건물 데이터 | ~2KB |

### 백엔드 (Express Proxy)
| 파일 | 역할 |
|---|---|
| [server.ts](file:///Users/1109425/playground-eng-apt-cover-windows/server.ts) | VWorld API 프록시, 지도 타일 연동 |
| [vworld_integration.md](file:///Users/1109425/playground-eng-apt-cover-windows/vworld_integration.md) | VWorld/타일맵 연동 명세서 |

### 데이터 파이프라인 (Python)
| 파일 | 역할 |
|---|---|
| [extra/atom_moira.py](file:///Users/1109425/playground-eng-apt-cover-windows/extra/atom_moira.py) | ATOM 스케줄러 — 투자필요지역 → `ailayer_apt_5g` ETL |

---

## 4. 작업 라우팅 가이드 (Task Router)

**작업 요청을 받았을 때, 아래 표로 관련 문서를 빠르게 찾아 참조하세요.**

| 작업 키워드 | 먼저 읽을 문서 | 핵심 코드 |
|---|---|---|
| 시뮬레이션, LOS, 빔, Sector, 베란다 | `enhancement_logic.md` → `README.md` | `simulation.ts` |
| UI, 버튼, 3D, 캔버스, PCI | `UI_function_list.md` | `App.tsx` |
| 배치, 자동화, ATOM, daily, 스케줄 | `workflow_architecture.md` | `atom_moira.py` |
| 배치 상세, 관로동, 루프, NOK, 리포트 | `los_batch_spec.md` | `atom_moira.py` |
| DB, 테이블, 폴리곤, MOIRA, ailayer | `db_schema_relations.md` | — |
| ML, 예측, SITE_COUNT, LightGBM | `model_apply.md` | — |
| VWorld, 지도, 타일, 검색, 건물 | `vworld_integration.md` | `server.ts` |
| 마이그레이션, 이전, 전환 | `MIGRATION_GUIDE.md` | — |

---

## 5. 프로젝트 두 축 (Development Pillars)

본 프로젝트는 **두 가지 독립적이면서 연결된 축**으로 개발됩니다:

### Pillar 1: LOS Simulator 완성도 고도화
- 시뮬레이션 엔진 정확성·기능 향상
- UI/UX 개선, 3D 시각화 품질
- 기준서: `enhancement_logic.md`

### Pillar 2: 상용 배치 워크플로우 자동화
- ATOM → ailayer_apt_5g → LOS 분석 → 결과 Write-back → 최적설계분석 트리거
- `[LOS]` 태그 전략으로 ATOM Full Refresh와 공존
- 기준서: `workflow_architecture.md` + `db_schema_relations.md`

---

## 6. 세션 시작 체크리스트

1. [ ] 이 파일(GEMINI.md)로 전체 문서 맵 파악
2. [ ] 작업 유형에 맞는 문서를 §4 작업 라우팅 가이드에서 찾아 읽기
3. [ ] `docs/archive/` 구버전 문서 참조하지 않도록 주의
4. [ ] 코드 수정 시 `enhancement_logic.md`의 최신 규칙 준수 확인
