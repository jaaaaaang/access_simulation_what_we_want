# LOS Simulator & Auto Planner 
#### (/w AFE 자동화, MOIRA "아파트최적설계" 연계)

> **문서 작성 정보**  
> - **작성자**: 2026년 Access Eng팀 장영우 
> - **참조 문서**: [`docs/00-pm/enhancement_logic.md`](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/enhancement_logic.md)

---

## 1. 목적 (Purpose)

본 프로젝트의 직관적인 목적은 **실제 RF 장비가 아파트(APT) 건물을 지향하여 실내(O2I) 품질을 극대화할 수 있도록, 최적의 위치에서 최소의 장비 수량으로 최고의 퍼포먼스를 내는 시뮬레이션 및 자동 배치 최적화 도구를 구축하는 것**입니다.

이 도구는 실제 현장 RF 환경과 기하학적 3D 건물 구조를 가상 공간에 정밀하게 구현함으로써 설계자가 수동 또는 자동 알고리즘 기반으로 효율적인 인빌딩/아파트 커버리지 설계를 수행할 수 있도록 돕습니다.

---

## 2. 이론적 배경 및 근거 (Theory & Rationale)

### ① 3GPP 표준 준수 및 RF 파라미터 모델링
- **3GPP 표준 준수**: RF 장비의 주파수, 송신 출력, 안테나 틸트각(Tilt), 안테나 빔폭(Beamwidth), 빔 지향 방향(Azimuth) 등을 종합적으로 시뮬레이션에 반영합니다.
- **안테나 빔폭 및 이격 조건**:
  - RF 안테나 기본 **Beam Width: 65°** (Center 각도 기준 좌/우 ±32.5°)
  - 동일 Site 내 Sector 간 이격: Center 각도 기준 **최소 60° 이격**으로 완화 적용 (동일 Site 내 Sector 간 최대 5°의 커버리지 중첩 허용).

### ② Ground Truth: O2I 투과 및 베란다 LOS 기반 설계
현장 설계의 가장 핵심적인 Ground Truth는 **"실내 서비스 품질 확보를 위해서는 외부 신호가 내부로 투과되는 베란다 영역을 가장 잘 바라보는(LOS, Line-of-Sight) 위치에 장비를 배치/지향해야 한다"**는 점입니다.

- **1차(First) 베란다**: 메인 타겟 영역으로 전체 커버리지 모수에 100% 반영하여 설계합니다.
- **2차(Second) 베란다**: 부가 영역으로 모수에는 직접 포함하지 않으나, 1차 베란다를 커버하는 동일 위치에서 여분의 Sector가 추가로 2차 베란다를 지향하면 가점을 부여합니다. (단, 2차 베란다만을 지향하기 위해 새로운 Site를 신규 배치하지는 않음)

### ③ LOS(Line-of-Sight) 수치화 산출식
$$\text{LOS (\%)} = \frac{\sum (\text{RF가 지향/커버하는 1차 베란다 길이})}{\text{전체 1차 베란다 길이}} \times 100$$
*(2차 베란다 커버 시 1차 베란다 대비 **70%** 수준으로 변환하여 가점 반영)*

### ④ Site 및 Sector 배치 물리 제약 조건
- **Site & Sector 구조**: 1개의 Site는 1~3개의 Sector(장비)로 구성됩니다.
- **최대 LOS 합 극대화**: 단일 건물의 과도한 집중 커버(예: 건물 A 90%)보다 복수 건물의 균형 있는 커버(예: 건물 A 60% + 건물 B 60%)를 선호합니다.
- **배치 위치 기준**: 커버 대상 건물과 가까운 지상 또는 복수 건물일 경우 중간 지점 부근에 최적 장비를 배치합니다.
- **건물 차폐(Shadowing) 및 옥상 제약**:
  - 장비는 가로막는 장애물 건물을 너머 신호를 전달할 수 없습니다.
  - 장비가 위치한 건물 옥상 배치를 가정하므로, 장비 자기 자신의 건물 벽면은 차폐 대상에서 제외됩니다 (설치된 자기 건물 자체는 직접 서비스하지 않음).

---

## 3. 실제 동작 방식 및 개발 내역 / UI (Operation & UI)

### ① PCI(Physical Cell Indicator) 기반 시각화
- 동일 Site 내 1~3개 Sector는 **동일한 PCI 값**을 부여받습니다.
- 3D 화면 시각화 시 Site(PCI)별로 명확히 구별되는 **고유 Color**를 매핑하여 모니터링을 직관적으로 수행할 수 있습니다.

### ② 수동 Sector 독립 삭제 (Manual Sector Control)
- 사용자가 수동 배치한 장비(Manual Sector) 삭제 시 Site 전체 삭제뿐만 아니라, 선택한 **개별 Sector 단위**(예: `M-1-A`, `M-1-B` 중 특정 안테나만 선택)로 독립 삭제가 가능합니다.

### ③ 3가지 시뮬레이션 분석 모드
사용자의 작업 시나리오에 따라 UI에서 다음 3가지 분석 모드를 제공합니다:

| 모드 | 모드명 | 설명 |
| :---: | :--- | :--- |
| **①** | **순수 수동 분석<br>(Pure Manual)** | 사용자가 직접 작성/생성한 수동 Sector만으로 순수 커버리지를 분석합니다. (신규 Site 생성 X, 2차 베란다 자동 추가 X) |
| **②** | **수동 + 2차 베란다 자동 섹터<br>(Manual + 2nd Veranda)** | 기존 수동 Sector 기반으로 분석하되, 수동 Site 내 남은 슬롯(최대 3개)에서 2차 베란다를 커버할 여분 Sector만 자동 추가합니다. (신규 Site 생성 X) |
| **③** | **풀 오토 최적화<br>(Full Auto Optimization)** | 수동 Sector + 신규 Auto Site 탐색 및 배치 + 2차 베란다 여분 Sector 추가까지 풀 최적화 시뮬레이션을 수행합니다. |

---

## 4. 개발 환경 및 실행 가이드 (Development Guide)

### 실행 방법
```bash
# 의존성 패키지 설치
npm install

# 로컬 개발 서버 실행 (http://localhost:3000)
npm start

# 프로덕션 빌드
npm run build
```

---

## 5. 프로젝트 문서 관리 체계 (Documentation Structure)

프로젝트 문서의 신뢰성과 유지보수성을 높이기 위해 최신 사양 기준으로 문서를 단일화하여 관리합니다.

- **핵심 유효 문서**:
  - [`README.md`](file:///Users/1109425/playground-eng-apt-cover-windows/README.md): 프로젝트 종합 개요, 개발/실행 가이드 및 최신 기능 명세
  - [`docs/00-pm/enhancement_logic.md`](file:///Users/1109425/playground-eng-apt-cover-windows/docs/00-pm/enhancement_logic.md): 2026년 Access Eng팀 장영우 작성 최신 기획 및 요구사항 기준서
- **아카이브 문서 보관 (`docs/archive/`)**:
  - 개발 초기 및 중간 과정의 구버전 기술 사양서([`RF_BUSINESS_LOGIC.md`](file:///Users/1109425/playground-eng-apt-cover-windows/docs/archive/RF_BUSINESS_LOGIC.md), [`LOGIC_BLUEPRINT.md`](file:///Users/1109425/playground-eng-apt-cover-windows/docs/archive/LOGIC_BLUEPRINT.md))는 참조 및 이력 관리 목적으로 [`docs/archive/`](file:///Users/1109425/playground-eng-apt-cover-windows/docs/archive/) 폴더에 격리/보관되었습니다.

