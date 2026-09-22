# [TODO-07] 따라하기 (튜토리얼) 인터랙티브 가이드 투어 — 구현 작업 지시서

> **작성일**: 2026-08-23  
> **상태**: ✅ 전체 완료 (Completed)  
> **목적**: 이 문서를 읽고 AI가 독립적으로 구현 및 유지보수할 수 있는 **완전자족형 작업 지시서**입니다.  
> **코드 수정 완료 후**: `npm run build`로 빌드 에러 없음을 반드시 확인할 것.

---

## 1. 목표 요약

처음 사용자 및 시연 목적으로, 주요 기능을 **순차적으로 하이라이트하며 직관적인 스크린샷과 함께 안내**하는 **💡 "따라하기 (튜토리얼)"** Step-by-Step 오버레이 가이드 투어를 구현한다.

**핵심 체감**: 단순 텍스트 헬프가 아닌, 실제 화면 스포트라이트와 고해상도 캡처 이미지, 와이드 점보 뷰(960px)를 지원하는 프리미엄 인터랙티브 튜토리얼.

---

## 2. 기술 스택 & 제약사항

| 항목 | 내용 |
|---|---|
| 프레임워크 | React 19 + TypeScript (Vite) |
| 애니메이션 | `motion` 라이브러리 (이미 설치됨, `import { motion, AnimatePresence } from 'motion/react'`) |
| 아이콘 | `lucide-react` (이미 설치됨) |
| CSS | Tailwind CSS v4 + 커스텀 CSS Variables (다크 테마) |
| **외부 라이브러리 추가 금지** | 자체 `createPortal` 및 Glassmorphism UI 컴포넌트로 구현. |
| 메인 코드 | `src/App.tsx`, `src/components/GuideTour.tsx`, `src/components/DashboardView.tsx` |

### 기존 디자인 토큰 (반드시 통일할 것)

```css
--accent: #00E5FF;           /* Electric Cyan */
--accent-soft: rgba(0,229,255,0.15);
--bg-main: #0a0d12;
--bg-accent: #14171c;
--canvas-glass: rgba(20,23,28,0.75);
--border-color: rgba(255,255,255,0.08);
```

---

## 3. 파일 구성

### `src/components/GuideTour.tsx`
메인 가이드 투어 컴포넌트 (스포트라이트, 2개 튜토리얼 메뉴, 캡처 이미지 렌더링, 960px 와이드 점보 뷰 지원).

### `src/App.tsx`
- 좌측 레일 최하단에 `💡 가이드` 버튼 및 2개 메뉴 팝오버 탑재
- 주요 UI 요소에 `data-tour` 속성 부여 및 플라이아웃 패널/결과 드로어 동기화

### `src/index.css`
가이드 관련 CSS 애니메이션 (`tour-spotlight-pulse` 등)

---

## 4. 가이드 트리거 UI — 레일 하단 `💡 가이드` 버튼

### 투어 선택 팝오버 (가이드 버튼 클릭 시)
`createPortal`로 `document.body`에 마운트하되, 가이드 버튼 기준으로 우측에 위치시킨다.

```
╭──────────────────────────────────────────────────╮
│ 💡 따라하기 (튜토리얼)                           │
│ ───────────────────────────────────────────────  │
│ 🚀 1. Work Flow (이렇게 쓰세요!)          8 steps│
│ 📊 2. 전체 리스트 기능 (배치 & 대시보드)   7 steps│
╰──────────────────────────────────────────────────╯
```

### 위치
`src/App.tsx`의 아이콘 레일 (`<div className="icon-rail">`) 내부, 설정 버튼 아래에 추가한다.

```
icon-rail
├── rail-logo (RadioTower)
├── rail-buttons (상단 그룹)
│   ├── 위치 (Search)
│   ├── 모델입력 (Sparkles)  
│   └── 결과 (Terminal)
├── rail-spacer
├── rail-buttons (하단 그룹)
│   ├── 도구 (Square)
│   └── 설정 (Filter)
└── ★ [추가] rail-buttons (가이드 그룹)   ← 여기
    └── ❓ 가이드 (HelpCircle 아이콘, lucide-react)
```

### 구현 상세
- `<HelpCircle>` 아이콘 (lucide-react에서 import)
- `rail-btn` 클래스 재사용
- 라벨: `가이드`
- 클릭 시: 투어 선택 팝업(팝오버) 표시

