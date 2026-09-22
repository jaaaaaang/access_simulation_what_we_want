# 📱 UI Function List (시스템 UI 메뉴 구성 및 기능 사양서)

본 문서는 **5G/6G In-Building & 베란다 O2I 투과 커버리지 최적화 시뮬레이션 시스템**의 모든 UI 메뉴 구성, 인덱스, 명칭 및 세부 기능(역할)을 정리한 사양서입니다.

---

## 1. 🔝 상단 탑바 및 글로벌 툴바 (Top Bar & Global Header)

| UI Index | UI 메뉴 명칭 | 위치 | 주요 기능 및 역할 |
| :--- | :--- | :--- | :--- |
| **UI-1.1** | **System Title & Status** | 탑바 좌측 | 프로젝트 명칭, 시스템 버전 정보 및 현재 로딩 상태 표시 |
| **UI-1.2** | **VWorld 검색창 (Location Search)** | 탑바 중앙 | 전국 아파트 및 건물명 검색 입력창. 검색 클릭 시 브이월드 OpenAPI를 통해 해당 위치 건물 외곽 폴리곤을 자동 수집 |
| **UI-1.3** | **Map Tile Selector** | 탑바 중앙 | 배경 지도 타일 레이어 변경 (`Base`: 일반지도, `Satellite`: 위성지도, `Hybrid`: 하이브리드, `None`: 배경 없음) |
| **UI-1.4** | **SHP / GeoJSON Upload** | 탑바 우측 | 외부 공간정보 파일(SHP/GeoJSON)을 읽어와 건물 및 베란다 레이어로 자동 변환 |
| **UI-1.5** | **Background Image Upload** | 탑바 우측 | 현장 도면 이미지(PNG, JPG)를 Canvas 배경으로 불러오기 |
| **UI-1.6** | **Reset & Load Sample** | 탑바 우측 | 전체 토폴로지 리셋 또는 표준 샘플 데이터(아파트 건물/베란다) 즉시 로드 |

---

## 2. 🎨 메인 캔버스 조작 툴바 (Canvas Control Toolbar)

| UI Index | UI 메뉴 명칭 | 위치 | 주요 기능 및 역할 |
| :--- | :--- | :--- | :--- |
| **UI-2.1** | **Draw Building (건물 그리기도구)** | 캔버스 상단 | 다각형(Polygon) 형태의 차폐 건물 생성 (클릭으로 정점 추가, 우클릭/마지막점 클릭 시 완성) |
| **UI-2.2** | **1st Veranda Line (1차 베란다)** | 캔버스 상단 | 100% 커버리지 점수(모수)가 부여되는 주요 베란다 창호 타겟 선 분할 지정 |
| **UI-2.3** | **2nd Veranda Line (2차 베란다)** | 캔버스 상단 | 70% 가중치 가점이 부여되는 측면/긴 벽면 베란다 창호 타겟 선 분할 지정 |
| **UI-2.4** | **Ruler Scale Calibration (축척 보정)** | 캔버스 상단 | 알려진 임의의 거리를 캔버스 상에 선으로 그려 Pixels/Meter 스케일을 직관적으로 보정 |
| **UI-2.5** | **Place Manual Site (수동 장비 배치)** | 캔버스 상단 | 건물 외곽선 또는 임의 위치에 3분기(3-Sector) Co-location 수동 장비 세트를 한 번에 배치 |
| **UI-2.6** | **Eraser Tool (지우개 도구)** | 캔버스 상단 | 캔버스 상의 건물, 베란다 선, Auto/Manual Sector 장비를 클릭하여 개별 삭제 |
| **UI-2.7** | **Undo / Redo (실행 취소/다시 실행)** | 캔버스 상단 | 건물, 베란다, 장비 노드의 추가/삭제/이동 이력을 이전/이후 단계로 복원 (최대 50단계) |
| **UI-2.8** | **2D / 3D Canvas Switcher** | 캔버스 우상단 | 평면 2D 캔버스 뷰와 3D 입체 렌더링 뷰간 실시간 시각화 전환 |

---

## 3. ⚙️ 우측 사이드바 설정 패널 (Sidebar Panel)

### 3.1. Simulation Parameters (시뮬레이션 기본 파라미터)
| UI Index | UI 메뉴 명칭 | 기능 및 역할 |
| :--- | :--- | :--- |
| **UI-3.1.1** | **Beam Width (빔폭 설정)** | 기본 **65°** (안테나 3dB 반전력 빔폭 지정) |
| **UI-3.1.2** | **Max Range (최대 반경)** | 안테나 신호 최대 도달 거리 지정 (기본 150m) |
| **UI-3.1.3** | **Target Coverage (목표 커버리지)** | 시뮬레이션 자동 탐색 중단 목표 달성률(%) 설정 |
| **UI-3.1.4** | **Pixels per Meter (스케일 값)** | 1미터당 픽셀 해상도 수동/자동 입력 |
| **UI-3.1.5** | **Strict Co-Location Checkbox** | 동일 위치 Sector 간 최소 60° 이격 (최대 5° 중첩) 엄격 체크 설정 |

