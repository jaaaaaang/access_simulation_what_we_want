import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Sparkles, ChevronRight, ChevronLeft, X, CheckCircle2, Image as ImageIcon, Maximize2 } from 'lucide-react';

export interface TourStep {
  target: string; // data-tour 속성값, 또는 'center' (화면 중앙 모달)
  title: string;
  badge?: string;
  message: string;
  image?: string; // 캡처/설명 이미지 URL
  imageCaption?: string; // 이미지 하단 캡션
  imageSize?: 'normal' | 'large' | 'jumbo'; // jumbo: 최대 와이드 초대형 렌더링
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'auto';
  onEnter?: () => void;
}

interface GuideTourProps {
  tourId: 'workflow' | 'dashboard';
  onClose: () => void;
  setActivePanel: (panel: 'location' | 'model' | 'tools' | 'settings' | null) => void;
  setMainView: (view: 'map' | 'list') => void;
  setDrawerOpen: (open: boolean) => void;
}

export const GuideTour: React.FC<GuideTourProps> = ({
  tourId,
  onClose,
  setActivePanel,
  setMainView,
  setDrawerOpen,
}) => {
  const getTourSteps = (): TourStep[] => {
    switch (tourId) {
      case 'workflow':
        return [
          {
            target: 'center',
            title: 'Access Eng LOS Simulator',
            badge: '추진 목적 & 가치 제안',
            message:
              'Access Eng 설계 표준화/자동화 추진으로 최적 설계의 핵심 조건은 O2I(실외→실내)가 가장 잘되는 Best LOS를 찾는 것입니다.\n\n그동안 구성원 개별 암묵지로 존재하던 설계 노하우를 정밀 LOS 엔진으로 시스템화하였으며, 과거 개통 국소 현장 확인을 통해 시뮬레이션 검증을 완료했습니다.',
            position: 'center',
            onEnter: () => {
              setMainView('map');
            },
          },
          {
            target: 'topbar-target',
            title: '(1) 대상 선택 (RAPA Key / 필터)',
            badge: '1단계 · 대상 조회',
            message:
              '상단의 본부 · 시도 · 읍면동 필터나 RAPA Key 검색창을 통해 분석 대상 아파트 단지를 손쉽게 선택합니다.\nRAPA Key 입력 시 단지 GIS 데이터가 즉시 로드됩니다.',
            position: 'bottom',
            onEnter: () => {
              setMainView('map');
            },
          },
          {
            target: 'canvas-area',
            title: '(2) 지도에서 폴리곤 확인',
            badge: '2단계 · 레이아웃 확인',
            message:
              '선택한 단지의 아파트 건물 폴리곤(회색)과 단지 배치가 지도 상에 정밀하게 표시됩니다.\n마우스 드래그로 화면 이동, Ctrl+휠로 자유롭게 확대/축소하여 레이아웃을 확인하세요.',
            image: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/guide/map_polygon_sample.png`,
            imageCaption: '▲ 아파트 단지 건물 폴리곤 및 배치 지도 뷰 예시',
            position: 'top',
            onEnter: () => {
              setActivePanel(null);
            },
          },
          {
            target: 'btn-ai-veranda',
            title: '(3) AI 베란다 세팅 & 총 거리 산출',
            badge: '3단계 · 핵심 AI 기능',
            message:
              '상단의 [✨ AI 베란다 세팅] 버튼을 누르면 AI가 건물 외벽을 자동 분석하여 최적 베란다를 추출합니다:\n• 1차 베란다 (파란 실선): 거실 전면부 (100% 점수)\n• 2차 베란다 (녹색/점선): 배면 긴 벽면 (70% 점수 가산)\n• 좌상단 카드에서 1차/2차 베란다 총 연장 길이(m)가 실시간으로 집계됩니다.',
            image: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/guide/ai_veranda_setting_sample.png`,
            imageCaption: '▲ [AI 베란다 세팅] 버튼 및 건물별 1차/2차 베란다 추출 & 총 길이 카드',
            position: 'bottom',
          },
          {
            target: 'step-panel',
            title: '(4) 도구(Tools) 및 설정 메뉴',
            badge: '4단계 · 편집 & 파라미터',
            message:
              '좌측 패널에서 그리기 도구 및 세부 설정을 조작합니다:\n• 그리기/수정: 건물(Building), 1st/2nd 베란다, 지우개(Eraser), 수동 기지국 배치\n• 건물 폴리곤 교정(DB): 중첩·불량 폴리곤 정리 후 원본 DB 즉시 반영\n• [설정] 탭: 안테나 빔폭(65°), 차폐 임계값, 타겟 커버리지(90%) 조정',
            position: 'right',
            onEnter: () => {
              setActivePanel('tools');
            },
          },
          {
            target: 'floating-dock',
            title: '(5) 분석 실행 (3가지 모드)',
            badge: '5단계 · 시뮬레이션',
            message:
              '우측 하단의 플로팅 컨트롤러에서 상황에 맞는 분석 모드를 원클릭으로 실행합니다:\n• 수동 (M1): 직접 배치한 Sector 분석\n• 수동+tunning (M2): 2차 베란다 튜닝\n• Auto (M3): AI 최적화 자동 배치',
            position: 'top',
            onEnter: () => {
              setActivePanel(null);
            },
          },
          {
            target: 'results-drawer',
            title: '(6) 맵 결과 확인 & 저장',
            badge: '6단계 · 핵심 결과 & 저장',
            message:
              '시뮬레이션 완료 시 지도 상에 Sector별 빔 커버리지(노랑/하늘색)가 그려지고, 우측 드로어에 상세 지표가 요약됩니다:\n• 종합 베란다 커버리지(%) 및 2차 베란다 기여분(+m) 확인\n• 동별 커버리지 현황 (1차 커버/전체) 및 양호/보통/음영 판정\n• 사이트별 WGS84 위경도 좌표, 방위각, 확보 거리(m) 요약\n• 하단의 [전체 리스트에 저장] 버튼을 누르면 분석 결과가 대시보드에 즉시 반영됩니다.',
            image: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/guide/simulation_result_sample.png`,
            imageCaption: '▲ [핵심 결과 맵 뷰] 안테나 빔 도달 영역 및 우측 결과 드로어(종합 커버리지 / 동별 현황 / WGS84 좌표)',
            imageSize: 'jumbo',
            position: 'center',
            onEnter: () => {
              setDrawerOpen(true);
            },
          },
          {
            target: 'center',
            title: '🎉 수고하셨습니다!',
            badge: '워크플로우 완료',
            message:
              'Work Flow(이렇게 쓰세요!) 따라하기가 완료되었습니다! 수고하셨습니다! 👏\n\n이제 실제 Access 망 최적설계 및 현장 분석 업무에 유용하게 잘 활용해 주시길 바랍니다.',
            position: 'center',
          },
        ];

      case 'dashboard':
        return [
          {
            target: 'center',
            title: '전체 리스트 기능 소개',
            badge: '대시보드 & 배치 관리',
            message:
              '다수 아파트 단지의 LOS 분석 결과를 한눈에 파악하고,\n대량 배치(Batch) 시뮬레이션을 실행하는 대시보드 기능입니다.',
            position: 'center',
            onEnter: () => {
              setMainView('list');
            },
          },
          {
            target: 'dashboard-summary',
            title: '(7) 전체 리스트 소개 (Dashboard)',
            badge: '1단계 · 통합 지표',
            message:
              '전체 대상 단지 수, 완료(OK) · 경고(WARN) · 실패(NOK) 현황, 평균 커버리지, 총 Site/Sector 수가 상단 카드에 실시간 집계됩니다.\n단지별 진행 상황을 종합적으로 모니터링할 수 있습니다.',
            position: 'bottom',
            onEnter: () => {
              setMainView('list');
            },
          },
          {
            target: 'dashboard-table-content',
            title: '(8) 대상 선택 → [지도에서 보기]',
            badge: '2단계 · 지도 연동 복원',
            message:
              '단지 목록 행을 클릭하여 상세 커버리지와 미니맵을 확인하고, [지도에서 열기]를 클릭하면 설계된 Site/Sector가 복원된 상태로 지도 뷰로 즉시 전환되어 연속 작업이 가능합니다.',
            position: 'top',
          },
          {
            target: 'dashboard-batch-actions',
            title: '(9-1) 배치 대상 다중 선택 & 실행',
            badge: '3단계 · 단지 선택',
            message:
              '테이블 좌측의 체크박스를 클릭하여 일괄 분석할 단지들을 다중 선택합니다.\n우측 상단의 [선택 단지 시뮬레이션 (N)] 버튼을 누르면 설정 팝업이 표시됩니다.\n(실패/경고 단지만 모아서 재시도할 수도 있습니다.)',
            image: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/guide/batch_step1_select.png`,
            imageCaption: '▲ 단지 체크박스 다중 선택 ➔ [선택 단지 시뮬레이션] 버튼 클릭',
            position: 'bottom',
          },
          {
            target: 'center',
            title: '(9-2) 대량 배치 시뮬레이션 설정',
            badge: '4단계 · 설정 모달',
            message:
              '모달 창에서 선택된 단지 수와 예상 소요 시간이 계산되며, 세부 옵션을 설정합니다:\n• 기존 분석 건: [완료 건 건너뛰기] 또는 [강제 재분석]\n• 동시 실행 워커 수: 1~4개 프로세스 병렬 연산\n• 공통 RF 파라미터: 빔폭(65°), 도달거리(150m) 등 설정 후 [시뮬레이션 시작]을 누릅니다.',
            image: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/guide/batch_step2_modal.png`,
            imageCaption: '▲ 대량 배치 시뮬레이션 설정 모달 화면',
            position: 'center',
          },
          {
            target: 'center',
            title: '(9-3) 백그라운드 진행 & 실시간 모니터링',
            badge: '5단계 · 진행 상태 바',
            message:
              '배치가 시작되면 상단에 실시간 진행 상태 바가 나타납니다:\n• 현재 실행 중인 단지 RAPA Key 및 예상 잔여 시간 실시간 표시\n• 완료/실패 건수 자동 갱신 및 [배치 취소] 기능 제공\n• 연산이 완료되면 테이블에 커버리지 지표가 자동 반영됩니다.',
            image: `${import.meta.env.BASE_URL.replace(/\/$/, '')}/guide/batch_step3_running.png`,
            imageCaption: '▲ 백그라운드 배치 진행 바 및 실시간 모니터링 화면',
            position: 'center',
          },
          {
            target: 'center',
            title: '🎉 수고하셨습니다!',
            badge: '튜토리얼 완료',
            message:
              '전체 리스트 기능 가이드가 완료되었습니다! 수고하셨습니다! 👏\n\n대량 분석과 개별 최적설계를 유기적으로 연계하여 설계 업무 효율을 극대화해 보세요.',
            position: 'center',
          },
        ];
    }
  };

  const steps = getTourSteps();
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const currentStep = steps[currentStepIndex];
  const isJumbo = currentStep?.imageSize === 'jumbo';
  const isCenter = !currentStep || currentStep.target === 'center' || currentStep.position === 'center' || isJumbo;
  const hasImage = Boolean(currentStep?.image);
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === steps.length - 1;

  // 스텝 전환 시 onEnter 호출 및 target 요소 위치 계산
  useEffect(() => {
    if (!currentStep) return;

    if (currentStep.onEnter) {
      currentStep.onEnter();
    }

    const updateRect = () => {
      if (isCenter) {
        setTargetRect(null);
        return;
      }

      const el = document.querySelector(`[data-tour="${currentStep.target}"]`);
      if (el) {
        setTargetRect(el.getBoundingClientRect());
      } else {
        setTargetRect(null);
      }
    };

    const timer = setTimeout(updateRect, 120);
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [currentStepIndex, currentStep?.target, isCenter]);

  // 키보드 네비게이션
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (isLastStep) {
          onClose();
        } else {
          setCurrentStepIndex((prev) => Math.min(steps.length - 1, prev + 1));
        }
      } else if (e.key === 'ArrowLeft') {
        setCurrentStepIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentStepIndex, isLastStep, onClose, steps.length]);

  const handleNext = () => {
    if (isLastStep) {
      onClose();
    } else {
      setCurrentStepIndex((prev) => Math.min(steps.length - 1, prev + 1));
    }
  };

  const handlePrev = () => {
    setCurrentStepIndex((prev) => Math.max(0, prev - 1));
  };

  // 말풍선 위치 계산 함수
  const computeBubblePosition = () => {
    if (isCenter || !targetRect) {
      return {
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
      };
    }

    const MARGIN = 16;
    const PAD = 8;
    const bubbleWidth = isJumbo ? 940 : hasImage ? 740 : 540;
    const bubbleHeight = isJumbo ? 680 : hasImage ? 560 : 320;

    let pos = currentStep.position || 'auto';
    if (pos === 'auto') {
      const spaceBelow = window.innerHeight - (targetRect.bottom + PAD);
      const spaceAbove = targetRect.top - PAD;
      const spaceRight = window.innerWidth - (targetRect.right + PAD);
      const spaceLeft = targetRect.left - PAD;

      const maxV = Math.max(spaceBelow, spaceAbove);
      const maxH = Math.max(spaceRight, spaceLeft);

      if (maxV >= maxH) {
        pos = spaceBelow >= spaceAbove ? 'bottom' : 'top';
      } else {
        pos = spaceRight >= spaceLeft ? 'right' : 'left';
      }
    }

    let top = 0;
    let left = 0;

    switch (pos) {
      case 'bottom':
        top = Math.max(
          20,
          Math.min(
            window.innerHeight - bubbleHeight - 20,
            targetRect.bottom + PAD + MARGIN
          )
        );
        left = Math.max(
          20,
          Math.min(
            targetRect.left + targetRect.width / 2 - bubbleWidth / 2,
            window.innerWidth - bubbleWidth - 20
          )
        );
        break;
      case 'top':
        top = Math.max(20, targetRect.top - PAD - MARGIN - bubbleHeight);
        left = Math.max(
          20,
          Math.min(
            targetRect.left + targetRect.width / 2 - bubbleWidth / 2,
            window.innerWidth - bubbleWidth - 20
          )
        );
        break;
      case 'right':
        top = Math.max(
          20,
          Math.min(
            targetRect.top + targetRect.height / 2 - bubbleHeight / 2,
            window.innerHeight - bubbleHeight - 20
          )
        );
        left = Math.min(
          window.innerWidth - bubbleWidth - 20,
          targetRect.right + PAD + MARGIN
        );
        break;
      case 'left':
        top = Math.max(
          20,
          Math.min(
            targetRect.top + targetRect.height / 2 - bubbleHeight / 2,
            window.innerHeight - bubbleHeight - 20
          )
        );
        left = Math.max(20, targetRect.left - PAD - MARGIN - bubbleWidth);
        break;
      default:
        top = targetRect.bottom + PAD + MARGIN;
        left = targetRect.left;
    }

    return {
      top: `${top}px`,
      left: `${left}px`,
      transform: 'none',
    };
  };

  const bubbleStyle = computeBubblePosition();
  const PADDING = 8;

  return createPortal(
    <div className="guide-tour-container" style={{ position: 'fixed', inset: 0, zIndex: 99990 }}>
      {/* 1. 배경 딤 & 스포트라이트 오버레이 */}
      {targetRect && !isCenter ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99991, pointerEvents: 'none' }}>
          <div
            style={{
              position: 'absolute',
              top: targetRect.top - PADDING,
              left: targetRect.left - PADDING,
              width: targetRect.width + PADDING * 2,
              height: targetRect.height + PADDING * 2,
              borderRadius: 14,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.80)',
              border: '2px solid var(--accent)',
              animation: 'tour-spotlight-pulse 2.2s ease-in-out infinite',
              pointerEvents: 'none',
              transition: 'all 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          />
        </div>
      ) : (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99991,
            background: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(8px)',
          }}
        />
      )}

      {/* 2. 바깥 클릭 배경 */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 99992,
          cursor: 'pointer',
        }}
        onClick={handleNext}
      />

      {/* 3. 글래스모피즘 말풍선 / 센터 카드 (사이즈 확대 & 고가독성) */}
      <div
        style={{
          position: 'fixed',
          zIndex: 99995,
          pointerEvents: 'auto',
          ...bubbleStyle,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <motion.div
          key={currentStepIndex}
          initial={{ opacity: 0, y: isCenter ? 15 : 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className={`rounded-2xl border border-[var(--accent)]/45 shadow-[0_24px_64px_rgba(0,0,0,0.85),0_0_36px_var(--accent-soft)] ${
            isJumbo
              ? 'w-[960px] max-w-[96vw]'
              : hasImage || isCenter
              ? 'w-[740px] max-w-[95vw]'
              : 'w-[540px] max-w-[92vw]'
          }`}
          style={{
            background: 'rgba(10, 13, 18, 0.97)',
            backdropFilter: 'blur(28px)',
          }}
        >
          {/* 카드 헤더 */}
          <div className="px-6 pt-4.5 pb-3.5 flex items-center justify-between border-b border-zinc-800/90">
            <div className="flex items-center gap-2.5">
              <span className="text-2xl">💡</span>
              <span className="text-base font-black tracking-wider" style={{ color: 'var(--accent)' }}>
                따라하기 (튜토리얼)
              </span>
              {currentStep.badge && (
                <span className="text-xs font-bold px-3 py-1 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-500/50">
                  {currentStep.badge}
                </span>
              )}
              {isJumbo && (
                <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">
                  <Maximize2 className="w-3 h-3" /> 와이드 뷰
                </span>
              )}
            </div>

            <div className="flex items-center gap-3.5">
              <span className="text-xs font-mono font-bold text-zinc-300">
                {currentStepIndex + 1} / {steps.length}
              </span>
              <button
                onClick={onClose}
                className="text-zinc-400 hover:text-zinc-100 transition-colors p-1.5 rounded-lg hover:bg-zinc-800/60 cursor-pointer"
                title="튜토리얼 닫기 (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* 카드 본문 */}
          <div className="px-6 py-5 space-y-3.5 max-h-[82vh] overflow-y-auto custom-scrollbar">
            <div className="text-base sm:text-lg font-black text-zinc-100 flex items-center gap-2">
              {isLastStep ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              ) : (
                <Sparkles className="w-4.5 h-4.5 text-[var(--accent)] shrink-0" />
              )}
              <span>{currentStep.title}</span>
            </div>

            <div className="text-[14.5px] sm:text-[15.5px] text-zinc-200 leading-[1.7] whitespace-pre-line font-sans">
              {currentStep.message}
            </div>

            {/* 📸 캡처 이미지 시각적 안내 카드 (대형 / 점보 고화질 렌더링) */}
            {currentStep.image && (
              <div className="mt-3.5 rounded-xl overflow-hidden border border-zinc-700/90 bg-zinc-950 shadow-2xl">
                <div className="relative bg-zinc-900/60 p-1.5 flex items-center justify-center">
                  <img
                    src={currentStep.image}
                    alt={currentStep.title}
                    className={`w-full h-auto object-contain rounded-lg block mx-auto ${
                      isJumbo
                        ? 'max-h-[520px] sm:max-h-[580px]'
                        : 'max-h-[380px] sm:max-h-[420px]'
                    }`}
                  />
                </div>
                {currentStep.imageCaption && (
                  <div className="px-4 py-2.5 text-xs sm:text-[13px] font-sans font-semibold text-cyan-300 bg-zinc-900/95 border-t border-zinc-800 text-center flex items-center justify-center gap-2">
                    <ImageIcon className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>{currentStep.imageCaption}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 카드 푸터 (네비게이션) */}
          <div className="px-6 py-3.5 bg-zinc-900/70 border-t border-zinc-800/90 flex items-center justify-between rounded-b-2xl">
            {/* 이전 버튼 */}
            <div>
              {!isFirstStep && (
                <button
                  type="button"
                  onClick={handlePrev}
                  className="flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-zinc-300 hover:text-white transition-colors px-3 py-1.5 rounded-lg hover:bg-zinc-800/60 cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                  이전
                </button>
              )}
            </div>

            {/* 도트 인디케이터 */}
            <div className="flex items-center gap-2">
              {steps.map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => setCurrentStepIndex(idx)}
                  className={`h-2 rounded-full transition-all cursor-pointer ${
                    idx === currentStepIndex
                      ? 'w-7 bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]'
                      : 'w-2 bg-zinc-700 hover:bg-zinc-500'
                  }`}
                  title={`${idx + 1}단계로 이동`}
                />
              ))}
            </div>

            {/* 다음 / 완료 버튼 */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="text-xs sm:text-[13px] text-zinc-400 hover:text-zinc-200 transition-colors px-2.5 py-1.5 cursor-pointer"
              >
                건너뛰기
              </button>

              <button
                type="button"
                onClick={handleNext}
                className="flex items-center gap-1.5 text-xs sm:text-sm font-black px-5 py-2.5 rounded-xl cursor-pointer transition-all shadow-lg active:scale-95 hover:brightness-110"
                style={{
                  background: 'var(--accent)',
                  color: '#080b0f',
                }}
              >
                <span>{isLastStep ? '확인 및 시작' : '다음'}</span>
                {!isLastStep && <ChevronRight className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>,
    document.body
  );
};