### 투어 선택 팝오버 (가이드 버튼 클릭 시)
`createPortal`로 `document.body`에 마운트하되, 가이드 버튼의 `getBoundingClientRect()` 기준으로 우측에 위치시킨다.

```
╭────────────────────────────╮
│ 🤖 J.A.R.V.I.S. 가이드    │  ← 시안(#00E5FF) 글로우 테두리
│ ─────────────────────────  │
│ ▶ 수동 분석 체험     7step │  → guideTourId = 'manual'
│ ▶ 전체 리스트 & 배치 5step │  → guideTourId = 'dashboard'
│ ▶ 지도에서보기 연동  3step │  → guideTourId = 'mapview'
╰────────────────────────────╯
```

- 글래스모피즘 스타일: `backdrop-filter: blur(16px)`, `bg-zinc-950/90`, `border border-[var(--accent)]/40`
- `AnimatePresence` + `motion.div`로 페이드인/스케일 애니메이션
- 팝오버 바깥 클릭 시 닫힘

---

## 5. `data-tour` 속성 부여 (App.tsx 수정)

가이드가 스포트라이트로 하이라이트할 대상 요소들에 `data-tour="키"` 속성을 추가한다.

| data-tour 값 | 대상 요소 | App.tsx 위치 (대략) |
|---|---|---|
| `"tab-map"` | 상단바 `지도` 탭 버튼 | L3358 |
| `"tab-list"` | 상단바 `전체 리스트` 탭 버튼 | L3359 |
| `"rail-location"` | 좌측 레일 `위치` 버튼 | L2783~L2789 |
| `"rail-model"` | 좌측 레일 `모델입력` 버튼 | L2790~L2796 |
| `"rail-result"` | 좌측 레일 `결과` 버튼 | L2797~L2805 |
| `"panel-location"` | 위치 플라이아웃 패널 전체 | L2830 |
| `"floating-dock"` | 맵 우측 하단 분석실행 플로팅 독 | L3872~L3873 |
| `"canvas-area"` | 지도 캔버스 영역 | L3667 |
| `"results-drawer"` | 우측 결과 드로어 패널 | L4140 |
| `"dashboard-table"` | 전체 리스트 DashboardView 영역 | L3659 |

**방법**: 해당 요소의 JSX에 `data-tour="키"` 속성만 추가. 기존 코드 로직 변경 금지.

예시:
```tsx
// 변경 전
<button className={`shell-view-tab ${mainView === 'map' ? 'active' : ''}`} onClick={() => setMainView('map')}>지도</button>

// 변경 후
<button data-tour="tab-map" className={`shell-view-tab ${mainView === 'map' ? 'active' : ''}`} onClick={() => setMainView('map')}>지도</button>
```

---

## 6. GuideTour.tsx — 핵심 컴포넌트 구현 사양

### 6.1 Props 인터페이스

```typescript
interface GuideTourProps {
  tourId: 'manual' | 'dashboard' | 'mapview';
  onClose: () => void;
  // App 상태 제어 콜백
  setActivePanel: (panel: 'location' | 'model' | 'tools' | 'settings' | null) => void;
  setMainView: (view: 'map' | 'list') => void;
  setDrawerOpen: (open: boolean) => void;
}
```

### 6.2 Step 정의 타입

```typescript
interface TourStep {
  target: string;         // data-tour 속성 값 (querySelector `[data-tour="xxx"]`)
  title: string;          // 말풍선 제목 (짧고 굵게)
  message: string;        // 자비스 메시지 (한국어, 2~3줄)
  position?: 'top' | 'bottom' | 'left' | 'right' | 'auto'; // 말풍선 위치 (기본: auto)
  onEnter?: () => void;   // 이 스텝 진입 시 자동 실행 (패널 열기 등)
}
```

### 6.3 투어별 Step 데이터 (2개 메뉴 구성)

> **설계 원칙 (5단계 가이드라인 반영)**:
> 1. **Welcome Screen (가치 제안 & 목적 명시)**: 투어 시작 시 시스템의 추진 목적과 과거 개통 국소 현장 검증 완료 배경을 정중히 설명.
> 2. **Step-by-Step 가이드**: 스포트라이트와 2줄 내외의 직관적인 메시지로 핵심 조작 안내.
> 3. **Closing (격려 & 당부)**: 투어 완료 시 수고에 대한 격려와 업무 활용 당부 메시지 전달.