### 3.2. VWorld API Key & Proxy Options
| UI Index | UI 메뉴 명칭 | 기능 및 역할 |
| :--- | :--- | :--- |
| **UI-3.2.1** | **API Key & Domain Input** | 브이월드 인증 키 및 등록 도메인 관리 (로컬스토리지 자동 저장) |
| **UI-3.2.2** | **Proxy / Direct Mode Select** | CORS 및 IP 제약 회피를 위한 Direct JSONP 또는 Proxy 서버 호출 방식 선택 |

### 3.3. Simulation Mode Selection (분석 모드 선택)
| UI Index | UI 메뉴 명칭 | 기능 및 역할 |
| :--- | :--- | :--- |
| **UI-3.3.1** | **1. Pure Manual Mode** | 순수 수동 배치 노드만으로 커버리지 및 빔 개별 도달 평가 |
| **UI-3.3.2** | **2. Manual + 2nd Veranda Sectors** | 수동 배치 노드 기반 + 수동 Site 위치에 2차 베란다 보완 Sector만 자동 추가 |
| **UI-3.3.3** | **3. Full Auto Optimization** | 수동 노드 유지 + 신규 Auto Site 위치 탐색 + 2차 베란다 보완 Sector 풀 자동 최적화 |

### 3.4. Equipment Sectors (Auto & Manual 노드 관리)
| UI Index | UI 메뉴 명칭 | 기능 및 역할 |
| :--- | :--- | :--- |
| **UI-3.4.1** | **Sector Node List** | 배치/생성된 **모든 Auto & Manual Sector 목록** 한눈에 출력 |
| **UI-3.4.2** | **Type Badge ([Manual] / [Auto])** | 섹터가 수동 배치된 것인지, 자동 알고리즘으로 생성된 것인지 뱃지 표기 |
| **UI-3.4.3** | **Angle Slider (각도 조절기)** | 개별 Sector 방사 각도(0°~359°) 실시간 조절 슬라이더 |
| **UI-3.4.4** | **Remove Button (개별 삭제)** | 목록에서 지정한 특정 Auto/Manual Sector 장비를 개별 삭제 |

---

## 4. 🚀 시뮬레이션 실행 및 Progress UI (Execution & Progress)

| UI Index | UI 메뉴 명칭 | 기능 및 역할 |
| :--- | :--- | :--- |
| **UI-4.1** | **Run Simulation Button** | 선택된 모드에 따라 커버리지 시뮬레이션 분석 실행 |
| **UI-4.2** | **Inline Progress Bar** | 사이드바 실행 버튼 하단에 실시간 진행도(%) 및 상태 텍스트 출력 |
| **UI-4.3** | **Glassmorphic Modal Progress** | 화면 중앙에 세련된 엠버 Glow 모달이 팝업되며 4단계 진행 현황 시각화<br>(`1. LOS 투과` ➔ `2. 섹터 탐색` ➔ `3. 2차 베란다` ➔ `4. 최적 매칭`) |

---

## 5. 📊 시뮬레이션 결과 리포트 패널 (Simulation Results & Analytics)

| UI Index | UI 메뉴 명칭 | 위치 | 주요 기능 및 역할 |
| :--- | :--- | :--- | :--- |
| **UI-5.1** | **Rank Selector Dropdown** | 결과 상단 | 풀 오토 시뮬레이션 결과 **Top 5 후보안(Rank 1~5)** 선택 전환 |
| **UI-5.2** | **Total Coverage Summary** | 결과 상단 | 1차 베란다 달성률(%) 및 2차 베란다 보너스 달성 미터 요약 카드 |
| **UI-5.3** | **Building Breakdown List** | 결과 중앙 | 건물(동)별 세부 커버리지 달성률 및 미터 카운터 프로그레스 바 |
| **UI-5.4** | **Execution Log Console** | 결과 하단 | 사이트 탐색 및 알고리즘 적용 이력 타임스탬프 로그 콘솔 |
| **UI-5.5** | **Download Report (ZIP Export)** | 결과 하단 | 텍스트 리포트, GeoJSON, 지도 캡처 이미지 등이 포함된 종합 ZIP 파일 다운로드 |

---

## 6. 💡 AI 인사이트 및 모달 팝업 (AI Insights & Overlays)

| UI Index | UI 메뉴 명칭 | 위치 | 주요 기능 및 역할 |
| :--- | :--- | :--- | :--- |
| **UI-6.1** | **AI Insights Floating Button** | 우하단 플로팅 | Gemini LLM 기반 시뮬레이션 데이터 전문 RF 해석 및 음영 지역 보완 제언 패널 토글 |
| **UI-6.2** | **VWorld Candidate Select Modal** | 화면 중앙 팝업 | 아파트 검색 시 해당 단지 내 개별 동(Building) 선택 및 자동 폴리곤 매핑 다이얼로그 |
| **UI-6.3** | **App Notification Banner** | 좌하단 | 경고, 오류, 성공, 안내 메시지 슬라이드 아웃 알림 토스트 바 |