#### 메뉴 1: `workflow` — Work Flow (이렇게 쓰세요!) (총 8 steps)

```typescript
const WORKFLOW_TOUR: TourStep[] = [
  {
    target: 'center',
    title: 'Access Eng LOS Simulator',
    badge: '추진 목적 & 가치 제안',
    message: 'Access Eng 설계 표준화/자동화 추진으로 최적 설계의 핵심 조건은 O2I(실외→실내)가 가장 잘되는 Best LOS를 찾는 것입니다.\n\n그동안 구성원 개별 암묵지로 존재하던 설계 노하우를 정밀 LOS 엔진으로 시스템화하였으며, 과거 개통 국소 현장 확인을 통해 시뮬레이션 검증을 완료했습니다.',
    position: 'center',
    onEnter: () => { props.setMainView('map'); }
  },
  {
    target: 'topbar-target',
    title: '(1) 대상 선택 (RAPA Key / 필터)',
    badge: '1단계 · 대상 조회',
    message: '상단의 본부 · 시도 · 읍면동 필터나 RAPA Key 검색창을 통해 분석 대상 아파트 단지를 손쉽게 선택합니다.\nRAPA Key 입력 시 단지 GIS 데이터가 즉시 로드됩니다.',
    position: 'bottom',
    onEnter: () => { props.setMainView('map'); }
  },
  {
    target: 'canvas-area',
    title: '(2) 지도에서 폴리곤 확인',
    badge: '2단계 · 레이아웃 확인',
    message: '선택한 단지의 아파트 건물 폴리곤(회색)과 단지 배치가 3D 맵 상에 정밀하게 표시됩니다.\n마우스 드래그로 화면 이동, Ctrl+휠로 자유롭게 확대/축소하세요.',
    position: 'top',
    onEnter: () => { props.setActivePanel(null); }
  },
  {
    target: 'veranda-overlay',
    title: '(3) 베란다 설정 & 총 거리 산출',
    badge: '3단계 · 베란다 검토',
    message: '1차(파란선) 및 2차(녹색선) 베란다 구간을 실시간으로 확인합니다.\n건물 외벽에 맞춰 AI가 베란다를 자동 추출하며, 좌상단 카드에서 총 베란다 길이를 확인할 수 있습니다.',
    position: 'bottom'
  },
  {
    target: 'rail-tools',
    title: '(4) 도구 및 설정 소개',
    badge: '4단계 · 편집 & 파라미터',
    message: '좌측 레일의 [도구] 메뉴로 건물/베란다를 직접 편집하거나, [설정] 메뉴에서 안테나 빔폭(65°), 차폐 임계값, 타겟 커버리지(90%) 등 RF 최적화 파라미터를 조정할 수 있습니다.',
    position: 'right',
    onEnter: () => { props.setActivePanel('tools'); }
  },
  {
    target: 'floating-dock',
    title: '(5) 분석 실행 (3가지 모드)',
    badge: '5단계 · 시뮬레이션',
    message: '우측 하단의 플로팅 컨트롤러에서 상황에 맞는 분석 모드를 원클릭으로 실행합니다:\n• 수동 (M1): 직접 배치한 Sector 분석\n• 수동+tunning (M2): 2차 베란다 튜닝\n• Auto (M3): AI 최적화 자동 배치',
    position: 'top',
    onEnter: () => { props.setActivePanel(null); }
  },
  {
    target: 'results-drawer',
    title: '(6) 맵 결과 확인 & 저장',
    badge: '6단계 · 결과 & 저장',
    message: '동별 커버리지 현황, 사이트별 위경도 좌표(WGS84) 및 확보 거리 요약을 확인합니다.\n하단의 [전체 리스트에 저장] 버튼을 누르면 분석 결과가 대시보드에 즉시 반영됩니다.',
    position: 'left',
    onEnter: () => { props.setDrawerOpen(true); }
  },
  {
    target: 'center',
    title: '🎉 수고하셨습니다!',
    badge: '워크플로우 완료',
    message: 'Work Flow(이렇게 쓰세요!) 따라하기가 완료되었습니다! 수고하셨습니다! 👏\n\n이제 실제 Access 망 최적설계 및 현장 분석 업무에 유용하게 잘 활용해 주시길 바랍니다.',
    position: 'center'
  }
];
```

#### 메뉴 2: `dashboard` — 전체 리스트 기능 (배치 & 대시보드) (총 5 steps)

```typescript
const DASHBOARD_TOUR: TourStep[] = [
  {
    target: 'center',
    title: '전체 리스트 기능 소개',
    badge: '대시보드 & 배치 관리',
    message: '다수 아파트 단지의 LOS 분석 결과를 한눈에 파악하고,\n대량 배치(Batch) 시뮬레이션을 실행하는 대시보드 기능입니다.',
    position: 'center',
    onEnter: () => { props.setMainView('list'); }
  },
  {
    target: 'dashboard-summary',
    title: '(7) 전체 리스트 소개 (Dashboard)',
    badge: '1단계 · 통합 지표',
    message: '전체 대상 단지 수, 완료(OK) · 경고(WARN) · 실패(NOK) 현황, 평균 커버리지, 총 Site/Sector 수가 상단 카드에 실시간 집계됩니다.\n단지별 진행 상황을 종합적으로 모니터링할 수 있습니다.',
    position: 'bottom',
    onEnter: () => { props.setMainView('list'); }
  },
  {
    target: 'dashboard-table-content',
    title: '(8) 대상 선택 → [지도에서 보기]',
    badge: '2단계 · 지도 연동 복원',
    message: '단지 목록 행을 클릭하여 상세 커버리지와 미니맵을 확인하고, [지도에서 열기]를 클릭하면 설계된 Site/Sector가 복원된 상태로 지도 뷰로 즉시 전환되어 연속 작업이 가능합니다.',
    position: 'top'
  },
  {
    target: 'dashboard-batch-actions',
    title: '(9) 배치(Batch) 대량 실행 기능',
    badge: '3단계 · 대량 일괄 분석',
    message: '체크박스로 여러 단지를 다중 선택한 후, [선택 단지 시뮬레이션] 버튼을 눌러 백그라운드 대량 일괄 분석을 실행합니다.\n실패/경고 단지만 선별하여 원클릭 재시도할 수도 있습니다.',
    position: 'bottom'
  },
  {
    target: 'center',
    title: '🎉 수고하셨습니다!',
    badge: '튜토리얼 완료',
    message: '전체 리스트 기능 가이드가 완료되었습니다! 수고하셨습니다! 👏\n\n대량 분석과 개별 최적설계를 유기적으로 연계하여 설계 업무 효율을 극대화해 보세요.',
    position: 'center'
  }
];
```

### 6.4 스포트라이트 오버레이 렌더링

**방식**: `position: fixed` full-screen `<div>` + CSS `box-shadow` 컷아웃

```tsx
// 대상 요소의 getBoundingClientRect() 결과
const rect = targetEl.getBoundingClientRect();
const PADDING = 8;  // 스포트라이트 여백

// 1) 풀스크린 오버레이
<div style={{
  position: 'fixed',
  inset: 0,
  zIndex: 99998,
  pointerEvents: 'none'
}}>
  {/* 스포트라이트 컷아웃 — 대상 영역만 밝게, 나머지 딤 */}
  <div style={{
    position: 'absolute',
    top: rect.top - PADDING,
    left: rect.left - PADDING,
    width: rect.width + PADDING * 2,
    height: rect.height + PADDING * 2,
    borderRadius: 12,
    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.75)',
    border: '2px solid var(--accent)',
    pointerEvents: 'none',
    // ★ 네온 펄스 애니메이션
    animation: 'tour-spotlight-pulse 2s ease-in-out infinite',
  }} />
</div>

// 2) 스포트라이트 바깥 클릭 영역 (건너뛰기 or 진행 용도)
<div style={{
  position: 'fixed',
  inset: 0,
  zIndex: 99997,
  cursor: 'pointer'
}} onClick={handleNext} />
```

**스텝 전환 시**: `motion.div`로 스포트라이트 위치/크기를 `animate`로 트랜지션한다. `layout` prop 사용 또는 직접 `style`에 `transition: all 0.4s ease-out`.

### 6.5 글래스모피즘 말풍선 카드

```tsx
<motion.div
  initial={{ opacity: 0, y: 10, scale: 0.95 }}
  animate={{ opacity: 1, y: 0, scale: 1 }}
  exit={{ opacity: 0, y: 10, scale: 0.95 }}
  transition={{ duration: 0.3, ease: 'easeOut' }}
  style={{
    position: 'fixed',
    zIndex: 99999,
    // 위치는 target rect + position에 따라 동적 계산
    top: bubbleTop,
    left: bubbleLeft,
    maxWidth: 340,
    minWidth: 280,
  }}
  className="rounded-2xl border border-[var(--accent)]/30 shadow-[0_8px_32px_rgba(0,0,0,0.6),0_0_20px_var(--accent-soft)]"
>
  {/* 카드 내부 */}
  <div style={{
    background: 'rgba(10, 13, 18, 0.92)',
    backdropFilter: 'blur(16px)',
    borderRadius: 16,
    overflow: 'hidden',
  }}>
    {/* 헤더 */}
    <div className="px-4 pt-3 pb-2 flex items-center gap-2 border-b border-zinc-800/60">
      <span className="text-base">🤖</span>
      <span className="text-sm font-black tracking-wider" style={{ color: 'var(--accent)' }}>
        J.A.R.V.I.S.
      </span>
      <span className="ml-auto text-[10px] font-mono text-zinc-500">
        {currentStep + 1} / {totalSteps}
      </span>
    </div>

    {/* 메시지 본문 */}
    <div className="px-4 py-3">
      <div className="text-[11px] font-bold text-zinc-200 mb-1.5">{step.title}</div>
      <div className="text-[12px] text-zinc-300 leading-relaxed whitespace-pre-line">
        {step.message}
      </div>
    </div>

    {/* 하단 네비게이션 */}
    <div className="px-4 py-2.5 bg-zinc-900/50 border-t border-zinc-800/60 flex items-center justify-between">
      <div className="flex items-center gap-2">
        {currentStep > 0 && (
          <button onClick={handlePrev}
            className="text-[11px] text-zinc-400 hover:text-zinc-200 font-medium cursor-pointer">
            ◀ 이전
          </button>
        )}
      </div>

      {/* 도트 인디케이터 */}
      <div className="flex gap-1">
        {Array.from({ length: totalSteps }).map((_, i) => (
          <span key={i} className={`w-1.5 h-1.5 rounded-full transition-colors ${
            i === currentStep ? 'bg-[var(--accent)]' : 'bg-zinc-600'
          }`} />
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={onClose}
          className="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer">
          건너뛰기
        </button>
        <button onClick={handleNext}
          className="text-[11px] font-bold px-3 py-1 rounded-lg cursor-pointer transition-colors"
          style={{
            background: 'var(--accent)',
            color: '#0a0d12',
          }}>
          {isLastStep ? '완료' : '다음 ▶'}
        </button>
      </div>
    </div>
  </div>
</motion.div>
```

### 6.6 말풍선 위치 자동 계산 로직

```typescript
function computeBubblePosition(
  rect: DOMRect,
  position: 'top' | 'bottom' | 'left' | 'right' | 'auto',
  bubbleWidth: number,
  bubbleHeight: number
): { top: number; left: number } {
  const MARGIN = 16; // 스포트라이트와 말풍선 사이 간격
  const PAD = 8;     // 스포트라이트 패딩
  
  let pos = position;
  if (pos === 'auto') {
    // 화면 중앙 기준으로 비교하여 공간이 넓은 쪽 선택
    const spaceBelow = window.innerHeight - (rect.bottom + PAD);
    const spaceAbove = rect.top - PAD;
    const spaceRight = window.innerWidth - (rect.right + PAD);
    const spaceLeft = rect.left - PAD;
    
    const maxV = Math.max(spaceBelow, spaceAbove);
    const maxH = Math.max(spaceRight, spaceLeft);
    
    if (maxV >= maxH) {
      pos = spaceBelow >= spaceAbove ? 'bottom' : 'top';
    } else {
      pos = spaceRight >= spaceLeft ? 'right' : 'left';
    }
  }

  switch (pos) {
    case 'bottom':
      return {
        top: rect.bottom + PAD + MARGIN,
        left: Math.max(16, Math.min(rect.left + rect.width / 2 - bubbleWidth / 2, window.innerWidth - bubbleWidth - 16))
      };
    case 'top':
      return {
        top: rect.top - PAD - MARGIN - bubbleHeight,
        left: Math.max(16, Math.min(rect.left + rect.width / 2 - bubbleWidth / 2, window.innerWidth - bubbleWidth - 16))
      };
    case 'right':
      return {
        top: Math.max(16, rect.top + rect.height / 2 - bubbleHeight / 2),
        left: rect.right + PAD + MARGIN
      };
    case 'left':
      return {
        top: Math.max(16, rect.top + rect.height / 2 - bubbleHeight / 2),
        left: rect.left - PAD - MARGIN - bubbleWidth
      };
  }
}
```

### 6.7 키보드 네비게이션

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') handleNext();
    if (e.key === 'ArrowLeft') handlePrev();
    if (e.key === 'Escape') onClose();
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [currentStep]);
```

### 6.8 대상 요소 없을 때 처리

`document.querySelector(`[data-tour="${step.target}"]`)`가 `null`이면 해당 스텝을 자동으로 건너뛴다 (다음 스텝으로 진행).

### 6.9 Window resize / scroll 대응

`useEffect`에서 `resize` 이벤트를 감지하여 스포트라이트 rect를 재계산한다.

---

## 7. CSS 추가 (`src/index.css`)

아래 내용을 `src/index.css` 최하단에 추가:

```css
/* ====== J.A.R.V.I.S. Guide Tour ====== */
@keyframes tour-spotlight-pulse {
  0%, 100% {
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.75),
                0 0 12px var(--accent),
                0 0 24px rgba(0, 229, 255, 0.15);
  }
  50% {
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.75),
                0 0 20px var(--accent),
                0 0 40px rgba(0, 229, 255, 0.25);
  }
}
```

---

## 8. App.tsx 통합 — 수정 요약

### 8.1 Import 추가 (파일 상단)

```typescript
import { GuideTour } from './components/GuideTour';
// lucide-react import에 HelpCircle 추가
import { ..., HelpCircle } from 'lucide-react';
```

### 8.2 State 추가 (L153 부근, 기존 상태 선언부)

```typescript
const [guideTourId, setGuideTourId] = useState<'manual' | 'dashboard' | 'mapview' | null>(null);
const [showGuideMenu, setShowGuideMenu] = useState(false);
const guideButtonRef = useRef<HTMLButtonElement>(null);
```

### 8.3 레일에 가이드 버튼 추가 (L2823 `</div>` 닫힌 직후, `icon-rail` div 닫히기 직전)

```tsx
        {/* 가이드 버튼 */}
        <div className="rail-buttons" style={{ marginTop: 'auto', paddingBottom: 8 }}>
          <button
            ref={guideButtonRef}
            className={`rail-btn ${showGuideMenu ? 'active' : ''}`}
            onClick={() => setShowGuideMenu(!showGuideMenu)}
          >
            <HelpCircle className="w-5 h-5" strokeWidth={1.8} />
            <span>가이드</span>
          </button>
        </div>
```

### 8.4 가이드 선택 팝오버 (레일 가이드 버튼 옆에 표시)

`App.tsx` return 최하단, 모달들과 같은 레벨에 추가:

```tsx
      {/* 가이드 투어 선택 팝오버 */}
      <AnimatePresence>
        {showGuideMenu && guideButtonRef.current && (() => {
          const r = guideButtonRef.current!.getBoundingClientRect();
          return (
            <motion.div
              initial={{ opacity: 0, x: -10, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -10, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              style={{
                position: 'fixed',
                left: r.right + 12,
                bottom: window.innerHeight - r.bottom,
                zIndex: 99990,
              }}
              className="w-72 rounded-2xl border border-[var(--accent)]/30 shadow-[0_8px_32px_rgba(0,0,0,0.6),0_0_20px_var(--accent-soft)] overflow-hidden"
            >
              <div style={{ background: 'rgba(10,13,18,0.95)', backdropFilter: 'blur(16px)' }} className="rounded-2xl">
                <div className="px-4 pt-3 pb-2 flex items-center gap-2 border-b border-zinc-800/60">
                  <span className="text-base">🤖</span>
                  <span className="text-sm font-black tracking-wider" style={{ color: 'var(--accent)' }}>
                    J.A.R.V.I.S. 가이드
                  </span>
                </div>
                <div className="py-1.5">
                  {[
                    { id: 'manual' as const, label: '수동 분석 체험', desc: '7 steps · 주요 기능 전체 안내' },
                    { id: 'dashboard' as const, label: '전체 리스트 & 배치', desc: '5 steps · 대시보드 관리' },
                    { id: 'mapview' as const, label: '지도에서보기 연동', desc: '3 steps · 빠른 팁' },
                  ].map((tour) => (
                    <button
                      key={tour.id}
                      onClick={() => { setGuideTourId(tour.id); setShowGuideMenu(false); }}
                      className="w-full text-left px-4 py-2.5 hover:bg-zinc-800/60 transition-colors flex items-center justify-between group cursor-pointer"
                    >
                      <div>
                        <div className="text-[12px] font-bold text-zinc-200 group-hover:text-[var(--accent)] transition-colors">
                          ▶ {tour.label}
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">{tour.desc}</div>
                      </div>
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-600 -rotate-90 group-hover:text-[var(--accent)] transition-colors" />
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* 가이드 투어 오버레이 */}
      {guideTourId && (
        <GuideTour
          tourId={guideTourId}
          onClose={() => setGuideTourId(null)}
          setActivePanel={setActivePanel}
          setMainView={setMainView}
          setDrawerOpen={setDrawerOpen}
        />
      )}
```

### 8.5 팝오버 바깥 클릭 닫기

기존 패턴과 동일하게 `useEffect`에서 클릭 바깥 감지:

```typescript
useEffect(() => {
  if (!showGuideMenu) return;
  const handler = (e: MouseEvent) => {
    if (guideButtonRef.current && !guideButtonRef.current.contains(e.target as Node)) {
      setShowGuideMenu(false);
    }
  };
  document.addEventListener('mousedown', handler);
  return () => document.removeEventListener('mousedown', handler);
}, [showGuideMenu]);
```

---

## 9. 구현 시 주의사항

1. **기존 코드 로직 변경 금지**: `data-tour` 속성 부여와 state/import 추가만 한다. 기존 이벤트 핸들러, 스타일, 컴포넌트 구조를 변경하지 않는다.
2. **TypeScript 엄격 모드**: `any` 타입 사용 최소화. 모든 props와 state에 적절한 타입을 지정한다.
3. **z-index 관리**: 가이드 오버레이 `z-index: 99997~99999`. 기존 모달(z-50 등)보다 반드시 위에 렌더링.
4. **createPortal 사용**: GuideTour 컴포넌트의 오버레이 및 말풍선은 `createPortal(jsx, document.body)`로 렌더링하여 DOM 중첩/오버플로우 이슈를 방지한다.
5. **motion 라이브러리**: `import { motion, AnimatePresence } from 'motion/react'` (framer-motion이 아닌 `motion/react`).
6. **투어 종료 시 정리**: `onClose` 호출 시 모든 오버레이를 즉시 해제하고, 키보드 이벤트 리스너를 정리한다.
7. **빌드 검증**: 구현 완료 후 `npm run build`로 에러 없음을 확인한다.

---

## 10. 검증 체크리스트

- [ ] `npm run build` — TypeScript 에러 0건
- [ ] 좌측 레일 최하단에 `❓ 가이드` 버튼 표시됨
- [ ] 가이드 버튼 클릭 → 투어 선택 팝오버 표시
- [ ] 팝오버 바깥 클릭 → 팝오버 닫힘
- [ ] "수동 분석 체험" 선택 → 7스텝 가이드 시작
- [ ] 스포트라이트가 대상 요소를 정확히 하이라이트
- [ ] 글래스 말풍선이 대상 요소 옆에 적절히 위치
- [ ] 다음/이전 버튼, 키보드 화살표 정상 동작
- [ ] 건너뛰기 → 가이드 즉시 종료
- [ ] 마지막 스텝 완료 → 가이드 자동 종료
- [ ] 대상 요소가 화면에 없을 때 → 해당 스텝 자동 건너뜀

---

## 11. 디자인 참고 이미지

목업 이미지 위치 (Finder에서 열어볼 수 있음):
- `docs/00-pm/mockups/01_spotlight_location.jpg` — 위치 버튼 스포트라이트
- `docs/00-pm/mockups/02_spotlight_analysis.jpg` — 분석실행 독 스포트라이트
- `docs/00-pm/mockups/03_help_menu.jpg` — 가이드 선택 메뉴
