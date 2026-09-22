import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Upload, Square, Minus, Play, RotateCcw, Image as ImageIcon, Terminal, Database, Search, ZoomIn, ZoomOut, RadioTower, Check, Sparkles, Download, Eraser, Save, FolderOpen, X, AlertTriangle, Info, Ruler, Undo, Redo, Filter, Layers, ChevronDown, Sun, Moon, Zap, Sliders, Radio, HelpCircle, Lightbulb } from 'lucide-react';
import { GuideTour } from './components/GuideTour';
import { Point, Line, Polygon, SimulationParams, SimulationResult, Equipment, BatchResult, RankResult, SimulationMode, PolygonStatusItem } from './types';
import { runSimulation, pointInPolygon, snapToPolygonEdge, evaluateRay, distance, SECOND_VERANDA_WEIGHT } from './lib/simulation';
import { generateAutoVerandas, metersPerPxFromGeoMapping, VERANDA_AI_VERSION } from './lib/verandaAi';
import {
  CanvasGeoMapping,
  fitIsotropicMapping,
  pixelsPerMeterFromMapping,
  looksLikeLonLat,
  squareUpMapping,
  prepareSceneFromMoira
} from './lib/scenePrep';
import { loadExistingAntennaEquipments, antennasToEquipments } from './lib/antennaAssets';
import { sampleBuildings, sampleVerandas, sampleSecondVerandas } from './lib/sampleData';
import { AptListRow, loadAptList, hasConduitBuilding } from './lib/aptList';
import { MoiraComplexPolygonResult, MoiraBatchExport, CachedRapaKeyItem, fetchMoiraPolygonLiveDetailed, loadMoiraBatchCache, fetchMoiraPolygonFromCache, mergeEditedBuildings, saveMoiraPolygonToCache, restoreMoiraPolygonFromBackup, listCachedRapaKeys, canvasToLonLat, lonLatToCanvas } from './lib/moiraPolygon';
import { proposeGeoref, applyGeoref, GeorefProposal } from './lib/georef';
// @ts-ignore
import * as shp from 'shpjs';
import Markdown from 'react-markdown';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { motion, AnimatePresence } from 'motion/react';
import { DashboardView } from './components/DashboardView';
import { buildBatchResult } from './lib/resultSerializer';
import { STANDARD_SIM_PARAMS } from './lib/standardParams';
import { getApiUrl } from './lib/api';
import CadUploadPanel from './components/CadUploadPanel';
import BatchAutomationPanel from './components/BatchAutomationPanel';
import { fetchGeoDataJob, fetchAntennasJob, pingPyApi, getPyApiUrl, type PyJob } from './lib/pyApi';

// Helper for JSONP calls on the client side to bypass both browser CORS policies and cloud provider IP (WAF) blocks natively
const fetchJSONP = (url: string): Promise<any> => {

  return new Promise((resolve, reject) => {
    const callbackName = `vworld_jsonp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement("script");

    const hasQuestionMark = url.includes("?");
    const separator = hasQuestionMark ? "&" : "?";
    const jsonpUrl = `${url}${separator}callback=${callbackName}`;

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("VWorld OpenAPI 요청 시간 초과 (12초). 입력하신 브이월드 API Key 또는 등록 도메인 설정을 확인해 주세요."));
    }, 12000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (document.body.contains(script)) {
        document.body.removeChild(script);
      }
      delete (window as any)[callbackName];
    };

    (window as any)[callbackName] = (data: any) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("네트워크 보안 로드 실패 (브라우저가 브이월드 서버에 연결을 완료하지 못했거나, 키 발급 시 등록한 도메인과 현재 접속 도메인이 불일치합니다.)"));
    };

    script.src = jsonpUrl;
    script.async = true;
    document.body.appendChild(script); // ✅ DOM에 실제로 삽입해야 스크립트 실행됨
  });
};

// VWorld Helper functions for robust error handling and building name parsing
const extractVworldErrorMessage = (errorObj: any): string => {
  if (typeof errorObj === 'string') return errorObj;
  if (errorObj?.text) return errorObj.text;
  if (errorObj?.message) return errorObj.message;
  return 'Unknown VWorld error';
};

const getBuildingNameFromProperties = (props: any): string => {
  if (!props) return '건물';
  return props.buld_nm || props.buld_nm_a || props.buld_nm_b || props.bd_nm || props.name || props.id || '건물';
};

const extractCoreApartmentName = (query: string): string => {
  if (!query) return '';
  // 1. 괄호 및 괄호 안 내용 삭제 (예: "(1단계)", "[A동]")
  let clean = query.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '');
  // 2. 동 번호 / 단지 번호 패턴 완전 제거 (예: "101동", "101 동", "제101동", "A동", "1단지", "2단지", "101-1동" 등)
  clean = clean.replace(/(제?\d+[-~_]?\d*동|\b[A-Za-z0-9]+동|\b\d+단지|\b\d+차)/gi, '');
  // 3. 부속 시설 / 공용 건물 명칭 완전 제거 (작은도서관, 도서관, 노인정, 앞 등 추가)
  clean = clean.replace(/(경로당|입구|상가|아파트|주차장|관리사무소|정문|후문|상가동|복지관|어린이집|노인정|상업시설|테라스|작은도서관|도서관|앞|근처)/gi, '');
  // 4. 하이픈(-), 언더바(_), 특수문자 제거 (한글, 영문, 숫자만 보존)
  clean = clean.replace(/[-_]/g, '');
  clean = clean.replace(/[^\w\s가-힣]/g, ' ').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  return words.join('') || query;
};

/** Site 색 팔레트 — 캔버스와 결과 패널이 같은 값을 쓰도록 모듈 스코프에 둔다.
 *  1~5번은 기존 값 유지(검증 통과: 색각이상 ΔE 8.3 / 정상시각 18.6).
 *  6~10번은 재선정 — 기존 값은 6개째부터 무너졌다(ΔE 1.3까지 하락).
 *  Site 수에 상한이 없어 11번부터는 순환하므로, 식별의 근거는 항상 라벨의 Site 번호다. */


const SITE_PALETTE: string[] = [
  '#ffb300', // 1 Amber
  '#00e5ff', // 2 Cyan
  '#00e676', // 3 Green
  '#ff5252', // 4 Coral Red
  '#7c4dff', // 5 Purple
  '#b13065', // 6 Wine
  '#965719', // 7 Bronze
  '#16a56e', // 8 Jade
  '#3baece', // 9 Sky
  '#07719f', // 10 Deep Blue
];

/** 동일 좌표 = 동일 Site. 등장 순서대로 0-base 번호를 매긴다. */
const buildSiteOrder = (eqs: { x: number; y: number }[]): Map<string, number> => {
  const m = new Map<string, number>();
  let n = 0;
  eqs.forEach(eq => {
    const key = `${Math.round(eq.x)},${Math.round(eq.y)}`;
    if (!m.has(key)) m.set(key, n++);
  });
  return m;
};

export default function App() {
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'warning' | 'info' } | null>(null);

  // 축척(Scale Ruler) 안내는 일반 알림 슬롯과 분리한다.
  // 일반 알림은 슬롯이 1개라 뒤늦게 끝나는 배경 지도 타일 로드 알림에 덮여 사라졌다.
  // (LOS 도달거리 계산의 전제값이라 반드시 사용자 눈에 남아야 하는 정보)
  const [scaleNotice, setScaleNotice] = useState<{ mode: 'auto' | 'manual'; ppm: number | null } | null>(null);
  const scaleNoticeTimer = useRef<number | null>(null);
  const showScaleNotice = (mode: 'auto' | 'manual', ppm: number | null) => {
    setScaleNotice({ mode, ppm });
    if (scaleNoticeTimer.current !== null) window.clearTimeout(scaleNoticeTimer.current);
    scaleNoticeTimer.current = window.setTimeout(() => setScaleNotice(null), 12000);
  };

  const showAppNotification = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(prev => prev?.message === message ? null : prev);
    }, 8500);
  };

  const stripHtml = (htmlStr: string): string => {
    return htmlStr.replace(/<[^>]*>/g, '').trim();
  };

  // --- App Shell UI 상태 (디자인 리팩토링: 아이콘 레일 + 스텝 플라이아웃 패널 + 결과 드로어) ---
  // activePanel: 좌측 레일에서 토글되는 플라이아웃 패널. 한 번에 1개만 열림.
  const [activePanel, setActivePanel] = useState<'location' | 'model' | 'duct' | 'tools' | 'settings' | null>('location');
  // drawerOpen: 우측 결과 드로어 표시 여부. 시뮬레이션 완료 시 자동으로 true가 됨.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // mainView: 메인 영역 상단 탭 ('지도' | '전체 리스트'). 전체 리스트(Top-N 후보 표)는 다음 단계 기능.
  const [mainView, setMainView] = useState<'map' | 'list'>('map');
  // 베란다 총 길이 오버레이 접기/펼치기 — 지도를 가린다는 피드백으로 추가 (2026-08-14).
  // 접힘 상태에서는 헤더 줄만 남고, 베란다가 하나도 없으면 아예 렌더하지 않는다.
  const [verandaOverlayOpen, setVerandaOverlayOpen] = useState(true);
  // aiRevealed: Step2 "모델입력(AI 예측)" 결과 카드 노출 여부.
  // TODO(백엔드 연동 지점): 현재는 시각적 스캐폴딩만 존재. 실제로는 onnxruntime-web 세션 추론
  // (LightGBM → ONNX 변환 모델) 완료 시 aiPredResult를 채우고 aiRevealed=true 로 전환해야 함.
  // 피처 순서/스케일링은 학습 파이프라인과 동일해야 하며, 세션은 앱 부팅 시 1회 생성 후 캐시 권장.
  const [aiRevealed, setAiRevealed] = useState(false);
  const [aiPredResult, setAiPredResult] = useState<{ rawPred: number; finalPred: number } | null>(null);

  // --- 따라하기 (튜토리얼) 상태 ---
  const [guideTourId, setGuideTourId] = useState<'workflow' | 'dashboard' | null>(null);
  const [showGuideMenu, setShowGuideMenu] = useState(false);
  const guideButtonRef = useRef<HTMLButtonElement>(null);

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

  // --- RAPA 대상 리스트 (apt_list.csv) ---
  // DB_structure.pdf 기준: 운영 환경에서는 p_common.ailayer_apt_5g(Athena)에서 동일 컬럼을
  // 직접 조회하게 될 예정. 지금은 apt_list.csv를 로컬 목업 소스로 사용.
  const [aptList, setAptList] = useState<AptListRow[]>([]);
  const [aptListError, setAptListError] = useState<string | null>(null);
  const [selectedRapaKey, setSelectedRapaKey] = useState<string>('');
  const [filterHq, setFilterHq] = useState<string>('');       // 본부
  const [filterSido, setFilterSido] = useState<string>('');   // 시도
  const [filterEmd, setFilterEmd] = useState<string>('');     // 읍면동(행정동)

  // 폴리곤/도면 확보 현황 (server /api/polygon-status) — 리스트 마킹·필터용
  const [polygonStatus, setPolygonStatus] = useState<Record<string, PolygonStatusItem>>({});
  const [polygonFilter, setPolygonFilter] = useState<'all' | 'no_polygon' | 'has_polygon'>('all'); // '전체' | '미확보만' | '미확보제외'

  useEffect(() => {
    loadAptList()
      .then(rows => setAptList(rows))
      .catch(err => {
        console.warn('[apt_list.csv] 로드 실패:', err);
        setAptListError(err.message || String(err));
      });
    // 폴리곤/도면 확보 현황 — 서버 API 실패 시(사내 정적 배포) public/polygon_status.json으로 자동 폴백
    const base = (import.meta as any).env?.BASE_URL || '/';
    fetch(getApiUrl('/api/polygon-status'))
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (j && j.status) {
          setPolygonStatus(j.status);
        } else {
          return fetch(`${base}polygon_status.json`)
            .then(r => (r.ok ? r.json() : null))
            .then(sj => { if (sj && sj.status) setPolygonStatus(sj.status); });
        }
      })
      .catch(() => {
        fetch(`${base}polygon_status.json`)
          .then(r => (r.ok ? r.json() : null))
          .then(sj => { if (sj && sj.status) setPolygonStatus(sj.status); })
          .catch(() => {});
      });
  }, []);

  // MOIRA(Athena) 배치 캐시 — public/complex_polygons.json이 있으면(사내망에서 athena/query_moira.py
  // batch로 미리 만들어둔 경우) 실시간 조회 실패 시 이걸 2순위 폴백으로 사용. 없으면 null (정상 상황).
  const [moiraBatchCache, setMoiraBatchCache] = useState<MoiraBatchExport | null>(null);

  // Esc — 도구 해제 + Site 선택 해제. 도구를 고르면 idle로 돌아갈 방법이 없던 문제 보완.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMode('idle');
      setCurrentPolygon([]);
      setCurrentLineStart(null);
      setSelectedSiteKey(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // [Spacebar Pan] 스페이스바를 누르고 있는 동안 임시로 화면 드래그 이동(Pan) 모드로 전환
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;
      if (e.code === 'Space' && !e.repeat) {
        setIsSpacePressed(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
        setIsPanning(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // [테마] 다크 기본. <html data-theme>로 전환하며 선택값은 localStorage에 유지.
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('rf-los-theme');
      return saved === 'light' ? 'light' : 'dark';
    } catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('rf-los-theme', theme); } catch { }
  }, [theme]);

  // [DB 저장] 현재 화면이 어떤 원본 JSON에서 나왔는지 추적. RAPA Key로 불러온 경우에만 세팅되며,
  // 저장 시 이 원본과 화면 상태를 비교해 유지/수정/추가/삭제를 판정한다.
  // (SHP 업로드·샘플·Load Topology 등 원본 JSON이 없는 경로에서는 null로 두어 DB 저장을 막는다)
  const [sourceMoira, setSourceMoira] = useState<MoiraComplexPolygonResult | null>(null);
  const [isSavingDb, setIsSavingDb] = useState<boolean>(false);

  // [단지 위치 보정] CAD 추출 단지는 apt_list 대표좌표 오차(최대 ~1km)·방위 미상 문제가 있어
  // VWorld 필지/용도지역 경계와 형상 정합(src/lib/georef.ts)으로 위치·방위를 맞춘다.
  const [georefProposal, setGeorefProposal] = useState<GeorefProposal | null>(null);
  const [georefBusy, setGeorefBusy] = useState<boolean>(false);
  const [georefDirty, setGeorefDirty] = useState<boolean>(false); // 화면엔 적용했지만 아직 JSON 미저장
  const [georefRefRings, setGeorefRefRings] = useState<[number, number][][] | null>(null); // 정합 기준 경계(표시용)
  const [georefStep, setGeorefStep] = useState<number>(5); // 수동 이동 보폭(m)
  // 배경지도 타일: 서버에 VWorld 키가 있으면 국내 지도/항공사진(워터마크 없음)을 쓴다.
  const [vworldTiles, setVworldTiles] = useState<boolean>(false);

  // [관로동 추천] 투자 2년 전 시점에 '어느 동에 장비를 넣을지'를 보수적으로 고르기 위한 모드.
  // 기존 시뮬레이션을 그대로 쓰되 (1) 목표 커버율을 올리고 (2) 단지 밖 건물은 차폐로만 쓰고
  // (3) 기준 분석 대비 N배수 사이트에서 멈춘다.
  const [ductTarget, setDuctTarget] = useState<number>(90);
  const [ductMultiplier, setDuctMultiplier] = useState<number>(2);
  const [ductBaselineSites, setDuctBaselineSites] = useState<number | null>(null);
  const [ductRunInfo, setDuctRunInfo] = useState<{ baseline: number; cap: number; target: number; sites: number; coverage: number } | null>(null);

  // [지역 필터] 상단바 팝오버 상태
  const [showRegionFilter, setShowRegionFilter] = useState<boolean>(false);
  const regionFilterRef = useRef<HTMLDivElement>(null);

  // [RAPA Key 부분검색] 상단바 검색창 상태
  const [rapaSearch, setRapaSearch] = useState<string>('');
  const [showRapaSearch, setShowRapaSearch] = useState<boolean>(false);
  const [cachedKeyInfo, setCachedKeyInfo] = useState<Record<string, CachedRapaKeyItem>>({});
  const [lastMoiraSource, setLastMoiraSource] = useState<'athena-live' | 'athena-cache' | null>(null);

  // [임시 디버그용] MOIRA Athena 쿼리 결과 확인 팝업 상태
  const [showMoiraDebugModal, setShowMoiraDebugModal] = useState<boolean>(false);
  const [moiraDebugInfo, setMoiraDebugInfo] = useState<{
    rapaKey: string;
    apartmentName: string;
    lat: number;
    lng: number;
    timestamp: string;
    liveStatus: 'idle' | 'loading' | 'success' | 'failed' | 'skipped';
    httpStatus?: number;
    liveError?: string;
    cacheFound: boolean;
    finalSource: 'athena-live' | 'athena-cache' | 'none';
    complexFound: boolean;
    complexId?: number | null;
    complexSclNm?: string | null;
    buildingCount: number;
    buildingSource?: string | null;
    buildingsSummary?: { name: string; floors: string; height: string }[];
    rawResponse?: any;
  } | null>(null);

  useEffect(() => {
    loadMoiraBatchCache().then(setMoiraBatchCache);
  }, []);

  // 건물/단지 폴리곤이 하나도 없어도 최소한 지도(배경 타일)는 대상 위경도 중심으로 띄운다.
  // (데이터가 비어도 "여기가 어디인지"는 보여야 하므로 — 폴리곤 매칭 실패와 지도 표시는 별개)
  const centerMapOnPoint = (lat: number, lng: number, apartmentName: string, note: string) => {
    const bufferDeg = 0.005; // ~500m, athena/query_moira.py의 bbox 폴백과 동일 반경
    const mapping = fitIsotropicMapping({
      minLon: lng - bufferDeg,
      minLat: lat - bufferDeg,
      lonRange: bufferDeg * 2,
      latRange: bufferDeg * 2,
    });
    const cWidth = mapping.cWidth, cHeight = mapping.cHeight;

    setCanvasSize({ width: cWidth, height: cHeight });
    setBuildings([]);
    setVerandas([]); setConcreteWalls([]);
    setManualEquipments([]);
    setResult(null);
    setMode('idle');
    setGeoMapping(mapping);
    setAnalysisArea(null);

    if (canvasRef.current) {
      canvasRef.current.width = cWidth;
      canvasRef.current.height = cHeight;
    }
    if (mapTileType !== 'None') {
      loadOpenMapBackground(mapping, mapTileType);
    }

    setSourceMoira(null); // 폴리곤 미매칭 — DB 저장 대상 아님
    showAppNotification(`${apartmentName}: ${note} — 지도만 대상 위경도 기준으로 표시합니다.`, 'warning');
    applyAutoScaleFromMapping(mapping);
  };

  // Athena(MOIRA)에서 받아온 단지 폴리곤 + 건물 폴리곤(위경도)을 캔버스 좌표계로 변환해 반영.
  // ==========================================================================
  // Flask(python) API 연동 — DB 조회 / CAD 추출
  // --------------------------------------------------------------------------
  // 이 앱은 사내에서 정적 파일(nginx)로 서빙되어 python 실행도, 사내 DB 접속도 못 한다.
  // 그래서 무거운 작업은 Flask 앱(playground-daily-tmap-data-querying-l)에 위임하고
  // 결과 JSON만 받아 화면에 반영한다. 요청 경로는 src/lib/pyApi.ts 참조.
  // ==========================================================================
  const [pyApiOnline, setPyApiOnline] = useState<boolean | null>(null);
  // 안테나 재조회 시 캔버스 변환에 필요 — applyMoiraResult에서 갱신된다
  const [scenePixelsPerMeter, setScenePixelsPerMeter] = useState<number | null>(null);
  const [pyBusy, setPyBusy] = useState(false);
  const [pyJob, setPyJob] = useState<PyJob | null>(null);

  // 앱 시작 시 Flask 서버 가용 여부 확인 — 실패해도 앱 동작에는 영향 없음
  useEffect(() => {
    let alive = true;
    pingPyApi().then(p => {
      if (!alive) return;
      setPyApiOnline(Boolean(p));
      if (p && !p.capabilities.idcube_hive_connector) {
        console.warn('[PY] Flask는 떠 있으나 사내 DB 라이브러리가 없습니다 — 사외망으로 보입니다.');
      }
    });
    return () => { alive = false; };
  }, []);

  /** [작업 1-1] 현재 선택 대상의 단지/건물 폴리곤을 Flask를 통해 DB에서 다시 조회 */
  const handlePyRefreshGeo = async () => {
    const row = selectedAptRow;
    if (!row) {
      showAppNotification('먼저 RAPA Key를 선택해 주세요.', 'warning');
      return;
    }
    setPyBusy(true);
    setPyJob(null);
    try {
      const out = await fetchGeoDataJob(
        [{ rapaKey: row.rapaKey, lat: row.lat, lng: row.lng }],
        // 조회 반경은 서버 기본값(167m)을 쓴다 — Ground Rule(65m)은 화면 표시 단계에서
        // scenePrep.ts 가 적용하므로, 여기서 좁히면 나중에 반경을 넓힐 때 데이터가 모자란다.
        { onProgress: setPyJob }
      );
      const data = out.targets?.[row.rapaKey];
      if (!data) {
        const reason = out.failed?.[0]?.reason || '결과 없음';
        showAppNotification(`DB 조회 실패: ${reason}`, 'error');
        return;
      }
      if (data.skipped) {
        showAppNotification(
          `단지 폴리곤을 DB에서 찾지 못했습니다 (${data.skipReason}). CAD 도면으로 생성해 주세요.`,
          'warning'
        );
        return;
      }
      applyMoiraResult(data, row.buildingName || row.projectName, row.lat, row.lng);
      setLastMoiraSource('athena-live');
      showAppNotification(
        `DB 조회 완료: 건물 ${data.buildings?.length ?? 0}개 ` +
        `(단지내 ${data.stats?.inComplex ?? 0} / 주변 ${data.stats?.neighbors ?? 0})`,
        'success'
      );
    } catch (err: any) {
      showAppNotification(`DB 조회 실패: ${err.message}`, 'error');
    } finally {
      setPyBusy(false);
      setPyJob(null);
    }
  };

  /** [작업 1-2] 현재 선택 대상 주변(65m) 자사 안테나를 Flask를 통해 조회 */
  const handlePyRefreshAntennas = async () => {
    const row = selectedAptRow;
    if (!row) {
      showAppNotification('먼저 RAPA Key를 선택해 주세요.', 'warning');
      return;
    }
    setPyBusy(true);
    setPyJob(null);
    try {
      const out = await fetchAntennasJob(
        [{ rapaKey: row.rapaKey, lat: row.lat, lng: row.lng }],
        // 안테나도 넉넉히(서버 기본 557m) 받아서 antennasToEquipments 가 65m로 거른다.
        { onProgress: setPyJob }
      );
      const list = out.targets?.[row.rapaKey] || [];
      if (!list.length) {
        showAppNotification(`반경 ${out.radiusMeters}m 내 자사 안테나가 없습니다 (dt=${out.dt}).`, 'info');
        return;
      }
      // 조회 결과를 캔버스 장비로 변환 — 기존 캐시 경로(loadExistingAntennaEquipments)와 동일 규칙
      if (!geoMapping || scenePixelsPerMeter === null) {
        showAppNotification(
          `안테나 ${list.length}개를 조회했지만, 먼저 단지/건물 폴리곤을 불러와야 배치할 수 있습니다.`,
          'warning'
        );
        return;
      }
      const equipments = antennasToEquipments(
        list,
        geoMapping,
        analysisArea,
        scenePixelsPerMeter,
        {
          bufferMeters: params.adjacentBuildingBuffer ?? STANDARD_SIM_PARAMS.adjacentBuildingBuffer,
          buildings, // 호스트 건물 bIdx 판정용 — 없으면 자기 건물이 신호를 막는다
        }
      );
      setExistingAntennas(equipments);
      showAppNotification(
        `자사 안테나 조회 완료: ${list.length}개 중 ${equipments.length}개 배치 (dt=${out.dt})`,
        'success'
      );
    } catch (err: any) {
      showAppNotification(`안테나 조회 실패: ${err.message}`, 'error');
    } finally {
      setPyBusy(false);
      setPyJob(null);
    }
  };

  /** [작업 1-3] CAD 추출 결과를 시뮬레이터에 적용 */
  const handleCadExtracted = (data: any) => {
    const row = selectedAptRow;
    if (!row) return;
    if (!data?.buildings?.length) {
      showAppNotification('CAD에서 건물을 추출하지 못했습니다.', 'error');
      return;
    }
    applyMoiraResult(data, row.buildingName || row.projectName, row.lat, row.lng);
    setLastMoiraSource('athena-live');
  };

  const applyMoiraResult = (moira: MoiraComplexPolygonResult, apartmentName: string, lat: number, lng: number, opts?: { silent?: boolean; keepGeoref?: boolean }) => {
    if (!opts?.keepGeoref) { setGeorefProposal(null); setGeorefRefRings(null); setGeorefDirty(false); }
    let scene: ReturnType<typeof prepareSceneFromMoira>;
    try {
      scene = prepareSceneFromMoira(moira, {
        generateVerandas: false,
        adjacentBuildingBuffer: params.adjacentBuildingBuffer ?? STANDARD_SIM_PARAMS.adjacentBuildingBuffer,
      });
    } catch (err: any) {
      centerMapOnPoint(lat, lng, apartmentName, 'MOIRA에서 단지 폴리곤/건물 모두 매칭되지 않았습니다');
      return;
    }

    const { mapping, buildings: parsedBuildings, analysisArea: mappedComplexArea } = scene;
    const cWidth = mapping.cWidth, cHeight = mapping.cHeight;

    setCanvasSize({ width: cWidth, height: cHeight });
    setBuildings(parsedBuildings);
    setVerandas([]); setConcreteWalls([]);
    setManualEquipments([]);
    setResult(null);
    setMode('idle');
    setGeoMapping(mapping);
    setAnalysisArea(mappedComplexArea);
    setSourceMoira(moira); // DB 저장 기준이 되는 원본 스냅샷
    setScenePixelsPerMeter(scene.pixelsPerMeter); // 안테나 재조회 시 재사용

    // 인접 무선시설(기존 안테나) 로딩 — 공간 필터는 건물과 동일 기준(단지 폴리곤 + adjacentBuildingBuffer)
    setExistingAntennas([]);
    loadExistingAntennaEquipments(
      moira.rapaKey,
      mapping,
      mappedComplexArea,
      scene.pixelsPerMeter,
      {
        bufferMeters: params.adjacentBuildingBuffer ?? STANDARD_SIM_PARAMS.adjacentBuildingBuffer,
        buildings: parsedBuildings, // 호스트 건물 bIdx 판정용 — 없으면 자기 건물이 신호를 막는다
      }
    ).then(ants => {
      setExistingAntennas(ants);
      if (ants.length > 0 && !opts?.silent) {
        showAppNotification(`인접 안테나 ${ants.length}개 섹터를 기존 커버리지로 반영합니다.`, 'info');
      }
    }).catch(() => setExistingAntennas([]));

    if (canvasRef.current) {
      canvasRef.current.width = cWidth;
      canvasRef.current.height = cHeight;
    }
    if (mapTileType !== 'None') {
      loadOpenMapBackground(mapping, mapTileType);
    }

    const sourceLabel = moira.buildingSource === 'complex_polygon' ? '단지 폴리곤 내부 건물' : '단지 폴리곤 미발견 → 500m 반경 건물';
    if (!opts?.silent) showAppNotification(
      `MOIRA Athena 조회 성공 (${apartmentName}): ${sourceLabel} ${parsedBuildings.length}개 폴리곤 로드`,
      'success'
    );
    applyAutoScaleFromMapping(mapping);
  };

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [buildings, setBuildings] = useState<Polygon[]>(sampleBuildings);
  const [verandas, setVerandas] = useState<Line[]>([...sampleVerandas, ...sampleSecondVerandas]);
  // AI 자동 세팅이 '콘크리트'로 분류한 벽면. 그리지 않으면 미분석 구간과 구별되지 않으므로
  // 무채색 얇은 선으로 표시해 "분석했고, 창호가 없는 벽"임을 알린다.
  const [concreteWalls, setConcreteWalls] = useState<Line[]>([]);
  // Site 선택 강조 — 키는 '반올림 x,y'(동일 좌표 = 동일 Site). null이면 전체 표시.
  // Site 수에 상한이 없어 색만으로는 구분이 무너지므로, 최종 식별 수단은 이 선택 + 라벨 ID다.
  const [selectedSiteKey, setSelectedSiteKey] = useState<string | null>(null);
  const [analysisArea, setAnalysisArea] = useState<Point[] | null>(null);
  const [manualEquipments, setManualEquipments] = useState<Equipment[]>([]);
  // 인접 무선시설(o_iam.celp_fgru_antenna)에서 불러온 기존 안테나 — 읽기 전용, 커버리지 계산에 기존 Sector로 반영
  const [existingAntennas, setExistingAntennas] = useState<Equipment[]>([]);
  const [mode, setMode] = useState<'idle' | 'building' | 'veranda' | 'second_veranda' | 'equipment' | 'eraser' | 'ruler'>('idle');

  // Background Map Tile state ('Base' | 'Satellite' | 'None')
  const [mapTileType, setMapTileType] = useState<'Base' | 'Satellite' | 'Hybrid' | 'None'>('Base');

  // Ruler Calibration States
  const [rulerLine, setRulerLine] = useState<{ start: Point; end: Point } | null>(null);
  const [rulerInputMeters, setRulerInputMeters] = useState<string>('50');

  // Undo / Redo History Tracking
  const isUndoRedoAction = useRef(false);
  const [historyState, setHistoryState] = useState<{
    history: { buildings: Polygon[], verandas: Line[], manualEquipments: Equipment[] }[],
    index: number
  }>({
    history: [],
    index: -1
  });

  useEffect(() => {
    if (isUndoRedoAction.current) {
      isUndoRedoAction.current = false;
      return;
    }
    setHistoryState(prev => {
      const last = prev.history[prev.index];
      if (last && last.buildings === buildings && last.verandas === verandas && last.manualEquipments === manualEquipments) {
        return prev;
      }
      const newHistory = prev.history.slice(0, Math.max(0, prev.index + 1));
      newHistory.push({ buildings, verandas, manualEquipments });
      if (newHistory.length > 50) newHistory.shift();
      return { history: newHistory, index: newHistory.length - 1 };
    });
  }, [buildings, verandas, manualEquipments]);

  const handleUndo = () => {
    if (historyState.index > 0) {
      isUndoRedoAction.current = true;
      const newIndex = historyState.index - 1;
      const state = historyState.history[newIndex];
      setBuildings(state.buildings);
      setVerandas(state.verandas);
      setManualEquipments(state.manualEquipments);
      setHistoryState({ history: historyState.history, index: newIndex });
      setResult(null);
    }
  };

  const handleRedo = () => {
    if (historyState.index < historyState.history.length - 1) {
      isUndoRedoAction.current = true;
      const newIndex = historyState.index + 1;
      const state = historyState.history[newIndex];
      setBuildings(state.buildings);
      setVerandas(state.verandas);
      setManualEquipments(state.manualEquipments);
      setHistoryState({ history: historyState.history, index: newIndex });
      setResult(null);
    }
  };

  const handleApplyRulerCalibration = () => {
    if (!rulerLine) return;
    const dx = rulerLine.end.x - rulerLine.start.x;
    const dy = rulerLine.end.y - rulerLine.start.y;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const meters = parseFloat(rulerInputMeters);
    if (isNaN(meters) || meters <= 0) {
      showAppNotification('유효한 거리 값을 입력해 주세요 (0보다 큰 숫자)', 'error');
      return;
    }
    const newPPM = distPx / meters;
    setParams(prev => ({ ...prev, pixelsPerMeter: parseFloat(newPPM.toFixed(3)) }));
    setRulerLine(null);
    setMode('idle');
    showScaleNotice('auto', parseFloat(newPPM.toFixed(3)));
    showAppNotification(`보정 완료: 스케일이 ${newPPM.toFixed(3)} Pixels/Meter 로 업데이트 되었습니다. (그려진 선: ${Math.round(distPx)}px = ${meters}m)`, 'success');
  };

  // 단지/건물 폴리곤(위경도)이 로드되면 화면 축척을 자동 산출해 params.pixelsPerMeter에 반영.
  // LOS 도달거리(maxRange, m)는 픽셀 거리로 환산돼 계산되므로 축척이 틀리면 결과 자체가 틀린다.
  // 계산 불가(이미지 업로드 등)면 Scale Ruler 수동 보정을 안내한다.
  const applyAutoScaleFromMapping = (m: CanvasGeoMapping | null) => {
    const ppm = pixelsPerMeterFromMapping(m);
    if (ppm === null) {
      showScaleNotice('manual', null);
      return;
    }
    const rounded = parseFloat(ppm.toFixed(3));
    setParams(prev => ({ ...prev, pixelsPerMeter: rounded }));
    showScaleNotice('auto', rounded);
  };

  const [currentPolygon, setCurrentPolygon] = useState<Point[]>([]);
  const [currentLineStart, setCurrentLineStart] = useState<Point | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);

  const [params, setParams] = useState<SimulationParams>({
    ...STANDARD_SIM_PARAMS,
    pixelsPerMeter: 2,
    strictCoLocation: true,
    preventAutoSectors: false,
    simulationMode: 'full_auto'
  });

  const [result, setResult] = useState<SimulationResult | null>(null);
  const [selectedRank, setSelectedRank] = useState<number>(1);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simProgress, setSimProgress] = useState(0);
  const [simStatusMessage, setSimStatusMessage] = useState('');
  const [expandedLogEntry, setExpandedLogEntry] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 1000 });

  const [aiInsights, setAiInsights] = useState<string | null>(null);
  const [isGeneratingInsights, setIsGeneratingInsights] = useState(false);
  const [showAiPanel, setShowAiPanel] = useState(false);

  // VWorld API and mapping state definitions
  const [geoMapping, setGeoMapping] = useState<{
    minLon: number;
    minLat: number;
    lonRange: number;
    latRange: number;
    cWidth: number;
    cHeight: number;
  } | null>(null);

  const [vworldKey, setVworldKey] = useState<string>(() => {
    return localStorage.getItem('vworld_api_key') || ((import.meta as any).env?.VITE_VWORLD_API_KEY as string) || '';
  });
  const [vworldDomain, setVworldDomain] = useState<string>(() => {
    const REGISTERED_DOMAIN = 'https://ais-dev-sm53qq4od7hwjydkbyh6gn-232203969309.asia-east1.run.app';
    const stored = localStorage.getItem('vworld_api_domain') || '';
    // localhost 값이 저장되어 있으면 강제로 등록 도메인으로 초기화
    if (!stored || stored.includes('localhost') || stored.includes('127.0.0.1')) {
      localStorage.setItem('vworld_api_domain', REGISTERED_DOMAIN);
      return REGISTERED_DOMAIN;
    }
    return stored;
  });
  const [vworldRequestMode, setVworldRequestMode] = useState<'direct' | 'proxy'>(() => {
    // proxy 모드 기본: 서버가 Referer를 등록 도메인으로 세팅하여 VWorld 인증 통과
    return (localStorage.getItem('vworld_request_mode') as 'direct' | 'proxy') || 'proxy';
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCandidates, setSearchCandidates] = useState<any[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'success' | 'error' | 'no_result'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [isFetchingPolygons, setIsFetchingPolygons] = useState(false);
  const [searchLayer] = useState<'LT_C_SPBD'>('LT_C_SPBD'); // VWorld 아파트 폴리곤 전용: LT_C_SPBD (LT_C_BLDINFO는 비공개 API)
  const [useNameFilter, setUseNameFilter] = useState<boolean>(() => {
    const stored = localStorage.getItem('use_name_filter');
    return stored !== null ? stored === 'true' : true; // 기본값 true: 단지명 필터 ON
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hoveredBuildingIdx, setHoveredBuildingIdx] = useState<number>(-1);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const dragMovedRef = useRef<boolean>(false);

  // [화면 이동 / Pan 마우스 핸들러 — Transform 오프셋 기반 무제한 2D 드래그]
  const handleMapMouseDown = (e: React.MouseEvent) => {
    const isLeft = e.button === 0;
    const isMiddle = e.button === 1;
    const canPan = (mode === 'idle' && isLeft) || isSpacePressed || isMiddle;

    if (canPan) {
      if (isMiddle) e.preventDefault();
      setIsPanning(true);
      dragMovedRef.current = false;
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: panOffset.x,
        panY: panOffset.y,
      };
    }
  };

  useEffect(() => {
    if (!isPanning) return;

    const onGlobalMouseMove = (e: MouseEvent) => {
      if (!panStartRef.current) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        dragMovedRef.current = true;
      }
      setPanOffset({
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      });
    };

    const onGlobalMouseUp = () => {
      setIsPanning(false);
      panStartRef.current = null;
    };

    window.addEventListener('mousemove', onGlobalMouseMove);
    window.addEventListener('mouseup', onGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', onGlobalMouseMove);
      window.removeEventListener('mouseup', onGlobalMouseUp);
    };
  }, [isPanning]);

  const handleMapWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const zoomDelta = e.deltaY < 0 ? 0.1 : -0.1;
      setZoom(z => Math.max(0.1, Math.min(3, Math.round((z + zoomDelta) * 10) / 10)));
    } else {
      // 휠 상하/좌우 조작 시 부드러운 Pan 오프셋 이동
      e.preventDefault();
      setPanOffset(prev => ({
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY,
      }));
    }
  };

  // 맵 상단 베란다 길이 (1차 & 2차) 실시간 산출
  // 사용자가 직접 그린 베란다만 집계 (반대변 자동 추출 기능 제거 — 별도 고도화 예정)
  const { totalFirstVerandaMeters, totalSecondVerandaMeters } = React.useMemo(() => {
    const firstVerandas = verandas.filter(v => !v.isSecond);
    const userSecondVerandas = verandas.filter(v => v.isSecond);

    const ppm = params.pixelsPerMeter > 0 ? params.pixelsPerMeter : 1;
    const firstPx = firstVerandas.reduce((sum, v) => sum + distance(v.start, v.end), 0);
    const secondPx = userSecondVerandas.reduce((sum, v) => sum + distance(v.start, v.end), 0);

    return {
      totalFirstVerandaMeters: firstPx / ppm,
      totalSecondVerandaMeters: secondPx / ppm
    };
  }, [verandas, params.pixelsPerMeter]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const url = event.target?.result as string;
      const img = new Image();
      img.onload = () => {
        imageRef.current = img;
        setImageSrc(url);
        setCanvasSize({ width: img.width, height: img.height });
        if (canvasRef.current) {
          canvasRef.current.width = img.width;
          canvasRef.current.height = img.height;
        }
        setBuildings([]);
        setVerandas([]); setConcreteWalls([]);
        setResult(null);
        // 이미지 배경은 위경도 정보가 없어 축척을 계산할 수 없다 → 수동 보정 안내
        setGeoMapping(null);
        setAnalysisArea(null);
        showScaleNotice('manual', null);
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  };

  const handleShpUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const geojson = await shp.parseZip(arrayBuffer);
      let features: any[] = [];
      if (Array.isArray(geojson)) {
        features = geojson.flatMap(g => g.features);
      } else {
        features = geojson.features;
      }

      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
      features.forEach(f => {
        if (f.geometry && f.geometry.type === 'Polygon') {
          f.geometry.coordinates[0].forEach((coord: number[]) => {
            minLon = Math.min(minLon, coord[0]);
            minLat = Math.min(minLat, coord[1]);
            maxLon = Math.max(maxLon, coord[0]);
            maxLat = Math.max(maxLat, coord[1]);
          });
        } else if (f.geometry && f.geometry.type === 'MultiPolygon') {
          f.geometry.coordinates.forEach((poly: number[][][]) => {
            poly[0].forEach((coord: number[]) => {
              minLon = Math.min(minLon, coord[0]);
              minLat = Math.min(minLat, coord[1]);
              maxLon = Math.max(maxLon, coord[0]);
              maxLat = Math.max(maxLat, coord[1]);
            });
          });
        }
      });

      // 투영 등방화 (WGS84 위경도로 보일 때만; 투영좌표계 SHP이면 원본 유지 후 수동 보정 안내)
      const shpMapping = fitIsotropicMapping({
        minLon, minLat,
        lonRange: (maxLon - minLon) || 1,
        latRange: (maxLat - minLat) || 1,
      });
      minLon = shpMapping.minLon;
      minLat = shpMapping.minLat;
      const lonRange = shpMapping.lonRange;
      const latRange = shpMapping.latRange;
      const cWidth = shpMapping.cWidth, cHeight = shpMapping.cHeight;

      const parsedBuildings: Polygon[] = [];
      features.forEach(f => {
        if (f.geometry && f.geometry.type === 'Polygon') {
          const poly = f.geometry.coordinates[0].map((coord: number[]) => {
            const x = ((coord[0] - minLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
            const y = cHeight - (((coord[1] - minLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1));
            return { x, y };
          });
          parsedBuildings.push(poly);
        } else if (f.geometry && f.geometry.type === 'MultiPolygon') {
          f.geometry.coordinates.forEach((multiPoly: number[][][]) => {
            const poly = multiPoly[0].map((coord: number[]) => {
              const x = ((coord[0] - minLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
              const y = cHeight - (((coord[1] - minLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1));
              return { x, y };
            });
            parsedBuildings.push(poly);
          });
        }
      });

      setCanvasSize({ width: cWidth, height: cHeight });
      setImageSrc(null);
      imageRef.current = null;
      setSourceMoira(null);
      setBuildings(parsedBuildings);
      setVerandas([]); setConcreteWalls([]);
      setManualEquipments([]);
      setResult(null);
      setMode('idle');
      setGeoMapping(shpMapping);
      applyAutoScaleFromMapping(shpMapping);
      if (canvasRef.current) {
        canvasRef.current.width = cWidth;
        canvasRef.current.height = cHeight;
      }
    } catch (err) {
      console.error("SHP Parse Error:", err);
      showAppNotification("SHP 파일 파싱에 실패했습니다. 올바른 형태의 zip 데이터인지 확인해 주세요.", "error");
    }
  };

  const loadSampleData = () => {
    setCanvasSize({ width: 1000, height: 1000 });
    setImageSrc(null);
    imageRef.current = null;
    setSourceMoira(null);
    setAnalysisArea(null);
    setBuildings(sampleBuildings);
    setVerandas([...sampleVerandas, ...sampleSecondVerandas]);
    setManualEquipments([]);
    setResult(null);
    setMode('idle');
    if (canvasRef.current) {
      canvasRef.current.width = 1000;
      canvasRef.current.height = 1000;
    }
  };

  const handleAiAutoVerandas = () => {
    if (buildings.length === 0) {
      showAppNotification("분석할 건물 폴리곤이 없습니다. 아파트를 먼저 선택해 주세요.", "warning");
      return;
    }
    const { verandas: autoVerandas, concreteWalls: autoConcrete, targetBuildings } = generateAutoVerandas(
      buildings,
      analysisArea,
      geoMapping ? metersPerPxFromGeoMapping(geoMapping) : {}
    );
    if (autoVerandas.length === 0) {
      showAppNotification("단지 영역 내에서 유효한 베란다를 추출하지 못했습니다.", "warning");
      return;
    }
    setVerandas(autoVerandas);
    setConcreteWalls(autoConcrete);
    const firstCount = autoVerandas.filter(v => !v.isSecond).length;
    const secondCount = autoVerandas.filter(v => v.isSecond).length;
    showAppNotification(
      `⚡ AI 베란다 자동 세팅 완료: 단지 내 ${targetBuildings.length}동 대상 1차(거실) ${firstCount}개, 2차(배면) ${secondCount}개 자동 추출`,
      "success"
    );
  };

  const distSq = (v: Point, w: Point) => (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  const distToSegmentSquared = (p: Point, v: Point, w: Point) => {
    let l2 = distSq(v, w);
    if (l2 === 0) return distSq(p, v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return distSq(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
  };
  const distToSegment = (p: Point, v: Point, w: Point) => Math.sqrt(distToSegmentSquared(p, v, w));

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // 드래그로 화면을 이동한 경우 클릭 이벤트 무시
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    // 스페이스바 팬 모드 중인 경우 그리기 클릭 방지
    if (isSpacePressed) return;

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;
    const p = { x, y };

    // 도구를 고르지 않은 상태(idle)에서 섹터를 클릭하면 그 Site만 강조한다.
    // Site 수에 상한이 없어 색만으로는 구분이 무너지므로, 이 선택이 최종 식별 수단이다.
    if (mode === 'idle') {
      const ranked = (result && result.rankResults) ? result.rankResults[selectedRank] : null;
      const shown: Equipment[] = ranked ? ranked.equipments : (result ? result.equipments : manualEquipments);
      let hit: Equipment | null = null;
      let bestD = 16; // 섹터 배지 반경(11px) + 여유
      shown.forEach(eq => {
        const rad = (eq.angle - 90) * Math.PI / 180;
        const ix = eq.x + Math.cos(rad) * 18;
        const iy = eq.y + Math.sin(rad) * 18;
        const d = Math.hypot(ix - x, iy - y);
        if (d < bestD) { bestD = d; hit = eq; }
      });
      if (hit) {
        const key = `${Math.round((hit as Equipment).x)},${Math.round((hit as Equipment).y)}`;
        setSelectedSiteKey(prev => (prev === key ? null : key));
        return;
      }
      if (selectedSiteKey) { setSelectedSiteKey(null); return; } // 빈 곳 클릭 = 선택 해제
    }

    if (mode === 'building') {
      setCurrentPolygon([...currentPolygon, p]);
    } else if (mode === 'ruler') {
      if (!currentLineStart) {
        setCurrentLineStart(p);
      } else {
        setRulerLine({ start: currentLineStart, end: p });
        setCurrentLineStart(null);
      }
    } else if (mode === 'veranda') {
      if (!currentLineStart) {
        setCurrentLineStart(p);
      } else {
        setVerandas([...verandas, { start: currentLineStart, end: p }]);
        setCurrentLineStart(null);
      }
    } else if (mode === 'second_veranda') {
      if (!currentLineStart) {
        setCurrentLineStart(p);
      } else {
        setVerandas([...verandas, { start: currentLineStart, end: p, isSecond: true }]);
        setCurrentLineStart(null);
      }
    } else if (mode === 'equipment') {
      let bIdx = buildings.findIndex(b => pointInPolygon(p, b));
      let finalP = p;
      if (bIdx >= 0) {
        finalP = snapToPolygonEdge(p, buildings[bIdx]);
      }

      // Unique site counter
      const uniqueCoords = new Set<string>();
      manualEquipments.forEach(e => uniqueCoords.add(`${Math.round(e.x)},${Math.round(e.y)}`));
      const nextSiteIdx = uniqueCoords.size + 1;

      const s1 = { id: `M-${nextSiteIdx}-A`, x: finalP.x, y: finalP.y, angle: 0, bIdx: bIdx >= 0 ? bIdx : undefined, isManual: true };
      const s2 = { id: `M-${nextSiteIdx}-B`, x: finalP.x, y: finalP.y, angle: 120, bIdx: bIdx >= 0 ? bIdx : undefined, isManual: true };
      const s3 = { id: `M-${nextSiteIdx}-C`, x: finalP.x, y: finalP.y, angle: 240, bIdx: bIdx >= 0 ? bIdx : undefined, isManual: true };

      setManualEquipments([...manualEquipments, s1, s2, s3]);
      setResult(null);
    } else if (mode === 'eraser') {
      // Priority 1: Eraser Equipment (remove individual sector clicked near base or icon, auto or manual)
      const currentRankResult = (result && result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
      // 기존 안테나(isExisting)는 우리 자산이 아니라 현황이므로 지우개 대상에서 제외한다
      const activeEquipments = (currentRankResult ? currentRankResult.equipments : (result ? result.equipments : [...existingAntennas, ...manualEquipments]))
        .filter(e => !e.isExisting);

      let closestEqId: string | null = null;
      let minEqDist = Infinity;
      activeEquipments.forEach((eq) => {
        const angleRad = (eq.angle - 90) * Math.PI / 180;
        const iconX = eq.x + Math.cos(angleRad) * 18;
        const iconY = eq.y + Math.sin(angleRad) * 18;
        const dBase = Math.sqrt((eq.x - p.x) ** 2 + (eq.y - p.y) ** 2);
        const dIcon = Math.sqrt((iconX - p.x) ** 2 + (iconY - p.y) ** 2);
        const d = Math.min(dBase, dIcon);
        if (d < 18 && d < minEqDist) {
          minEqDist = d;
          closestEqId = eq.id;
        }
      });

      if (closestEqId) {
        deleteEq(closestEqId);
        return;
      }

      // Priority 2: Eraser Verandas
      const vIdx = verandas.findIndex(v => distToSegment(p, v.start, v.end) < 10);
      if (vIdx >= 0) {
        setVerandas(verandas.filter((_, i) => i !== vIdx));
        setResult(null);
        return;
      }

      // Priority 3: Eraser Buildings
      const bIdx = buildings.findIndex(b => pointInPolygon(p, b));
      if (bIdx >= 0) {
        setBuildings(buildings.filter((_, i) => i !== bIdx));
        // Also remove any Manual Equipments strictly attached to this building index
        setManualEquipments(manualEquipments.filter(eq => eq.bIdx !== bIdx));
        setResult(null);
      }
    }
  };

  const handleCanvasRightClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (mode === 'building' && currentPolygon.length > 2) {
      setBuildings([...buildings, currentPolygon]);
      setCurrentPolygon([]);
    } else if (mode === 'building') {
      setCurrentPolygon([]);
    } else if (mode === 'veranda' || mode === 'second_veranda') {
      setCurrentLineStart(null);
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const currentPoint = {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom
    };
    setMousePos(currentPoint);
    const foundIdx = buildings.findIndex(poly => pointInPolygon(currentPoint, poly));
    setHoveredBuildingIdx(foundIdx);
  };

  const clearDrawing = () => {
    setSourceMoira(null);
    setBuildings([]);
    setVerandas([]); setConcreteWalls([]);
    setManualEquipments([]);
    setCurrentPolygon([]);
    setCurrentLineStart(null);
    setResult(null);
    setAiInsights(null);
    // 단지 경계·자 눈금도 함께 정리 — 안 지우면 리셋 후에도 캔버스에 잔재로 남는다.
    setAnalysisArea(null);
    setRulerLine(null);
  };

  // ==========================================================================
  // [DB 저장] 화면에서 교정한 건물 폴리곤을 원본 소스 JSON에 되돌려 쓴다.
  // --------------------------------------------------------------------------
  // Save Topology : 현재 세션 스냅샷을 rf_topology_project.json으로 브라우저 다운로드 (export)
  // DB 저장       : public/temps/<rapaKey>.json 자체를 교정 — 다음에 같은 RAPA Key를
  //                 다시 불러오면 교정된 폴리곤이 로드되고, LOS 배치도 같은 파일을 읽는다.
  // 최초 저장 시 원본은 서버가 public/temps/_backup/ 으로 1회 자동 백업한다.
  // ==========================================================================
  const handleSaveToDb = async () => {
    if (!sourceMoira || !selectedRapaKey) {
      showAppNotification("DB 저장은 RAPA Key로 불러온 단지에만 사용할 수 있습니다. 상단바에서 대상을 선택해 주세요.", "warning");
      return;
    }
    if (!geoMapping) {
      showAppNotification("좌표 매핑 정보가 없어 저장할 수 없습니다. 대상을 다시 불러와 주세요.", "warning");
      return;
    }

    const { data, summary } = mergeEditedBuildings(sourceMoira, buildings, geoMapping);
    const changed = summary.edited + summary.added + summary.removed;
    if (changed === 0) {
      showAppNotification("변경된 건물 폴리곤이 없습니다. (원본과 동일)", "info");
      return;
    }
    if (data.buildings.length === 0) {
      showAppNotification("모든 건물이 삭제된 상태로는 저장할 수 없습니다.", "warning");
      return;
    }

    const proceed = window.confirm(
      `[DB 저장] ${selectedRapaKey}\n\n` +
      `유지 ${summary.kept}동 / 수정 ${summary.edited}동 / 추가 ${summary.added}동 / 삭제 ${summary.removed}동\n` +
      `저장 후 건물 수: ${data.buildings.length}동\n\n` +
      `원본 JSON(public/temps/${selectedRapaKey}.json)을 덮어씁니다.\n` +
      `최초 저장 시 원본은 public/temps/_backup/ 에 자동 백업됩니다.\n\n진행할까요?`
    );
    if (!proceed) return;

    setIsSavingDb(true);
    try {
      const resp = await saveMoiraPolygonToCache(selectedRapaKey, data);
      if (!resp.ok) throw new Error(resp.error || "저장 실패");
      setSourceMoira(data); // 저장본을 새 기준 원본으로 갱신
      showAppNotification(
        `💾 DB 저장 완료: ${selectedRapaKey} · 유지 ${summary.kept} / 수정 ${summary.edited} / 추가 ${summary.added} / 삭제 ${summary.removed}` +
        (resp.backedUp ? " (원본 백업 생성됨)" : ""),
        "success"
      );
    } catch (err: any) {
      showAppNotification(`DB 저장 실패: ${err.message} — 개발 서버(server.ts)가 실행 중인지 확인해 주세요.`, "error");
    } finally {
      setIsSavingDb(false);
    }
  };

  // DB 저장으로 교정한 내용을 최초 원본으로 되돌린다.
  const handleRestoreDb = async () => {
    if (!selectedRapaKey) {
      showAppNotification("복원할 RAPA Key가 선택되지 않았습니다.", "warning");
      return;
    }
    const proceed = window.confirm(
      `[원본 복원] ${selectedRapaKey}\n\n` +
      `DB 저장으로 교정한 내용을 버리고 최초 원본(_backup)으로 되돌립니다.\n` +
      `복원 후 대상을 다시 불러와야 화면에 반영됩니다. 진행할까요?`
    );
    if (!proceed) return;
    setIsSavingDb(true);
    try {
      const resp = await restoreMoiraPolygonFromBackup(selectedRapaKey);
      if (!resp.ok) throw new Error(resp.error || "복원 실패");
      showAppNotification(`↩️ 원본 복원 완료: ${selectedRapaKey} — 상단바에서 대상을 다시 선택해 주세요.`, "success");
    } catch (err: any) {
      showAppNotification(`원본 복원 실패: ${err.message}`, "error");
    } finally {
      setIsSavingDb(false);
    }
  };

  // ==========================================================================
  // [단지 위치 보정] 형상 정합 자동 보정 + 수동 미세조정
  // --------------------------------------------------------------------------
  // 자동: VWorld 연속지적도 필지(지번형) / 용도지역·도로 사이 구역(블록형) 중 단지와 같은 모양을 찾아
  //       회전 0~360°·이동을 IoU 최대화로 맞춘다. 결과는 화면에 먼저 적용하고 '보정 저장'으로 JSON 반영.
  // 수동: 자동이 실패/애매할 때 최후 수단 — 화살표·회전 버튼으로 단지 전체를 옮긴 뒤 저장.
  // VWorld 키: 브라우저 설정값이 없으면 서버 .env(VWORLD_API_KEY)를 프록시가 주입('__SERVER__').
  // ==========================================================================
  // VWorld 프록시 경로: 로컬 개발 = server.ts(/api/vworld-proxy), 사내 배포(nginx 정적) = Flask(/vworld/proxy).
  // 둘 다 서버 환경변수의 VWORLD_API_KEY/VWORLD_API_DOMAIN을 주입한다 (docs/flask_vworld_proxy.md).
  const vworldProxyRef = useRef<'node' | 'flask' | null>(null);
  const detectVworldProxy = async (): Promise<'node' | 'flask' | null> => {
    if (vworldProxyRef.current) return vworldProxyRef.current;
    const tryJson = async (u: string) => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } };
    const node = await tryJson(getApiUrl('/api/vworld-key-status'));
    if (node?.serverKey) return (vworldProxyRef.current = 'node');
    const flask = await tryJson(getPyApiUrl('/vworld/status'));
    if (flask?.serverKey) return (vworldProxyRef.current = 'flask');
    return null;
  };
  const vworldProxyGet = async (url: string) => {
    const via = vworldProxyRef.current || 'node';
    const target = via === 'flask'
      ? getPyApiUrl(`/vworld/proxy?url=${encodeURIComponent(url)}`)
      : getApiUrl(`/api/vworld-proxy?url=${encodeURIComponent(url)}`);
    const resp = await fetch(target);
    return resp.json();
  };

  const reapplyGeoref = (next: MoiraComplexPolygonResult) => {
    const row = selectedAptRow;
    applyMoiraResult(next, row?.buildingName || row?.projectName || next.rapaKey, row?.lat ?? 0, row?.lng ?? 0, { silent: true, keepGeoref: true });
    setGeorefDirty(true);
  };

  const handleGeorefAuto = async () => {
    if (!sourceMoira || !selectedRapaKey) {
      showAppNotification('위치 보정은 RAPA Key로 불러온 단지에만 사용할 수 있습니다.', 'warning');
      return;
    }
    setGeorefBusy(true);
    setGeorefProposal(null);
    try {
      // 사내 배포(nginx 정적 서빙)에는 server.ts 프록시가 없다 → 로컬 개발 서버에서 보정 후 temps JSON을 배포하는 구조
      const via = await detectVworldProxy();
      if (!via && !vworldKey.trim()) {
        showAppNotification('VWorld 프록시를 찾지 못했습니다 — 로컬: .env VWORLD_API_KEY 후 npm run dev 재시작 / 사내: Flask /vworld/proxy 배포 필요.', 'warning');
        return;
      }
      const row = selectedAptRow;
      const prop = await proposeGeoref({
        data: sourceMoira,
        apt: row ? { lat: row.lat, lng: row.lng, address: row.address, raw: row.raw } : null,
        get: vworldProxyGet,
        key: vworldKey.trim() || '__SERVER__',
        domain: vworldDomain.trim(),
      });
      setGeorefProposal(prop);
      if (prop.best) setGeorefRefRings(prop.best.rings as [number, number][][]);
      const b = prop.best;
      showAppNotification(
        b ? `위치 보정안(${prop.confidence}): ${b.label} · IoU ${b.iou.toFixed(3)} · 이동 ${b.shiftM}m · 회전 ${b.rotDeg}° — ${prop.reason}`
          : `위치 보정 실패: ${prop.reason}`,
        prop.ok ? 'success' : 'warning'
      );
    } catch (err: any) {
      showAppNotification(`위치 보정 오류: ${err.message}`, 'error');
    } finally {
      setGeorefBusy(false);
    }
  };

  const handleGeorefApply = () => {
    const b = georefProposal?.best;
    if (!sourceMoira || !b) return;
    const next = applyGeoref(sourceMoira, { rotDeg: b.rotDeg, center: b.center }, {
      method: `shape-match(${b.source}: ${b.label})`,
      confidence: georefProposal!.confidence,
      anchor: `형상 정합 IoU ${b.iou} → 도심 (${b.center[1].toFixed(7)},${b.center[0].toFixed(7)}), 이동 ${b.shiftM}m / 회전 ${b.rotDeg}°`,
    });
    reapplyGeoref(next);
    setGeorefProposal({ ...georefProposal!, best: { ...b, rotDeg: 0, shiftM: 0 } });
  };

  const handleGeorefNudge = (dxM: number, dyM: number, rotDeg: number) => {
    if (!sourceMoira) return;
    const next = applyGeoref(sourceMoira, { rotDeg, dxM, dyM }, { method: 'manual', confidence: 'manual' });
    reapplyGeoref(next);
  };

  const handleGeorefSave = async () => {
    if (!sourceMoira || !selectedRapaKey) return;
    const proceed = window.confirm(
      `[위치 보정 저장] ${selectedRapaKey}\n\n화면에 적용한 단지·건물 위치/방위를 원본 JSON(public/temps/${selectedRapaKey}.json)에 저장합니다.\n` +
      `최초 저장 시 원본은 public/temps/_backup/ 에 자동 백업됩니다. 진행할까요?`
    );
    if (!proceed) return;
    setIsSavingDb(true);
    try {
      const resp = await saveMoiraPolygonToCache(selectedRapaKey, sourceMoira);
      if (!resp.ok) throw new Error(resp.error || '저장 실패');
      setGeorefDirty(false);
      showAppNotification(`📍 위치 보정 저장 완료: ${selectedRapaKey}` + (resp.backedUp ? ' (원본 백업 생성됨)' : ''), 'success');
    } catch (err: any) {
      showAppNotification(`위치 보정 저장 실패: ${err.message}`, 'error');
    } finally {
      setIsSavingDb(false);
    }
  };

  const handleSaveTopology = () => {
    const topologyData = {
      buildings,
      verandas,
      manualEquipments,
      imageSrc,
      canvasSize: canvasSize,
      geoMapping
    };
    const blob = new Blob([JSON.stringify(topologyData, null, 2)], { type: "application/json" });
    saveAs(blob, "rf_topology_project.json");
  };

  const handleLoadTopology = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        setSourceMoira(null); // export 파일 복원 — 원본 JSON과의 연결은 끊긴 상태
        if (json.buildings) setBuildings(json.buildings);
        if (json.verandas) setVerandas(json.verandas);
        if (json.manualEquipments) setManualEquipments(json.manualEquipments);
        if (json.geoMapping) setGeoMapping(json.geoMapping);
        else setGeoMapping(null);

        let targetWidth = 1000;
        let targetHeight = 1000;
        if (json.canvasSize) {
          targetWidth = json.canvasSize.width;
          targetHeight = json.canvasSize.height;
        } else {
          // Fallback to finding max bounds if no canvas size was saved
          let maxX = 1000; let maxY = 1000;
          (json.buildings || []).forEach((poly: any) => poly.forEach((p: any) => {
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
          }));
          (json.verandas || []).forEach((v: any) => {
            if (v.start.x > maxX) maxX = v.start.x;
            if (v.start.y > maxY) maxY = v.start.y;
            if (v.end.x > maxX) maxX = v.end.x;
            if (v.end.y > maxY) maxY = v.end.y;
          });
          targetWidth = Math.max(1000, maxX + 50);
          targetHeight = Math.max(1000, maxY + 50);
        }

        if (json.imageSrc) {
          const img = new Image();
          img.onload = () => {
            imageRef.current = img;
            setImageSrc(json.imageSrc);

            // Prioritize image size over saved canvas size to prevent mismatch
            const finalWidth = Math.max(targetWidth, img.width);
            const finalHeight = Math.max(targetHeight, img.height);
            setCanvasSize({ width: finalWidth, height: finalHeight });
            if (canvasRef.current) {
              canvasRef.current.width = finalWidth;
              canvasRef.current.height = finalHeight;
            }
          };
          img.onerror = () => {
            console.warn("Failed to load image from saved topology (likely an expired blob URL). Continuing without image.");
            setImageSrc(null);
            imageRef.current = null;
            // Proceed with just the coordinates
            setCanvasSize({ width: targetWidth, height: targetHeight });
            if (canvasRef.current) {
              canvasRef.current.width = targetWidth;
              canvasRef.current.height = targetHeight;
            }
          };
          img.src = json.imageSrc;
        } else {
          setImageSrc(null);
          setCanvasSize({ width: targetWidth, height: targetHeight });
          if (canvasRef.current) {
            canvasRef.current.width = targetWidth;
            canvasRef.current.height = targetHeight;
          }
        }

        setResult(null);
        e.target.value = ''; // Reset input
      } catch (err) {
        console.error("Failed to parse topology JSON", err);
        showAppNotification("올바르지 않은 토폴로지 JSON 파일 구조입니다.", "error");
      }
    };
    reader.readAsText(file);
  };

  const handleVWorldSearch = async () => {
    if (!vworldKey.trim()) {
      showAppNotification("브이월드 인증키를 입력해주세요.", "warning");
      return;
    }
    if (!searchQuery.trim()) {
      showAppNotification("검색어를 입력해주세요. (예: 은마아파트, 반포자이)", "warning");
      return;
    }

    setSearchStatus('searching');
    setSearchCandidates([]);
    setErrorMessage('');

    try {
      localStorage.setItem('vworld_api_key', vworldKey.trim());
      localStorage.setItem('vworld_api_domain', vworldDomain.trim());
      localStorage.setItem('vworld_request_mode', vworldRequestMode);
      const encodeQuery = encodeURIComponent(searchQuery);
      // VWorld Search API 2.0 (place type search)
      const url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=15&query=${encodeQuery}&type=place&format=json&key=${vworldKey.trim()}&domain=${encodeURIComponent(vworldDomain.trim())}`;

      let data: any;

      if (vworldRequestMode === 'direct') {
        data = await fetchJSONP(url);
      } else {
        const targetFetchUrl = getApiUrl(`/api/vworld-proxy?url=${encodeURIComponent(url)}`);
        const res = await fetch(targetFetchUrl);
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch (err) {
          throw new Error(`서버 프록시 응답 파싱 실패. 실제 서버 응답: ${text.substring(0, 300)}`);
        }
      }

      if (data.response && data.response.status === 'OK' && data.response.result) {
        let items = data.response.result.items || [];
        if (!Array.isArray(items)) {
          items = [items];
        }

        // 아파트 단지 단위 중복 제거 (주소가 동일한 항목은 100% 동일 단지로 완벽 그룹화)
        const uniqueMap = new Map<string, any>();
        items.forEach((item: any) => {
          const rawTitle = stripHtml(item.title || '');
          const coreName = extractCoreApartmentName(rawTitle).toLowerCase().replace(/[\s\-_]/g, '');
          const addr = (item.address?.road || item.address?.parcel || '').toLowerCase().replace(/[\s\-_]/g, '');
          // 주소가 존재하면 주소를 1순위 그룹키로 사용, 없으면 정화된 단지명 사용
          const groupKey = addr ? addr : (coreName || rawTitle.toLowerCase().replace(/[\s\-_]/g, ''));
          if (!uniqueMap.has(groupKey)) {
            uniqueMap.set(groupKey, item);
          }
        });
        const deduplicatedItems = Array.from(uniqueMap.values());

        setSearchCandidates(deduplicatedItems);
        setSearchStatus('success');
      } else {
        const status = data.response?.status || 'UNKNOWN';
        const errorMsg = data.response?.error || '검색 결과가 없거나 인증키 및 도메인이 올바르지 않습니다.';
        if (status === 'NOT_FOUND' || status === 'EMPTY') {
          setSearchStatus('no_result');
        } else {
          setSearchStatus('error');
          let extraHelp = '';
          if (vworldRequestMode === 'proxy') {
            extraHelp = ' (구글 클라우드 서버IP 차단 예방을 위해 "내 브라우저에서 직접 호출" 모드로 변경해 보시는 것을 권장합니다.)';
          }
          setErrorMessage(`에러: ${status} - ${errorMsg}${extraHelp}`);
        }
      }
    } catch (err: any) {
      console.error(err);
      setSearchStatus('error');
      let extraHelp = '';
      if (vworldRequestMode === 'proxy') {
        extraHelp = ' [구글 클라우드 서버 IP 대역 대개 차단 때문일 수 있으므로 "내 브라우저에서 직접 호출"을 권장합니다.]';
      }
      setErrorMessage(`네트워크 오류: ${err.message}.${extraHelp} CORS 정책 또는 브이월드에 등록된 도메인 설정을 확인해 주세요.`);
    }
  };

  // 오픈 지도 타일 (CartoDB Positron / Esri World Imagery / Hybrid) 고정밀 매핑 렌더러
  useEffect(() => {
    // 타일 라우트가 실제로 이미지를 주는지 한 번만 확인 (서버 미재시작·키 없음 대비 → 기존 타일 유지)
    let alive = true;
    fetch(getApiUrl('/api/vworld-tile/Base/15/12694/27974'))
      .then(r => { if (alive) setVworldTiles(r.ok && (r.headers.get('content-type') || '').startsWith('image/')); })
      .catch(() => { if (alive) setVworldTiles(false); });
    return () => { alive = false; };
  }, []);

  const loadOpenMapBackground = async (mapping: any, tileType: 'Base' | 'Satellite' | 'Hybrid' | 'None') => {
    if (tileType === 'None' || !mapping) {
      setImageSrc(null);
      imageRef.current = null;
      return;
    }

    try {
      const cWidth = mapping.cWidth || 1200;
      const cHeight = mapping.cHeight || 800;

      const canvasMinLon = mapping.minLon - mapping.lonRange * 0.125;
      const canvasMaxLon = mapping.minLon + mapping.lonRange * 1.125;
      const canvasMinLat = mapping.minLat - mapping.latRange * 0.125;
      const canvasMaxLat = mapping.minLat + mapping.latRange * 1.125;

      // Calculate optimal Web Mercator Zoom level (16 ~ 18)
      const latRad = ((canvasMinLat + canvasMaxLat) / 2) * (Math.PI / 180);
      const lonDiff = Math.abs(canvasMaxLon - canvasMinLon);
      let zoom = Math.floor(Math.log2(360 / (lonDiff || 0.001))) + 3;
      zoom = Math.max(15, Math.min(18, zoom));

      const lon2tile = (lon: number, z: number) => (lon + 180) / 360 * Math.pow(2, z);
      const lat2tile = (lat: number, z: number) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z);

      const minX = lon2tile(canvasMinLon, zoom);
      const maxX = lon2tile(canvasMaxLon, zoom);
      const minY = lat2tile(canvasMaxLat, zoom); // Tile Y is inverted (top to bottom)
      const maxY = lat2tile(canvasMinLat, zoom);

      const tileMinX = Math.floor(minX);
      const tileMaxX = Math.floor(maxX);
      const tileMinY = Math.floor(minY);
      const tileMaxY = Math.floor(maxY);

      const offCanvas = document.createElement('canvas');
      offCanvas.width = cWidth;
      offCanvas.height = cHeight;
      const ctx = offCanvas.getContext('2d');
      if (!ctx) return;

      const totalTileX = tileMaxX - tileMinX + 1;
      const totalTileY = tileMaxY - tileMinY + 1;

      // Select high-res tile servers (CORS enabled, no API keys needed, 100% uptime)
      const getBaseTileUrl = (x: number, y: number, z: number) => {
        if (vworldTiles) {
          // VWorld WMTS (서버가 키 주입) — 국내 도로·지명·항공사진, 워터마크 없음
          return getApiUrl(`/api/vworld-tile/${tileType === 'Base' ? 'Base' : 'Satellite'}/${z}/${y}/${x}`);
        }
        if (tileType === 'Base') {
          return `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;
        } else {
          // Satellite & Hybrid use Esri World Imagery (High-res Global/Korea imagery)
          return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
        }
      };

      const getLabelTileUrl = (x: number, y: number, z: number) => {
        if (tileType === 'Hybrid') {
          return vworldTiles
            ? getApiUrl(`/api/vworld-tile/Hybrid/${z}/${y}/${x}`)
            : `https://basemaps.cartocdn.com/rastertiles/voyager_only_labels/${z}/${x}/${y}.png`;
        }
        return null;
      };

      const promises: Promise<void>[] = [];

      for (let tx = tileMinX; tx <= tileMaxX; tx++) {
        for (let ty = tileMinY; ty <= tileMaxY; ty++) {
          const p = new Promise<void>((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              // Calculate exact pixel position inside 1200x800 canvas
              const pixelX1 = ((tx - minX) / (maxX - minX)) * cWidth;
              const pixelX2 = ((tx + 1 - minX) / (maxX - minX)) * cWidth;
              const pixelY1 = ((ty - minY) / (maxY - minY)) * cHeight;
              const pixelY2 = ((ty + 1 - minY) / (maxY - minY)) * cHeight;

              ctx.drawImage(img, pixelX1, pixelY1, pixelX2 - pixelX1, pixelY2 - pixelY1);

              const labelUrl = getLabelTileUrl(tx, ty, zoom);
              if (labelUrl) {
                const labelImg = new Image();
                labelImg.crossOrigin = 'anonymous';
                labelImg.onload = () => {
                  ctx.drawImage(labelImg, pixelX1, pixelY1, pixelX2 - pixelX1, pixelY2 - pixelY1);
                  resolve();
                };
                labelImg.onerror = () => resolve();
                labelImg.src = labelUrl;
              } else {
                resolve();
              }
            };
            img.onerror = () => resolve();
            img.src = getBaseTileUrl(tx, ty, zoom);
          });
          promises.push(p);
        }
      }

      await Promise.all(promises);

      const dataUrl = offCanvas.toDataURL('image/png');
      const loadedImg = new Image();
      loadedImg.onload = () => {
        imageRef.current = loadedImg;
        setImageSrc(dataUrl);
        const tileLabel = tileType === 'Satellite' ? '위성 지도 (Esri)' : tileType === 'Hybrid' ? '혼합 지도 (Esri+Labels)' : '일반 지도 (CartoDB)';
        showAppNotification(`배경 지도(${tileLabel}) 100% 로드 완료!`, 'success');
      };
      loadedImg.src = dataUrl;

    } catch (err: any) {
      console.warn("[OpenMap] 배경 지도 로드 실패:", err);
      showAppNotification(`배경 지도 로드 오류: ${err.message}`, 'error');
    }
  };



  const handleSelectCandidate = async (candidate: any) => {
    if (!candidate.point || !candidate.point.x || !candidate.point.y) {
      showAppNotification("선택한 객체에 좌표 정보가 없습니다.", "warning");
      return;
    }

    setIsFetchingPolygons(true);
    const lon = Number(candidate.point.x);
    const lat = Number(candidate.point.y);
    const cleanTitle = stripHtml(candidate.title || '');
    const apartmentName = extractCoreApartmentName(cleanTitle);

    // 1단계: VWorld 공동주택단지 경계 레이어 (LT_C_AJAGMBOUND) 조회
    const fetchComplexBoundary = async (): Promise<{ lon: number; lat: number }[] | null> => {
      // 대단지 아파트 전체 테두리를 커버하도록 사방 ~500m Box 영역 설정
      const searchBox = `BOX(${lon - 0.005},${lat - 0.004},${lon + 0.005},${lat + 0.004})`;
      const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_AJAGMBOUND&key=${vworldKey.trim()}&format=json&crs=EPSG:4326&size=10&geomFilter=${searchBox}&domain=${encodeURIComponent(vworldDomain.trim())}`;

      try {
        let resp: any;
        if (vworldRequestMode === 'direct') {
          resp = await fetchJSONP(url);
        } else {
          const targetFetchUrl = getApiUrl(`/api/vworld-proxy?url=${encodeURIComponent(url)}`);
          const res = await fetch(targetFetchUrl);
          resp = JSON.parse(await res.text());
        }
        if (resp.response?.status === 'OK' && resp.response?.result?.featureCollection?.features?.length) {
          const features = resp.response.result.featureCollection.features;
          // 첫 번째 또는 포함 관계 단지 경계 폴리곤 추출
          const targetGeom = features[0].geometry;
          if (targetGeom.type === 'Polygon') {
            return targetGeom.coordinates[0].map((c: number[]) => ({ lon: c[0], lat: c[1] }));
          } else if (targetGeom.type === 'MultiPolygon') {
            return targetGeom.coordinates[0][0].map((c: number[]) => ({ lon: c[0], lat: c[1] }));
          }
        }
      } catch (e) {
        console.warn("[VWorld] 단지 경계 레이어(LT_C_AJAGMBOUND) 조회 중 오류/무응답:", e);
      }
      return null;
    };

    try {
      localStorage.setItem('use_name_filter', String(useNameFilter));

      // 단지 경계 폴리곤 (위경도 좌표 배열)
      const complexCoords = await fetchComplexBoundary();

      let minLon: number, maxLon: number, minLat: number, maxLat: number;

      if (complexCoords && complexCoords.length >= 3) {
        // 단지 경계 획득 성공 -> 단지 BBOX + 150m 버퍼 확장 (위도 +0.0016, 경도 +0.002)
        let cMinLon = Infinity, cMaxLon = -Infinity, cMinLat = Infinity, cMaxLat = -Infinity;
        complexCoords.forEach(p => {
          cMinLon = Math.min(cMinLon, p.lon);
          cMaxLon = Math.max(cMaxLon, p.lon);
          cMinLat = Math.min(cMinLat, p.lat);
          cMaxLat = Math.max(cMaxLat, p.lat);
        });
        const bufferLon = 0.0022; // ~180m 경도 버퍼
        const bufferLat = 0.0018; // ~180m 위도 버퍼
        minLon = cMinLon - bufferLon;
        maxLon = cMaxLon + bufferLon;
        minLat = cMinLat - bufferLat;
        maxLat = cMaxLat + bufferLat;
      } else {
        // 단지 경계 미발견 -> 클릭 지점 기준 약 200m 기본 사각형 버퍼 지정
        minLon = lon - 0.0025;
        maxLon = lon + 0.0025;
        minLat = lat - 0.002;
        maxLat = lat + 0.002;
      }

      const geomFilter = `BOX(${minLon},${minLat},${maxLon},${maxLat})`;

      // VWorld GetFeature 건물 데이터 쿼리 (대단지 21개동 전수 수집을 위해 size=1000 확장)
      const fetchBuildingsData = async () => {
        const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=${searchLayer}&key=${vworldKey.trim()}&format=json&crs=EPSG:4326&size=1000&geomFilter=${geomFilter}&domain=${encodeURIComponent(vworldDomain.trim())}`;
        if (vworldRequestMode === 'direct') {
          return await fetchJSONP(url);
        } else {
          const targetFetchUrl = getApiUrl(`/api/vworld-proxy?url=${encodeURIComponent(url)}`);
          const res = await fetch(targetFetchUrl);
          const text = await res.text();
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(`서버 프록시 에러: ${text.substring(0, 150)}`);
          }
        }
      };

      let data: any = await fetchBuildingsData();

      if (data.response && data.response.status === 'OK' && data.response.result) {
        let features = data.response.result.featureCollection?.features || [];

        // 단지명 필터(useNameFilter)가 ON인 경우:
        // 1) 건물명 속성 매칭
        // 2) [보상 처리]: 브이월드 DB 건물명 속성 누락 시, 단지 경계(complexCoords) 내부 위치 건물 100% 자동 포함!
        if (useNameFilter && apartmentName && features.length > 0) {
          const filteredFeatures = features.filter((f: any) => {
            const buldNm = getBuildingNameFromProperties(f.properties || {});
            if (buldNm.includes(apartmentName) || apartmentName.includes(extractCoreApartmentName(buldNm))) {
              return true;
            }
            // 속성 누락 보상: 단지 경계 내부 건물 판정
            if (complexCoords && complexCoords.length >= 3) {
              let cx = 0, cy = 0, ptCount = 0;
              const coords = f.geometry?.type === 'Polygon' ? f.geometry?.coordinates?.[0] : f.geometry?.coordinates?.[0]?.[0];
              if (coords && Array.isArray(coords)) {
                coords.forEach((c: number[]) => { cx += c[0]; cy += c[1]; ptCount++; });
                if (ptCount > 0) {
                  cx /= ptCount; cy /= ptCount;
                  if (pointInPolygon({ x: cx, y: cy }, complexCoords.map(p => ({ x: p.lon, y: p.lat })))) {
                    return true;
                  }
                }
              }
            }
            return false;
          });
          if (filteredFeatures.length > 0) {
            features = filteredFeatures;
          }
        }

        let localMinLon = Infinity, localMinLat = Infinity, localMaxLon = -Infinity, localMaxLat = -Infinity;

        features.forEach((f: any) => {
          if (f.geometry && f.geometry.type === 'Polygon') {
            f.geometry.coordinates[0].forEach((coord: number[]) => {
              localMinLon = Math.min(localMinLon, coord[0]);
              localMinLat = Math.min(localMinLat, coord[1]);
              localMaxLon = Math.max(localMaxLon, coord[0]);
              localMaxLat = Math.max(localMaxLat, coord[1]);
            });
          } else if (f.geometry && f.geometry.type === 'MultiPolygon') {
            f.geometry.coordinates.forEach((poly: number[][][]) => {
              poly[0].forEach((coord: number[]) => {
                localMinLon = Math.min(localMinLon, coord[0]);
                localMinLat = Math.min(localMinLat, coord[1]);
                localMaxLon = Math.max(localMaxLon, coord[0]);
                localMaxLat = Math.max(localMaxLat, coord[1]);
              });
            });
          }
        });

        // 단지 경계 좌표도 BBOX 연산에 포함
        if (complexCoords) {
          complexCoords.forEach(p => {
            localMinLon = Math.min(localMinLon, p.lon);
            localMinLat = Math.min(localMinLat, p.lat);
            localMaxLon = Math.max(localMaxLon, p.lon);
            localMaxLat = Math.max(localMaxLat, p.lat);
          });
        }

        if (localMinLon === Infinity) {
          throw new Error("가져온 건물 폴리곤에 올바른 공간 좌표 데이터가 포함되어 있지 않습니다.");
        }

        // 투영 등방화 후의 범위로 이하 캔버스 변환을 수행 (가로=세로 축척)
        const sqMapping = fitIsotropicMapping({
          minLon: localMinLon,
          minLat: localMinLat,
          lonRange: (localMaxLon - localMinLon) || 0.0001,
          latRange: (localMaxLat - localMinLat) || 0.0001,
        });
        localMinLon = sqMapping.minLon;
        localMinLat = sqMapping.minLat;
        const lonRange = sqMapping.lonRange;
        const latRange = sqMapping.latRange;
        const cWidth = sqMapping.cWidth, cHeight = sqMapping.cHeight;

        const parsedBuildings: Polygon[] = [];
        features.forEach((f: any) => {
          if (f.geometry && f.geometry.type === 'Polygon') {
            const poly = f.geometry.coordinates[0].map((coord: number[]) => {
              const x = ((coord[0] - localMinLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
              const y = cHeight - (((coord[1] - localMinLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1));
              return { x, y };
            });
            parsedBuildings.push(poly);
          } else if (f.geometry && f.geometry.type === 'MultiPolygon') {
            f.geometry.coordinates.forEach((multiPoly: number[][][]) => {
              const poly = multiPoly[0].map((coord: number[]) => {
                const x = ((coord[0] - localMinLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
                const y = cHeight - (((coord[1] - localMinLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1));
                return { x, y };
              });
              parsedBuildings.push(poly);
            });
          }
        });

        // 단지 경계 폴리곤이 있으면 캔버스 좌표계로 매핑하여 analysisArea로 자동 설정!
        if (complexCoords && complexCoords.length >= 3) {
          const mappedComplexArea: Point[] = complexCoords.map(p => {
            const x = ((p.lon - localMinLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
            const y = cHeight - (((p.lat - localMinLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1));
            return { x, y };
          });
          setAnalysisArea(mappedComplexArea);
        } else {
          setAnalysisArea(null);
        }

        const mapping = {
          minLon: localMinLon,
          minLat: localMinLat,
          lonRange,
          latRange,
          cWidth,
          cHeight
        };

        setCanvasSize({ width: cWidth, height: cHeight });
        setBuildings(parsedBuildings);
        setVerandas([]); setConcreteWalls([]);
        setManualEquipments([]);
        setResult(null);
        setMode('idle');
        setGeoMapping(mapping);

        if (canvasRef.current) {
          canvasRef.current.width = cWidth;
          canvasRef.current.height = cHeight;
        }

        // Fetch background map tile image matching canvas geometry BBOX
        if (mapTileType !== 'None') {
          loadOpenMapBackground(mapping, mapTileType);
        } else {
          setImageSrc(null);
          imageRef.current = null;
        }

        const boundaryMsg = complexCoords ? "🏢 아파트 단지 경계(LT_C_AJAGMBOUND) 및 150m 주변 건물" : "150m 주변 건물";
        showAppNotification(`성공적으로 ${boundaryMsg} 폴리곤(${parsedBuildings.length}개) 및 지도를 가져왔습니다!`, "success");
        applyAutoScaleFromMapping(mapping);
      } else {
        const errorMsg = extractVworldErrorMessage(data.response?.error) || '건물 데이터를 가져오지 못했습니다. API 제한량 또는 인증키 설정을 확인하세요.';
        showAppNotification(`인식 에러: ${errorMsg}`, "error");
      }
    } catch (err: any) {
      console.error(err);
      showAppNotification(`폴리곤 로드에 실패했습니다: ${err.message}`, "error");
    } finally {
      setIsFetchingPolygons(false);
    }
  };

  // RAPA Key(대상리스트) 선택 → 위경도가 단지 폴리곤(LT_C_AJAGMBOUND)에 속하는지 조회 후
  // 그 안의 건물(LT_C_SPBD) 폴리곤을 불러온다. DB_structure.pdf §3-2/3-4 공간조인과 동일한 흐름을
  // RAPA Key(대상리스트) 선택 → 단지/건물 폴리곤 확보. 우선순위 (2026-08-14 캐시 우선으로 변경):
  // ① 배치 캐시(public/complex_polygons.json) — 있으면 즉시 사용, 실시간 쿼리는 아예 생략 (선택 반응속도 우선)
  // ② 캐시에 해당 키가 없을 때만 Athena 실시간 조회(/api/moira-polygon) — 사내망 전용
  // 위 둘 다 실패해도(또는 폴리곤이 하나도 안 매칭돼도) 지도 자체는 대상 위경도 기준으로 항상 띄운다.
  // (VWorld는 더 이상 단지/건물 폴리곤 소스로 쓰지 않음 — 2026-08-13 확정)
  const handleSelectRapaKey = async (rapaKey: string) => {
    setSelectedRapaKey(rapaKey);
    if (!rapaKey) return;
    const row = aptList.find(r => r.rapaKey === rapaKey);
    if (!row) {
      showAppNotification(`RAPA Key(${rapaKey})에 해당하는 대상을 찾을 수 없습니다.`, 'warning');
      return;
    }
    setSearchQuery(row.buildingName || row.projectName);
    setActivePanel('location');
    const apartmentName = row.buildingName || row.projectName;

    // ① [1순위] temps/ 또는 polygons/ 분할 캐시 파일 확인
    let cached = await fetchMoiraPolygonFromCache(rapaKey);
    if (!cached && moiraBatchCache?.targets?.[rapaKey]) {
      cached = moiraBatchCache.targets[rapaKey];
    }

    if (cached) {
      const bSummary = (cached.buildings || []).map((b: any) => ({
        name: b.bld_nm || '명칭미상',
        floors: b.floors_above ? `${b.floors_above}층` : '-',
        height: b.height ? `${b.height}m` : '-',
      }));

      setShowMoiraDebugModal(true);
      setMoiraDebugInfo({
        rapaKey,
        apartmentName,
        lat: row.lat,
        lng: row.lng,
        timestamp: new Date().toLocaleTimeString(),
        liveStatus: 'skipped',
        httpStatus: 200,
        cacheFound: true,
        finalSource: 'athena-cache',
        complexFound: Boolean(cached.complex),
        complexId: cached.complex?.bld_cplx_inf_id,
        complexSclNm: cached.complex?.cplx_scl_nm,
        buildingCount: cached.buildings?.length || 0,
        buildingSource: cached.buildingSource || 'complex_polygon',
        buildingsSummary: bSummary,
        rawResponse: cached,
      });

      setLastMoiraSource('athena-cache');
      applyMoiraResult(cached, apartmentName, row.lat, row.lng);
      showAppNotification(`배치 캐시(temps) 로드 성공 (${apartmentName}): 건물 ${cached.buildings?.length || 0}개`, 'success');
      if (hasConduitBuilding(row)) {
        showAppNotification(`관로동 정보 있음: ${row.conduitBuilding} — 현재는 정보 표시만 되며, 관로동 한정 배치 로직은 개발 예정입니다.`, 'info');
      }
      return;
    }

    // 디버그 팝업 초기화 및 오픈
    setShowMoiraDebugModal(true);
    setMoiraDebugInfo({
      rapaKey,
      apartmentName,
      lat: row.lat,
      lng: row.lng,
      timestamp: new Date().toLocaleTimeString(),
      liveStatus: 'loading',
      cacheFound: false,
      finalSource: 'none',
      complexFound: false,
      buildingCount: 0,
    });

    // ② 캐시에 없을 때만 Athena 실시간 쿼리
    setIsFetchingPolygons(true);
    let liveResult: any = null;
    try {
      const resp = await fetchMoiraPolygonLiveDetailed(rapaKey, row.lat, row.lng);
      if (resp.ok && resp.data) {
        liveResult = resp.data;
        const bSummary = (liveResult.buildings || []).map((b: any) => ({
          name: b.bld_nm || '명칭미상',
          floors: b.floors_above ? `${b.floors_above}층` : '-',
          height: b.height ? `${b.height}m` : '-',
        }));

        setMoiraDebugInfo({
          rapaKey,
          apartmentName,
          lat: row.lat,
          lng: row.lng,
          timestamp: new Date().toLocaleTimeString(),
          liveStatus: 'success',
          httpStatus: resp.status,
          cacheFound: Boolean(moiraBatchCache?.targets?.[rapaKey]),
          finalSource: 'athena-live',
          complexFound: Boolean(liveResult.complex),
          complexId: liveResult.complex?.bld_cplx_inf_id,
          complexSclNm: liveResult.complex?.cplx_scl_nm,
          buildingCount: liveResult.buildings?.length || 0,
          buildingSource: liveResult.buildingSource,
          buildingsSummary: bSummary,
          rawResponse: resp.rawJson || liveResult,
        });

        setLastMoiraSource('athena-live');
        applyMoiraResult(liveResult, apartmentName, row.lat, row.lng);
        if (hasConduitBuilding(row)) {
          showAppNotification(`관로동 정보 있음: ${row.conduitBuilding} — 현재는 정보 표시만 되며, 관로동 한정 배치 로직은 개발 예정입니다.`, 'info');
        }
        return;
      } else {
        // 실시간 조회 실패 응답
        setMoiraDebugInfo({
          rapaKey,
          apartmentName,
          lat: row.lat,
          lng: row.lng,
          timestamp: new Date().toLocaleTimeString(),
          liveStatus: 'failed',
          httpStatus: resp.status,
          liveError: resp.error || 'Athena 쿼리 실패',
          cacheFound: Boolean(moiraBatchCache?.targets?.[rapaKey]),
          finalSource: 'none',
          complexFound: false,
          buildingCount: 0,
          rawResponse: resp.rawJson || { error: resp.error },
        });
      }
    } catch (liveErr: any) {
      console.warn(`[MOIRA] Athena 실시간 조회 실패 (${rapaKey}):`, liveErr.message);
      setMoiraDebugInfo(prev => prev ? {
        ...prev,
        liveStatus: 'failed',
        liveError: liveErr.message,
        rawResponse: { error: liveErr.message },
      } : null);
    } finally {
      setIsFetchingPolygons(false);
    }

    // 캐시에도 없고 Athena 실시간도 실패 — 폴리곤 없이 지도만 대상 위경도 기준으로 띄운다.
    setLastMoiraSource(null);
    centerMapOnPoint(row.lat, row.lng, apartmentName, 'MOIRA Athena 조회에 실패했습니다 (사내망/idcube_hive_connector 접속 상태 확인 필요)');
  };

  // 필터(본부/시도/읍면동)에 맞는 apt_list 서브셋 — cascading: 본부 → 시도 → 읍면동
  const aptListFilteredByHq = filterHq ? aptList.filter(r => r.hq === filterHq) : aptList;
  const aptListFilteredBySido = filterSido ? aptListFilteredByHq.filter(r => r.sido === filterSido) : aptListFilteredByHq;
  const aptListFilteredByEmd = filterEmd ? aptListFilteredBySido.filter(r => r.emd === filterEmd) : aptListFilteredBySido;
  // 폴리곤 필터: 전체('all') | 미확보만('no_polygon') | 미확보 제외('has_polygon')
  const aptListFinal = polygonFilter === 'no_polygon'
    ? aptListFilteredByEmd.filter(r => !(polygonStatus[r.rapaKey]?.hasComplex))
    : polygonFilter === 'has_polygon'
    ? aptListFilteredByEmd.filter(r => Boolean(polygonStatus[r.rapaKey]?.hasComplex))
    : aptListFilteredByEmd;

  const uniqueHqOptions = Array.from(new Set(aptList.map(r => r.hq))).filter(Boolean).sort();
  const uniqueSidoOptions = Array.from(new Set(aptListFilteredByHq.map(r => r.sido))).filter(Boolean).sort();
  const uniqueEmdOptions = Array.from(new Set(aptListFilteredBySido.map(r => r.emd))).filter(Boolean).sort();

  const selectedAptRow = aptList.find(r => r.rapaKey === selectedRapaKey) || null;

  // 지역 필터 요약 — 버튼에 표시할 라벨과 활성 개수
  const regionFilterCount = [filterHq, filterSido, filterEmd].filter(Boolean).length;
  const regionFilterLabel = filterEmd || filterSido || filterHq || '지역 필터';

  // 팝오버 바깥 클릭 시 닫기
  useEffect(() => {
    if (!showRegionFilter) return;
    const onDown = (e: MouseEvent) => {
      if (!regionFilterRef.current?.contains(e.target as Node)) setShowRegionFilter(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showRegionFilter]);

  // [RAPA Key 부분검색] 키 일부(예: '2206-3699') 또는 단지명으로 매칭. 상위 30건.
  const rapaSearchResults = React.useMemo(() => {
    const q = rapaSearch.trim().toLowerCase();
    if (!q) return [];
    return aptList
      .filter(r => r.rapaKey.toLowerCase().includes(q) || (r.buildingName || '').toLowerCase().includes(q))
      .slice(0, 30);
  }, [rapaSearch, aptList]);

  // 드롭다운은 .shell-topbar-row(overflow-y:hidden)에 잘리므로 body 포털 + fixed 위치로 띄운다.
  const rapaSearchBoxRef = useRef<HTMLDivElement>(null);
  const [rapaMenuRect, setRapaMenuRect] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!showRapaSearch) return;
    const measure = () => {
      const el = rapaSearchBoxRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRapaMenuRect({ top: r.bottom + 4, left: r.left });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [showRapaSearch]);

  // 검색어에 해당하는 temps 캐시 존재/교정 여부를 배지로 표시하기 위해 서버에 조회 (실패해도 무시)
  useEffect(() => {
    const q = rapaSearch.trim();
    if (!q) return;
    const timer = window.setTimeout(() => {
      listCachedRapaKeys(q).then(items => {
        if (!items.length) return;
        setCachedKeyInfo(prev => {
          const next = { ...prev };
          items.forEach(it => { next[it.rapaKey] = it; });
          return next;
        });
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [rapaSearch]);

  const handleExportGeoJSON = () => {
    if (buildings.length === 0 && verandas.length === 0) {
      showAppNotification("내보낼 데이터(건물 또는 베란다)가 없습니다.", "warning");
      return;
    }

    const features: any[] = [];

    // Fallback if no geoMapping coordinates are set
    const mapping = geoMapping || {
      minLon: 127.0276,
      minLat: 37.4979,
      lonRange: 0.005,
      latRange: 0.004,
      cWidth: canvasSize.width,
      cHeight: canvasSize.height
    };

    const canvasToLonLat = (p: Point) => {
      const lon = mapping.minLon + mapping.lonRange * ((p.x - mapping.cWidth * 0.1) / (mapping.cWidth * 0.8));
      const lat = mapping.minLat + mapping.latRange * ((mapping.cHeight - p.y - mapping.cHeight * 0.1) / (mapping.cHeight * 0.8));
      return [lon, lat];
    };

    // 1. Export Buildings as GeoJSON Polygon Features
    buildings.forEach((poly, idx) => {
      if (poly.length === 0) return;
      const coords = poly.map(canvasToLonLat);
      // Close coordinates polygon loop
      if (coords.length > 0 && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
        coords.push([coords[0][0], coords[0][1]]);
      }
      features.push({
        type: "Feature",
        properties: {
          id: `building-${idx + 1}`,
          type: "building",
          name: `건물_${idx + 1}동`
        },
        geometry: {
          type: "Polygon",
          coordinates: [coords]
        }
      });
    });

    // 2. Export Verandas as a single MultiLineString feature
    if (verandas.length > 0) {
      const lineStrings = verandas.map(line => [
        canvasToLonLat(line.start),
        canvasToLonLat(line.end)
      ]);
      features.push({
        type: "Feature",
        properties: {
          type: "veranda",
          name: "베란다 MultiLine"
        },
        geometry: {
          type: "MultiLineString",
          coordinates: lineStrings
        }
      });
    }

    const geoJsonData = {
      type: "FeatureCollection",
      features: features
    };

    const blob = new Blob([JSON.stringify(geoJsonData, null, 2)], { type: "application/json" });
    saveAs(blob, "rf_topology_geojson.json");
  };

  const startSimulationWithProgress = async (targetParams: SimulationParams, overrideEquipments?: Equipment[]): Promise<SimulationResult | null> => {
    setIsSimulating(true);
    setResult(null);
    setSelectedRank(1);
    setAiInsights(null);
    setSimProgress(10);
    setSimStatusMessage('서버 프로세스(Node.js) 연결 및 3GPP LOS 환경 준비 중...');

    const fullParams: SimulationParams = {
      ...targetParams,
      analysisArea: analysisArea || undefined
    };

    const manualToUse = overrideEquipments !== undefined ? overrideEquipments : manualEquipments;
    // 기존 안테나를 앞에 배치 — Phase 1에서 먼저 평가돼야 "기존 장비만의 기여분"이 정확히 집계된다
    const eqsToUse = [...existingAntennas, ...manualToUse];

    // 프로그레스 바 부드러운 단계별 애니메이션
    const steps = [
      { progress: 25, message: '📐 [서버] 베란다 1m 조밀 샘플링 & 차폐 기하 연산 중...' },
      { progress: 50, message: '📡 [서버] 사이트별 65° 빔폭 & Sector 이격 최적화 탐색 중...' },
      { progress: 75, message: '🏢 [서버] 1차 베란다 (100%) & 2차 베란다 (70% 가점) 연산 중...' },
      { progress: 90, message: '🏆 [서버] Top 5 최적 후보안 매칭 및 파라미터 검증 중...' },
    ];

    let currentStep = 0;
    const progressInterval = setInterval(() => {
      if (currentStep < steps.length) {
        setSimProgress(steps[currentStep].progress);
        setSimStatusMessage(steps[currentStep].message);
        currentStep++;
      }
    }, 220);

    try {
      // 1. 백엔드 서버에 job 제출 — 서버는 별도 워커 프로세스(scripts/simWorker.ts)를 fork 하고
      //    jobId 만 즉시 돌려준다 (배치와 같은 구조). 브라우저·express 메인 프로세스 모두 안 막힌다.
      const response = await fetch(getApiUrl('/api/sim/run-single'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rapaKey: selectedRapaKey || undefined,
          buildings,
          verandas,
          params: fullParams,
          equipments: eqsToUse,
        }),
      });

      if (!response.ok) {
        clearInterval(progressInterval);
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `서버 응답 오류 (HTTP ${response.status})`);
      }

      const submitted = await response.json();
      let data: any = null;
      if (submitted.ok && submitted.result && !submitted.jobId) {
        // 구버전 서버(인라인 연산)가 아직 떠 있는 경우 — 결과를 그대로 받는다. 서버 재시작 필요 안내.
        console.warn('[App] 서버가 구버전(인라인 연산)입니다. `npm run dev` 를 재시작하면 워커 방식으로 동작합니다.');
        data = submitted;
      } else if (!submitted.ok || !submitted.jobId) {
        clearInterval(progressInterval);
        throw new Error(submitted.error || '시뮬레이션 job 을 시작하지 못했습니다.');
      }

      // 2. jobId 폴링 (1.5초 간격). 단계 메시지가 끝나면 경과 시간을 보여준다.
      const jobId: string | null = submitted.jobId || null;
      for (; jobId && !data;) {
        await new Promise(r => setTimeout(r, 1500));
        const poll = await fetch(getApiUrl(`/api/sim/job/${encodeURIComponent(jobId)}`));
        const pj = await poll.json().catch(() => ({}));
        if (!poll.ok) throw new Error(pj.error || `job 상태 조회 실패 (HTTP ${poll.status})`);
        if (pj.status === 'done') { data = pj; break; }
        if (pj.status === 'error' || pj.status === 'cancelled') throw new Error(pj.error || `시뮬레이션 ${pj.status}`);
        if (currentStep >= steps.length) {
          setSimStatusMessage(`⚙️ [워커 pid 분리 연산] 진행 중... ${Math.round((pj.elapsedMs || 0) / 1000)}s 경과`);
        }
      }
      clearInterval(progressInterval);

      if (!data.result) {
        throw new Error('시뮬레이션 결과가 유효하지 않습니다.');
      }

      // 연산 완료 처리
      setSimProgress(100);
      setSimStatusMessage(`✅ 서버 연산 완료 (${data.durationMs ? (data.durationMs / 1000).toFixed(1) : 0}s)! 결과 도출 중...`);

      setTimeout(() => {
        setResult(data.result);
        setIsSimulating(false);
        setActivePanel(null);
        setDrawerOpen(true);
      }, 250);
      return data.result as SimulationResult;
    } catch (err: any) {
      clearInterval(progressInterval);

      // 서버는 살아 있는데 job 이 실패한 경우(워커 오류·취소 등)는 브라우저에서 다시 돌리지 않는다.
      // 수 분짜리 연산을 브라우저 메인 스레드에서 돌리면 탭이 통째로 멈추기 때문 — 오류만 보여주고 종료.
      const serverUnreachable = err instanceof TypeError || /Failed to fetch|NetworkError|HTTP 404/i.test(String(err?.message));
      if (!serverUnreachable) {
        console.error('[App] 서버 시뮬레이션 job 실패:', err.message);
        setIsSimulating(false);
        showAppNotification(`서버 시뮬레이션 실패: ${err.message} (서버 콘솔의 [Server-Sim] 로그를 확인하세요)`, 'error');
        return null;
      }
      console.warn('[App] 서버 미연결(정적 배포/오프라인), 브라우저 로컬 fallback 실행:', err.message);

      // Fallback: 서버가 아예 없을 때만(사내 nginx 정적 배포 등) 브라우저 로컬 엔진으로 실행
      setSimProgress(95);
      setSimStatusMessage('⚠️ 서버 미연결 — 로컬 브라우저 엔진으로 대체 연산 중... (화면이 잠시 멈출 수 있습니다)');

      setTimeout(() => {
        try {
          const res = runSimulation(buildings, verandas, fullParams, eqsToUse);
          setSimProgress(100);
          setSimStatusMessage('✅ 로컬 분석 완료! 결과 도출 중...');
          setTimeout(() => {
            setResult(res);
            setIsSimulating(false);
            setActivePanel(null);
            setDrawerOpen(true);
          }, 200);
        } catch (localErr: any) {
          setIsSimulating(false);
          alert(`시뮬레이션 실행 오류: ${localErr.message || localErr}`);
        }
      }, 100);
      return null;   // 로컬 폴백은 비동기 setTimeout 안에서 끝나므로 결과를 돌려주지 않는다
    }
    return null;
  };

  // ==========================================================================
  // [관로동 추천] 기존 LOS 시뮬레이션 재사용 + 보수적 조건
  //   ① 목표 커버율 상향(기본 90%) — 나머지 파라미터(빔폭·도달거리·후보간격)는 그대로
  //   ② 단지 폴리곤 밖 건물은 차폐로만 쓰고 설치·모수에서 제외 (hostInsideOnly)
  //   ③ 기준 분석(현재 목표치) 사이트 수 × 배수를 상한으로 걸어 과도한 증가·장시간 연산을 막는다
  // 결과는 기존 결과 화면 그대로 쓰고, 여기서는 '동별 추천 목록'만 따로 보여준다.
  // ==========================================================================
  const countAutoSites = (res: SimulationResult | null): number => {
    if (!res) return 0;
    const keys = new Set<string>();
    for (const eq of res.equipments || []) {
      if (eq.isManual || eq.isExisting) continue;
      const m = /^AUTO-(\d+)-/.exec(eq.id || '');
      keys.add(m ? m[1] : `${Math.round(eq.x)},${Math.round(eq.y)}`);
    }
    return keys.size;
  };

  const handleRunDuctRecommend = async () => {
    if (isSimulating) return;
    if (buildings.length === 0 || verandas.length === 0) {
      showAppNotification('먼저 RAPA Key로 단지를 불러와 건물·베란다가 준비된 뒤 실행해 주세요.', 'warning');
      return;
    }
    if (!analysisArea || analysisArea.length < 3) {
      showAppNotification('단지 경계 폴리곤이 없어 "단지 안만 선정" 조건을 적용할 수 없습니다.', 'warning');
      return;
    }
    try {
      // 1) 기준 분석 — 현재 목표치(기본 60%)로 사이트 수 N 확보. 이미 결과가 있으면 그대로 쓴다.
      let baseline = countAutoSites(result);
      if (!baseline) {
        showAppNotification(`기준 분석 실행 중 (목표 ${params.targetCoverage}%) — 사이트 수 기준을 잡습니다.`, 'info');
        const base = await startSimulationWithProgress({ ...params, hostInsideOnly: true });
        baseline = countAutoSites(base);
        if (!baseline) {
          showAppNotification('기준 분석에서 사이트가 나오지 않아 추천을 중단합니다.', 'error');
          return;
        }
      }
      setDuctBaselineSites(baseline);
      const cap = Math.max(baseline + 1, Math.ceil(baseline * (ductMultiplier || 2)));
      showAppNotification(`관로동 추천 실행 — 목표 ${ductTarget}% · 사이트 상한 ${cap}개 (기준 ${baseline} × ${ductMultiplier})`, 'info');
      // 2) 추천 분석 — 목표 상향 + 단지 안 한정 + 사이트 상한
      const rec = await startSimulationWithProgress({
        ...params, targetCoverage: ductTarget, hostInsideOnly: true, maxSites: cap,
      });
      if (rec) {
        setDuctRunInfo({ baseline, cap, target: ductTarget, sites: countAutoSites(rec), coverage: rec.coverageRatio });
        showAppNotification(
          `관로동 추천 완료: 사이트 ${countAutoSites(rec)}개 (기준 ${baseline}개의 ${(countAutoSites(rec) / baseline).toFixed(1)}배) · 커버율 ${rec.coverageRatio.toFixed(1)}%`,
          'success');
      }
    } catch (err: any) {
      showAppNotification(`관로동 추천 실패: ${err.message}`, 'error');
    }
  };

  /** 결과 장비 → 동별 집계 (관로동 추천 목록). CAD 관로동 판정과 나란히 비교한다. */
  const ductRows = (() => {
    if (!result || !geoMapping) return [] as Array<{ name: string; sites: number; sectors: number; cad: boolean; recommended: boolean }>;
    const moiraBs = (sourceMoira?.buildings || []).filter(b => Array.isArray(b.center));
    const nameAt = (x: number, y: number) => {
      let best: any = null, bd = Infinity;
      for (const b of moiraBs) {
        const q = lonLatToCanvas(b.center[0], b.center[1], geoMapping);
        const d = Math.hypot(q.x - x, q.y - y);
        if (d < bd) { bd = d; best = b; }
      }
      return best;
    };
    const perBuilding = new Map<string, { name: string; sites: Set<string>; sectors: number; cad: boolean }>();
    for (const eq of result.equipments || []) {
      if (eq.isExisting) continue;
      const b = nameAt(eq.x, eq.y);
      const name = (b?.bld_nm) || (b ? '명칭미상' : '단지 외');
      const m = /^(?:AUTO|MANUAL)-(\d+)-/.exec(eq.id || '');
      const siteKey = m ? m[1] : `${Math.round(eq.x)},${Math.round(eq.y)}`;
      const cur = perBuilding.get(name) || { name, sites: new Set<string>(), sectors: 0, cad: Boolean(b?.is_duct_building) };
      cur.sites.add(siteKey); cur.sectors += 1;
      perBuilding.set(name, cur);
    }
    const rows = [...perBuilding.values()].map(v => ({ name: v.name, sites: v.sites.size, sectors: v.sectors, cad: v.cad, recommended: true }));
    // CAD가 관로동이라고 본 동인데 추천에 안 뽑힌 경우도 보여준다 (비교용)
    for (const b of moiraBs) {
      const nm = b.bld_nm || '';
      if (b.is_duct_building && nm && !perBuilding.has(nm)) rows.push({ name: nm, sites: 0, sectors: 0, cad: true, recommended: false });
    }
    return rows.sort((a, b) => b.sites - a.sites || a.name.localeCompare(b.name));
  })();

  const handleEvaluateCurrent = () => {
    startSimulationWithProgress({ ...params, targetCoverage: 0 });
  };

  const handleRunSimulation = () => {
    startSimulationWithProgress(params);
  };

  const handleExecuteSimMode = (mode: SimulationMode) => {
    if (isSimulating || buildings.length === 0 || verandas.length === 0) return;
    const preventAuto = mode !== 'full_auto';
    const targetParams: SimulationParams = {
      ...params,
      simulationMode: mode,
      preventAutoSectors: preventAuto,
    };
    setParams(targetParams);

    // 만약 현재 수동 장비가 비어있고 복원된 결과 장비가 존재한다면, 수동 장비로 활성화하여 전달
    let activeManual = manualEquipments;
    if (activeManual.length === 0 && result) {
      const activeEquipments = (result.rankResults && result.rankResults[selectedRank])
        ? result.rankResults[selectedRank].equipments
        : result.equipments;
      // 기존 안테나는 별도 state(existingAntennas)로 이미 주입되므로 여기서 제외하지 않으면
      // isManual 사본이 하나 더 생겨 같은 좌표에 중복 주입된다
      const promotable = activeEquipments.filter(e => !e.isExisting);
      if (promotable.length > 0) {
        activeManual = promotable.map(e => ({ ...e, isManual: true }));
        setManualEquipments(activeManual);
      }
    }

    startSimulationWithProgress(targetParams, activeManual);
  };

  const handleDownloadReport = async () => {
    if (!result || !canvasRef.current) return;

    const zip = new JSZip();

    // 1. Add Summary Comparison Report
    const logText = result.logs.map(l => `[${new Date().toLocaleTimeString()}] ${l.message}`).join('\n');
    let summaryComparison = `=== RF SIMULATION TOP 5 CANDIDATES COMPARISON REPORT ===\n` +
      `Generated: ${new Date().toLocaleString()}\n` +
      `Beam Width: ${params.beamWidth}° | Max Range: ${params.maxRange}m | Target Coverage: ${params.targetCoverage}%\n\n` +
      `[ RANK SUMMARY COMPARISON ]\n`;

    [1, 2, 3, 4, 5].forEach(r => {
      const rankRes = result.rankResults ? result.rankResults[r] : null;
      if (rankRes) {
        summaryComparison += `Rank ${r} ${r === 1 ? '(CHOSEN FINAL)' : 'CANDIDATE'}: ` +
          `Equipments = ${rankRes.equipments.length} EA | ` +
          `Coverage(2차 70% 반영) = ${rankRes.coverageRatio.toFixed(1)}% | ` +
          `2nd = ${rankRes.secondCoveredSamples?.length || 0}m (+${Math.round((rankRes.secondCoveredSamples?.length || 0) * SECOND_VERANDA_WEIGHT)}m 환산)\n`;
      }
    });

    summaryComparison += `\n--- SIMULATION EXECUTION LOGS ---\n${logText}\n\n` +
      `--- AI INSIGHTS ---\n${aiInsights || 'No insights generated.'}`;

    zip.file("summary_comparison_report.txt", summaryComparison);

    // 2. Add Folders for Rank 1~5 individually
    [1, 2, 3, 4, 5].forEach(r => {
      const folderName = r === 1 ? "rank_1_chosen" : `rank_${r}`;
      const folder = zip.folder(folderName);
      if (!folder) return;

      const rankRes = result.rankResults ? result.rankResults[r] : (r === 1 ? result : null);
      if (!rankRes) return;

      // A. Topology JSON
      const topologyData = {
        version: "2.0",
        savedAt: new Date().toISOString(),
        rank: r,
        isChosen: r === 1,
        params,
        buildings,
        verandas,
        equipments: rankRes.equipments,
        coverageRatio: rankRes.coverageRatio
      };
      folder.file(`topology_rank${r}.json`, JSON.stringify(topologyData, null, 2));

      // B. GeoJSON
      const geoFeatures: any[] = [];
      buildings.forEach((b, idx) => {
        const coords = b.map(p => {
          // toCanvas는 0.8 스케일 + 10% 마진을 쓰므로 역변환도 동일 공식이어야 한다
          // (기존의 x/cWidth 선형 역산은 bbox 폭의 최대 12.5%만큼 좌표가 어긋났음)
          if (geoMapping) return canvasToLonLat(p.x, p.y, geoMapping);
          return [p.x, -p.y];
        });
        if (coords.length > 0) coords.push(coords[0]);
        geoFeatures.push({
          type: "Feature",
          properties: { id: `Building_${idx + 1}`, type: "Building" },
          geometry: { type: "Polygon", coordinates: [coords] }
        });
      });

      rankRes.equipments.forEach(eq => {
        let lon = eq.x, lat = -eq.y;
        if (geoMapping) {
          [lon, lat] = canvasToLonLat(eq.x, eq.y, geoMapping);
        }
        geoFeatures.push({
          type: "Feature",
          properties: {
            id: eq.id,
            type: "Equipment",
            azimuth: eq.angle,
            isManual: !!eq.isManual,
            rank: r
          },
          geometry: { type: "Point", coordinates: [lon, lat] }
        });
      });

      const geoJsonData = {
        type: "FeatureCollection",
        properties: { rank: r, coverageRatio: rankRes.coverageRatio },
        features: geoFeatures
      };
      folder.file(`geojson_rank${r}.json`, JSON.stringify(geoJsonData, null, 2));

      // C. Individual Rank Report txt
      const rankReportText = `=== RANK ${r} (${r === 1 ? 'CHOSEN OPTION' : 'CANDIDATE CASE'}) REPORT ===\n` +
        `Equipments Count: ${rankRes.equipments.length}\n` +
        `Coverage Ratio (1st + 0.7×2nd, / 1st total): ${rankRes.coverageRatio.toFixed(1)}%\n` +
        `2nd Veranda Covered: ${rankRes.secondCoveredSamples?.length || 0}m (+${Math.round((rankRes.secondCoveredSamples?.length || 0) * SECOND_VERANDA_WEIGHT)}m weighted)\n\n` +
        `--- EQUIPMENT LIST ---\n` +
        rankRes.equipments.map(eq => `Node [${eq.id}] at (${Math.round(eq.x)}, ${Math.round(eq.y)}) facing ${Math.round(eq.angle)}°`).join('\n');

      folder.file(`report_rank${r}.txt`, rankReportText);
    });

    // 3. Add Canvas Image
    const canvas = canvasRef.current;
    const imgDataUrl = canvas.toDataURL("image/png");
    const imgData = imgDataUrl.split(',')[1];
    zip.file("simulation_result_canvas.png", imgData, { base64: true });

    // 4. Generate and Download ZIP
    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, "rf_simulation_results.zip");
  };

  /**
   * 수동 분석 결과를 전체 리스트 대시보드에 저장 (POST /api/results/save)
   */
  const handleSaveToDashboard = async () => {
    if (!result) {
      showAppNotification('저장할 시뮬레이션 결과가 없습니다.', 'warning');
      return;
    }
    if (!selectedRapaKey) {
      showAppNotification('RAPA Key가 선택되지 않았습니다. RAPA 단지만 전체 리스트에 저장할 수 있습니다.', 'warning');
      return;
    }
    if (!geoMapping) {
      showAppNotification('지리 좌표계 매핑(geoMapping)이 없습니다. SHP/이미지 배경 단지는 저장할 수 없습니다.', 'warning');
      return;
    }

    const curRankRes = (result.rankResults && result.rankResults[selectedRank])
      ? result.rankResults[selectedRank]
      : null;
    const activeResult: SimulationResult = curRankRes
      ? {
          ...result,
          equipments: curRankRes.equipments,
          coverageRatio: curRankRes.coverageRatio,
          coveredSamples: curRankRes.coveredSamples || result.coveredSamples || [],
          secondCoveredSamples: curRankRes.secondCoveredSamples || result.secondCoveredSamples || [],
          buildingCoverages: curRankRes.buildingCoverages || result.buildingCoverages || [],
        }
      : result;

    const row = aptList.find(r => r.rapaKey === selectedRapaKey);
    const aptName = row ? (row.buildingName || row.projectName) : selectedRapaKey;

    // 기존 분석 결과 확인 (덮어쓰기 여부 질문)
    try {
      const checkRes = await fetch(getApiUrl(`/api/results/${selectedRapaKey}`));
      if (checkRes.ok) {
        const existingData: BatchResult = await checkRes.json();
        if (existingData && existingData.rank1) {
          const oldSourceText = existingData.source === 'manual' ? '수동 저장' : '배치 분석';
          const oldCov = existingData.rank1.coverageRatio.toFixed(1);
          const newCov = activeResult.coverageRatio.toFixed(1);
          const confirmed = window.confirm(
            `[${selectedRapaKey}] 기존 분석 결과가 이미 존재합니다.\n\n` +
            `• 기존 결과: ${oldSourceText} (커버리지 ${oldCov}%, 사이트 ${existingData.rank1.sites?.length || 0}개)\n` +
            `• 신규 결과: 수동 분석 (Rank ${selectedRank}, 커버리지 ${newCov}%, 섹터 ${activeResult.equipments.length}개)\n\n` +
            `기존 결과를 덮어쓰시겠습니까?`
          );
          if (!confirmed) return;
        }
      }
    } catch {
      // 신규 등록
    }

    try {
      const batchResultData = buildBatchResult(
        activeResult,
        geoMapping,
        params,
        selectedRapaKey,
        {
          aptName,
          source: 'manual',
          durationSec: 1,
          buildingCount: buildings.length,
          verandaSource: VERANDA_AI_VERSION,
          pixelsPerMeter: (geoMapping ? pixelsPerMeterFromMapping(geoMapping) : null) || params.pixelsPerMeter || 1.0,
        }
      );

      const saveRes = await fetch(getApiUrl('/api/results/save'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rapaKey: selectedRapaKey,
          result: batchResultData,
        }),
      });

      if (!saveRes.ok) {
        const errJson = await saveRes.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${saveRes.status}`);
      }

      showAppNotification(`[${selectedRapaKey}] 화면 분석 결과(Rank ${selectedRank}, 커버리지 ${activeResult.coverageRatio.toFixed(1)}%)가 전체 리스트에 저장되었습니다.`, 'success');
    } catch (err: any) {
      showAppNotification(`화면 분석 결과 저장 실패: ${err.message}`, 'error');
    }
  };

  /**
   * 대시보드 상세 drawer의 "지도에서 열기" 클릭 시 단지 로드 및 화면 상태 복원
   */
  const handleOpenInMapFromDashboard = async (rapaKey: string) => {
    setMainView('map');
    setActivePanel('location');
    setDrawerOpen(true);

    // 1. 단지 선택 & 로드
    if (selectedRapaKey !== rapaKey) {
      await handleSelectRapaKey(rapaKey);
    }

    // 2. 결과 JSON 로드 & 화면 상태 복원
    //    사내망(nginx 정적 배포)에는 server.ts가 없어 /api/results/* 가 404 이거나,
    //    SPA 폴백으로 index.html(HTTP 200, HTML)이 돌아온다. 그래서 (1) 정적 파일 폴백과
    //    (2) JSON 여부 확인을 둘 다 둔다. 대시보드 목록·상세(DashboardView)와 같은 규칙.
    try {
      const base = (import.meta as any).env?.BASE_URL || '/';
      const readJson = async (url: string): Promise<any | null> => {
        try {
          const r = await fetch(url);
          if (!r.ok) return null;
          const text = await r.text();
          if (!text.trim().startsWith('{')) return null;   // index.html 등 JSON이 아닌 응답 방어
          return JSON.parse(text);
        } catch {
          return null;
        }
      };
      const altKey = rapaKey.startsWith('m-') ? rapaKey.slice(2) : `m-${rapaKey}`;
      const savedResult: BatchResult | null =
        (await readJson(getApiUrl(`/api/results/${rapaKey}`)))
        || (await readJson(`${base}results/${rapaKey}.json`))
        || (await readJson(`${base}results/${altKey}.json`));
      if (!savedResult || !savedResult.rank1) {
        showAppNotification(`[${rapaKey}] 저장된 분석 결과를 불러오지 못했습니다 — 지도에는 단지 폴리곤만 표시합니다.`, 'warning');
        return;
      }

      const restoredEquipments: Equipment[] = [];
      (savedResult.rank1.sites || []).forEach((site) => {
        (site.sectors || []).forEach((sector) => {
          restoredEquipments.push({
            id: sector.id,
            x: site.x,
            y: site.y,
            angle: sector.angle,
            bIdx: site.bIdx ?? 0,
            isManual: sector.type === 'manual',
          });
        });
      });

      const rankResults: Record<number, RankResult> = {};
      if (savedResult.topRanks && savedResult.topRanks.length > 0) {
        savedResult.topRanks.forEach((tr) => {
          const trEquipments: Equipment[] = [];
          (tr.sites || []).forEach((s) => {
            (s.angles || []).forEach((angle, aIdx) => {
              trEquipments.push({
                id: `restored-r${tr.rank}-${Math.round(s.x)}-${Math.round(s.y)}-${aIdx}`,
                x: s.x,
                y: s.y,
                angle,
                bIdx: s.bIdx ?? 0,
                isManual: false,
              });
            });
          });
          rankResults[tr.rank] = {
            rank: tr.rank,
            equipments: tr.rank === 1 ? restoredEquipments : trEquipments,
            coverageRatio: tr.coverageRatio,
            coveredSamples: tr.rank === 1 ? (savedResult.rank1?.coveredSamples || []) : [],
            secondCoveredSamples: tr.rank === 1 ? (savedResult.rank1?.secondCoveredSamplesPoints || []) : [],
            buildingCoverages: tr.rank === 1 ? (savedResult.rank1?.buildingCoverages || []) : [],
          };
        });
      }

      const simResult: SimulationResult = {
        equipments: restoredEquipments,
        coverageRatio: savedResult.rank1.coverageRatio,
        coveredSamples: savedResult.rank1.coveredSamples || [],
        secondCoveredSamples: savedResult.rank1.secondCoveredSamplesPoints || [],
        buildingCoverages: savedResult.rank1.buildingCoverages || [],
        logs: savedResult.rank1.logs || [],
        rankResults: Object.keys(rankResults).length > 0 ? rankResults : undefined,
      };

      // 대시보드에서 지도에서보기로 복원된 장비들을 수동 편집/분석 가능한 장비(isManual: true)로 설정
      setManualEquipments(restoredEquipments.map(e => ({ ...e, isManual: true })));
      setResult(simResult);
      setSelectedRank(1);

      if (!savedResult.rank1.coveredSamples || savedResult.rank1.coveredSamples.length === 0) {
        showAppNotification(`[${rapaKey}] 저장된 장비 및 커버리지 수치를 복원했습니다. 전체 오버레이 광선 표시는 [시뮬레이션 실행] 재분석이 필요합니다.`, 'info');
      } else {
        const srcText = savedResult.source === 'manual' ? '수동 분석' : '배치 분석';
        showAppNotification(`[${rapaKey}] 저장된 ${srcText} 결과(커버리지 ${savedResult.rank1.coverageRatio}%)가 화면에 복원되었습니다.`, 'success');
      }
    } catch (err: any) {
      console.error('결과 복원 중 오류:', err);
    }
  };

  const updateEqAngle = (id: string, newAngle: number) => {
    const currentRankResult = (result && result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
    const activeEqs = currentRankResult ? currentRankResult.equipments : (result ? result.equipments : manualEquipments);
    const target = activeEqs.find(eq => eq.id === id);
    if (!target) return;

    const coLocated = activeEqs.filter(eq => eq.id !== id && Math.sqrt((eq.x - target.x) ** 2 + (eq.y - target.y) ** 2) < 2);

    let isValidChange = true;
    for (const other of coLocated) {
      let diff = Math.abs(other.angle - newAngle);
      diff = diff > 180 ? 360 - diff : diff;
      if (diff < 60) {
        isValidChange = false;
        break;
      }
    }

    if (!isValidChange) {
      showAppNotification("동일 위치 장비 간의 각도 이격 거리는 최소 60도 이상이어야 합니다. (최대 5도 중첩 허용)", "warning");
      return;
    }

    const updated = activeEqs.map(eq => eq.id === id ? { ...eq, angle: newAngle } : eq);
    setManualEquipments(updated);
    setResult(null);
    setAiInsights(null);
  };

  const deleteEq = (id: string) => {
    const currentRankResult = (result && result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
    const activeEqs = currentRankResult ? currentRankResult.equipments : (result ? result.equipments : manualEquipments);
    const remaining = activeEqs.filter(eq => eq.id !== id);
    setManualEquipments(remaining);
    setResult(null);
    setAiInsights(null);
    showAppNotification(`Sector [${id}] 장비가 삭제되었습니다.`, "info");
  };

  const handleGenerateAIInsights = async () => {
    if (!result) return;
    setIsGeneratingInsights(true);
    setAiInsights("");
    try {
      const res = await fetch(getApiUrl('/api/ai-insights'), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ result, params })
      });
      const data = await res.json();
      if (data.error) {
        setAiInsights(`Failed to generate AI insights: ${data.error}`);
      } else {
        setAiInsights(data.text || "Insights loaded.");
      }
    } catch (e: any) {
      console.error(e);
      setAiInsights("Failed to generate AI insights: " + e.message + "\nPlease check your network or server configuration.");
    } finally {
      setIsGeneratingInsights(false);
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 캔버스 데이터 색을 CSS 토큰에서 1회 읽어온다 (테마 전환에 함께 따라오게 하기 위함).
    // 지도 타일은 밝기가 제각각이라 색만으로는 대비를 보장할 수 없으므로,
    // 모든 데이터 선은 case(어두운 테두리)를 한 겹 깔고 그 위에 색선을 그린다 — 카토그래피 관행.
    const cs = getComputedStyle(document.documentElement);
    const tok = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
    const D = {
      v1: tok('--d-v1', '#3987E5'),
      v2: tok('--d-v2', '#8FBEF2'),
      site: tok('--d-site', '#199E70'),
      inert: tok('--d-inert', '#C9C4B8'),
      case: tok('--d-case', 'rgba(10,12,16,.92)'),
      accent: tok('--accent', '#C4735A'),
      good: tok('--st-good', '#0CA30C'),
      warn: tok('--st-warn', '#FAB219'),
      crit: tok('--st-crit', '#D03B3B'),
    };
    const num = (name: string, fb: number) => parseFloat(tok(name, String(fb))) || fb;
    const W = {
      v1: num('--d-w1', 2.6),
      v2: num('--d-w2', 2.2),
      conc: num('--d-w-c', 1.4),
      case: num('--d-case-w', 1.6),
    };
    /** 케이싱 + 색선 2중 스트로크.
     *  얇은 마크 원칙: 케이싱은 대비를 보장하는 최소 두께만 더한다(좌우 0.8px씩).
     *  파선에는 butt 캡을 써서 각 dash가 알약처럼 부풀지 않게 한다. */
    const strokeCased = (w: number, color: string, dash: number[] = []) => {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = dash.length ? 'butt' : 'round';
      ctx.setLineDash(dash);
      ctx.strokeStyle = D.case;
      ctx.lineWidth = w + W.case;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.restore();
    };

    if (imageRef.current) {
      ctx.drawImage(imageRef.current, 0, 0, canvas.width, canvas.height);
    }

    // 0. 아파트 단지 경계 (analysisArea / LT_C_AJAGMBOUND) 캔버스 표출
    if (analysisArea && analysisArea.length >= 3) {
      ctx.save();
      ctx.beginPath();
      analysisArea.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      // 단지 경계 영역 투명 보라색 채우기
      ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.fill();
      // 단지 경계 — 무채색 파선 + 케이싱 (데이터가 아니라 컨텍스트이므로 색을 쓰지 않는다)
      ctx.setLineDash([9, 7]);
      ctx.strokeStyle = D.case;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 0-1. 위치 보정 기준 경계 (필지/구역) — 정합 결과 확인용 주황 파선
    if (georefRefRings && geoMapping) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,170,40,0.95)';
      ctx.lineWidth = 2;
      for (const ring of georefRefRings) {
        ctx.beginPath();
        ring.forEach((ll, i) => {
          const q = lonLatToCanvas(ll[0], ll[1], geoMapping);
          if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        });
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }

    buildings.forEach((poly, bIdx) => {
      ctx.beginPath();
      poly.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();

      const isHovered = bIdx === hoveredBuildingIdx;
      const curRankRes = (result && result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
      const bCov = (curRankRes?.buildingCoverages || result?.buildingCoverages || [])?.find((bc: any) => bc.bIdx === bIdx);

      // 건물 배경 채우기 (호버 시 하이라이트, 결과 존재 시 아주 은은한 색조 틴트)
      if (isHovered) {
        ctx.fillStyle = 'rgba(0, 229, 255, 0.18)';
      } else if (bCov && result) {
        ctx.fillStyle = bCov.ratio >= 90
          ? 'rgba(16, 185, 129, 0.12)'
          : bCov.ratio >= 50
          ? 'rgba(245, 158, 11, 0.10)'
          : 'rgba(244, 63, 94, 0.08)';
      } else {
        ctx.fillStyle = 'rgba(18, 20, 26, 0.55)';
      }
      ctx.fill();

      // 건물 외곽선 (호버 시 시안색 강조, 결과 존재 시 상태 테두리)
      if (isHovered) {
        ctx.strokeStyle = D.accent;
        ctx.lineWidth = 2.5;
      } else if (bCov && result) {
        ctx.strokeStyle = bCov.ratio >= 90
          ? 'rgba(16, 185, 129, 0.45)'
          : bCov.ratio >= 50
          ? 'rgba(245, 158, 11, 0.40)'
          : 'rgba(244, 63, 94, 0.35)';
        ctx.lineWidth = 1.2;
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
        ctx.lineWidth = 1;
      }
      ctx.stroke();
    });

    if (currentPolygon.length > 0) {
      ctx.beginPath();
      currentPolygon.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (mousePos) {
        ctx.lineTo(mousePos.x, mousePos.y);
      }
      ctx.strokeStyle = D.accent;
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Second Verandas (오직 지정된 베란다 목록 verandas 중 isSecond인 베란다만 렌더링. 모든 건물 무차별 자동 생성 금지)
    // (지정되지 않은 주변 건물은 베란다가 없어도 Pole/Site 설치 및 차폐 역할만 수행함)

    // 콘크리트 벽 — 무채색 얇은 선. 데이터가 아니라 '창호 없음'이라는 사실의 표시이므로 가장 조용하게.
    concreteWalls.forEach(line => {
      ctx.beginPath();
      ctx.moveTo(line.start.x, line.start.y);
      ctx.lineTo(line.end.x, line.end.y);
      strokeCased(W.conc, D.inert);
    });

    verandas.forEach(line => {
      ctx.beginPath();
      ctx.moveTo(line.start.x, line.start.y);
      ctx.lineTo(line.end.x, line.end.y);
      ctx.setLineDash([]); // 실선 고정
      if (line.isSecond) {
        // 2차 베란다 — 1차와 '다른 항목'이 아니라 '낮은 등급'이므로 같은 hue의 밝은 스텝 + 파선
        strokeCased(W.v2, D.v2, [6, 3.5]);
      } else {
        // 1차 베란다 — 메인 수광면
        strokeCased(W.v1, D.v1);
      }
    });

    if (currentLineStart && mousePos) {
      ctx.beginPath();
      ctx.moveTo(currentLineStart.x, currentLineStart.y);
      ctx.lineTo(mousePos.x, mousePos.y);
      if (mode === 'second_veranda') {
        strokeCased(W.v2, D.v2, [6, 3.5]);
      } else if (mode === 'ruler') {
        strokeCased(W.v1, D.accent, [5, 4]);   // 축척은 도구(상호작용)이므로 액센트
      } else {
        strokeCased(W.v1, D.v1, [7, 5]);
      }
    }

    // Draw calibrated ruler line if present
    if (rulerLine) {
      ctx.beginPath();
      ctx.moveTo(rulerLine.start.x, rulerLine.start.y);
      ctx.lineTo(rulerLine.end.x, rulerLine.end.y);
      ctx.strokeStyle = D.accent;
      ctx.lineWidth = 3.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw end-cap dots
      [rulerLine.start, rulerLine.end].forEach(pt => {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = D.accent;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });

      // Draw distance text above ruler line
      const midX = (rulerLine.start.x + rulerLine.end.x) / 2;
      const midY = (rulerLine.start.y + rulerLine.end.y) / 2;
      const dx = rulerLine.end.x - rulerLine.start.x;
      const dy = rulerLine.end.y - rulerLine.start.y;
      const distPx = Math.sqrt(dx * dx + dy * dy);
      const estM = (distPx / params.pixelsPerMeter).toFixed(1);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.beginPath();
      ctx.roundRect(midX - 50, midY - 14, 100, 24, 4);
      ctx.fill();
      ctx.strokeStyle = D.accent;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = D.accent;
      ctx.font = 'bold 11px Inter, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(distPx)}px ≈ ${estM}m`, midX, midY);
    }

    const currentRankResult = (result && result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
    const activeEquipments = currentRankResult ? currentRankResult.equipments : (result ? result.equipments : [...existingAntennas, ...manualEquipments]);
    const activeCoveredSamples = currentRankResult ? currentRankResult.coveredSamples : (result ? result.coveredSamples : []);
    const activeSecondCoveredSamples = currentRankResult ? currentRankResult.secondCoveredSamples : (result ? result.secondCoveredSamples : []);

    // Site 팔레트/번호는 모듈 스코프 공용 정의 사용 (결과 패널과 동일 값 보장)

    const siteMap = buildSiteOrder(activeEquipments);

    /** Site 고유 키 (동일 좌표 = 동일 Site) */
    const siteKeyOf = (eq: Equipment) => `${Math.round(eq.x)},${Math.round(eq.y)}`;
    /** 화면 표기용 Site 번호 (1부터) */
    const getSiteNo = (eq: Equipment) => (siteMap.get(siteKeyOf(eq)) ?? 0) + 1;
    /** 선택 강조: 특정 Site를 고르면 나머지는 흐려진다. 미선택이면 전부 100%. */
    const focusAlpha = (eq: Equipment) =>
      !selectedSiteKey || selectedSiteKey === siteKeyOf(eq) ? 1 : 0.15;

    const getSiteColor = (eq: Equipment, alpha?: number): string => {
      const idx = (siteMap.get(siteKeyOf(eq)) ?? 0) % SITE_PALETTE.length;
      const hex = SITE_PALETTE[idx];
      const a = (alpha === undefined ? 1 : alpha) * focusAlpha(eq);
      if (a >= 1) return hex;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a})`;
    };

    // 1. Draw Sector Beams first (Distinct site color per location for both Auto & Manual)
    activeEquipments.forEach((eq) => {
      const angleRad = (eq.angle - 90) * Math.PI / 180;
      // 기존 안테나는 실측 h_beamwidth가 있으면 그 값을, 없으면 표준 빔폭을 쓴다
      const effBeamWidth = (eq.isExisting && eq.hBeamwidth) ? eq.hBeamwidth : params.beamWidth;
      const beamHalfConf = (effBeamWidth / 2) * Math.PI / 180;
      const mainStart = angleRad - beamHalfConf;
      const mainEnd = angleRad + beamHalfConf;
      const radius = params.maxRange * params.pixelsPerMeter * 0.4;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(eq.x, eq.y);
      ctx.arc(eq.x, eq.y, radius, mainStart, mainEnd);
      ctx.closePath();
      if (eq.isExisting) {
        // 기존 안테나(현황) — 중립 회색 + 점선. 신규 제안 사이트와 시각적으로 명확히 구분한다.
        ctx.fillStyle = `rgba(148,163,184,${0.10 * focusAlpha(eq)})`;
        ctx.fill();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = `rgba(148,163,184,${0.65 * focusAlpha(eq)})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else {
        ctx.fillStyle = getSiteColor(eq, 0.14);
        ctx.fill();
        ctx.strokeStyle = getSiteColor(eq, 0.45);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.restore();
    });

    if (result) {
      // 2. Draw Connection Lines — Site color per location
      activeEquipments.forEach((eq) => {
        if (eq.coveredPoints && eq.coveredPoints.length > 0) {
          ctx.beginPath();
          eq.coveredPoints.forEach(p => {
            ctx.moveTo(eq.x, eq.y);
            ctx.lineTo(p.x, p.y);
          });
          ctx.strokeStyle = getSiteColor(eq, 0.28);
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      });

      // 3. Draw standard (1st) veranda covered points (Green)
      ctx.fillStyle = D.good;
      result.coveredSamples.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // 4. Draw Second veranda covered points (Bright Yellow - 표시만)
      if (result.secondCoveredSamples) {
        ctx.fillStyle = D.v2;
        result.secondCoveredSamples.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }

    // 5. Draw Bracket Arms & Sector Icons
    activeEquipments.forEach((eq) => {
      const angleRad = (eq.angle - 90) * Math.PI / 180;
      const offsetDist = 18; // Offset 18px towards steering angle
      const iconX = eq.x + Math.cos(angleRad) * offsetDist;
      const iconY = eq.y + Math.sin(angleRad) * offsetDist;

      const fa = focusAlpha(eq);
      ctx.save();
      ctx.globalAlpha = fa;

      // Draw sturdy bracket arm
      ctx.beginPath();
      ctx.moveTo(eq.x, eq.y);
      ctx.lineTo(iconX, iconY);
      ctx.strokeStyle = D.case; // 케이싱 색 — 지도 위에서 항상 읽히도록
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // Draw sector circle — Site color border (기존 안테나는 회색)
      ctx.beginPath();
      ctx.arc(iconX, iconY, 11, 0, Math.PI * 2);
      ctx.fillStyle = eq.isExisting ? '#e2e8f0' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = eq.isExisting ? '#64748b' : getSiteColor(eq);
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // 섹터 라벨 — Site 번호를 함께 표기해 색이 순환해도 소속이 확정되게 한다.
      ctx.fillStyle = '#09090b';
      ctx.font = 'bold 8.5px IBM Plex Sans';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const rawLabel = eq.id.replace('AUTO-', '').replace('M-', '');
      const sectorSuffix = rawLabel.split('-').pop() || rawLabel;
      // 기존 안테나는 'E' 접두 라벨 — 신규 Site 번호 체계와 섞이지 않게 한다
      const labelText = eq.isExisting ? `E${sectorSuffix}` : `${getSiteNo(eq)}-${sectorSuffix}`;
      ctx.fillText(labelText, iconX, iconY);
      ctx.restore();
    });

    // 6. Draw central masts/holding poles (Tower base dots)
    const uniquePoles = new Map<string, Point>();
    activeEquipments.forEach((eq) => {
      const key = `${Math.round(eq.x)},${Math.round(eq.y)}`;
      if (!uniquePoles.has(key)) {
        uniquePoles.set(key, { x: eq.x, y: eq.y });
      }
    });

    uniquePoles.forEach((pos, key) => {
      // 마스트 폴의 색상: 해당 위치의 첫 장비 색상 사용
      const poleEq = activeEquipments.find(e => `${Math.round(e.x)},${Math.round(e.y)}` === key);
      const poleColor = poleEq ? getSiteColor(poleEq) : '#ffffff';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#18181b';
      ctx.fill();
      ctx.strokeStyle = poleColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // 7. 축척 바 — 항상 표시. "이 화면에서 50m가 몇 px인가"를 눈으로 확인할 수 있어야
    //    RF 도달거리 감각이 생긴다. 캔버스에 직접 그리므로 줌/스크롤과 항상 정합된다.
    const ppmDraw = params.pixelsPerMeter > 0 ? params.pixelsPerMeter : 0;
    if (ppmDraw > 0 && canvas.width > 0) {
      const NICE_M = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
      let barM = NICE_M[0];
      for (const c of NICE_M) if (c * ppmDraw <= canvas.width * 0.30) barM = c;
      const barPx = barM * ppmDraw;
      const bx = 16, by = canvas.height - 18;
      const tick = (w: number, color: string) => {
        ctx.strokeStyle = color; ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
        ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by + 5);
        ctx.moveTo(bx + barPx, by - 5); ctx.lineTo(bx + barPx, by + 5);
        ctx.stroke();
      };
      ctx.save();
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';
      tick(6, 'rgba(10,12,16,.85)');   // 케이싱 — 지도 타일 밝기와 무관하게 읽히도록
      tick(2, '#EDEAE2');
      const label = `${barM}m`;
      ctx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,12,16,.85)';
      ctx.strokeText(label, bx, by - 8);
      ctx.fillStyle = '#EDEAE2';
      ctx.fillText(label, bx, by - 8);
      ctx.restore();
    }

    // 의존성 누락 주의: 캔버스가 읽는 상태는 전부 여기 있어야 한다.
    // analysisArea가 빠져 있어 리셋 후에도 이전 단지 경계가 남아 있었다(2026-08-15 수정).
    // theme은 캔버스 색을 CSS 토큰에서 읽으므로 테마 전환 시 재도색을 위해 필요하다.
  }, [imageSrc, buildings, verandas, concreteWalls, analysisArea, currentPolygon, currentLineStart,
      mousePos, mode, rulerLine, result, params, manualEquipments, existingAntennas, selectedRank, selectedSiteKey, theme,
      canvasSize, georefRefRings, geoMapping]);

  return (
    <div className="app-shell">
      {notification && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-[400px] px-4 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className={`p-3.5 rounded-lg shadow-2xl border flex items-start space-x-3 backdrop-blur bg-zinc-950/95 text-text-primary ${notification.type === 'success' ? 'border-emerald-500/50 shadow-emerald-950/20' :
              notification.type === 'error' ? 'border-rose-500/50 shadow-rose-950/20' :
                notification.type === 'warning' ? 'border-amber-500/50 shadow-amber-950/20' :
                  'border-cyan-500/50 shadow-cyan-950/20'
            }`}>
            <div className={`mt-0.5 rounded-full p-1 ${notification.type === 'success' ? 'text-emerald-400 bg-emerald-500/10' :
                notification.type === 'error' ? 'text-rose-400 bg-rose-500/10' :
                  notification.type === 'warning' ? 'text-amber-400 bg-amber-500/10' :
                    'text-cyan-400 bg-cyan-500/10'
              }`}>
              {notification.type === 'success' && <Check className="w-4 h-4" />}
              {notification.type === 'error' && <X className="w-4 h-4" />}
              {notification.type === 'warning' && <AlertTriangle className="w-4 h-4" />}
              {notification.type === 'info' && <Info className="w-4 h-4" />}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-xs font-semibold text-gray-100 leading-normal whitespace-pre-wrap">{notification.message}</p>
            </div>
            <button
              onClick={() => setNotification(null)}
              className="text-gray-400 hover:text-text-primary shrink-0 p-0.5 rounded hover:bg-bg-accent transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 축척 안내 팝업 — 일반 알림과 별도 슬롯(아래쪽)이라 서로 덮지 않는다 */}
      {scaleNotice && (
        <div className={`fixed left-1/2 -translate-x-1/2 z-50 max-w-md w-[400px] px-4 animate-in fade-in slide-in-from-top-4 duration-300 ${notification ? 'top-24' : 'top-4'}`}>
          <div className={`p-3.5 rounded-lg shadow-2xl border flex items-start space-x-3 backdrop-blur bg-zinc-950/95 text-text-primary ${scaleNotice.mode === 'auto' ? 'border-emerald-500/50 shadow-emerald-950/20' : 'border-amber-500/50 shadow-amber-950/20'}`}>
            <div className={`mt-0.5 rounded-full p-1 ${scaleNotice.mode === 'auto' ? 'text-emerald-400 bg-emerald-500/10' : 'text-amber-400 bg-amber-500/10'}`}>
              <Ruler className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0 text-left">
              {scaleNotice.mode === 'auto' && scaleNotice.ppm !== null ? (
                <>
                  <p className="text-xs font-bold text-gray-100 leading-normal">
                    Scale Ruler : 50m 자동 축척 적용
                  </p>
                  <p className="mt-1 text-[11px] font-mono text-emerald-300 leading-normal">
                    50m = {Math.round(50 * scaleNotice.ppm)}px　({scaleNotice.ppm} px/m)
                  </p>
                  <p className="mt-1 text-[10.5px] text-text-secondary leading-normal">
                    단지·건물 폴리곤의 실제 위경도로 산출했습니다. LOS 도달거리(m) 계산에 이 값이 쓰입니다.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs font-bold text-gray-100 leading-normal">
                    Scale Ruler : 자동 축척 불가 — 수동 보정 필요
                  </p>
                  <p className="mt-1 text-[10.5px] text-text-secondary leading-normal">
                    위경도 정보가 없어(이미지 배경 등) 축척을 계산할 수 없습니다.
                    도구 패널의 <strong className="text-amber-300">Scale Ruler</strong>로 알려진 거리(예: 50m)를 그어 직접 보정해 주세요.
                  </p>
                </>
              )}
            </div>
            <button
              onClick={() => setScaleNotice(null)}
              className="text-gray-400 hover:text-text-primary shrink-0 p-0.5 rounded hover:bg-bg-accent transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* ==================== 아이콘 레일 (Icon Rail, 76px) ==================== */}
      <div className="icon-rail">
        <div className="rail-logo" title="RF-SIM [VER 1.0.4] · Network Optimization Tool">
          <RadioTower className="w-4.5 h-4.5" style={{ color: '#14171c' }} />
        </div>
        <div className="rail-buttons">
          <button
            data-tour="rail-location"
            className={`rail-btn ${activePanel === 'location' ? 'active' : ''}`}
            onClick={() => setActivePanel(activePanel === 'location' ? null : 'location')}
          >
            <Search className="w-5 h-5" strokeWidth={1.8} />
            <span>위치</span>
          </button>
          <button
            data-tour="rail-model"
            className={`rail-btn ${activePanel === 'model' ? 'active' : ''}`}
            onClick={() => setActivePanel(activePanel === 'model' ? null : 'model')}
          >
            <Sparkles className="w-5 h-5" strokeWidth={1.8} />
            <span>모델입력</span>
          </button>
          <button
            data-tour="rail-duct"
            className={`rail-btn ${activePanel === 'duct' ? 'active' : ''}`}
            onClick={() => setActivePanel(activePanel === 'duct' ? null : 'duct')}
            title="관로동 추천 — 보수적 조건(목표 상향·단지 내 한정)으로 장비 배치 후보 동 선정"
          >
            <Radio className="w-5 h-5" strokeWidth={1.8} />
            <span>관로동</span>
          </button>
          <button
            data-tour="rail-result"
            className={`rail-btn ${drawerOpen ? 'active' : ''}`}
            onClick={() => setDrawerOpen(!drawerOpen)}
            disabled={!result}
            title={!result ? '시뮬레이션을 먼저 실행하세요' : undefined}
          >
            <Terminal className="w-5 h-5" strokeWidth={1.8} />
            <span>결과</span>
          </button>
        </div>
        <div className="rail-spacer" />
        <div className="rail-buttons">
          <button
            data-tour="rail-tools"
            className={`rail-btn ${activePanel === 'tools' ? 'active' : ''}`}
            onClick={() => setActivePanel(activePanel === 'tools' ? null : 'tools')}
          >
            <Square className="w-5 h-5" strokeWidth={1.8} />
            <span>도구</span>
          </button>
          <button
            data-tour="rail-settings"
            className={`rail-btn ${activePanel === 'settings' ? 'active' : ''}`}
            onClick={() => setActivePanel(activePanel === 'settings' ? null : 'settings')}
          >
            <Filter className="w-5 h-5" strokeWidth={1.8} />
            <span>설정</span>
          </button>
        </div>

        {/* 가이드 버튼 (Radiant Amber 글로우 상시 강조) */}
        <div className="rail-buttons" style={{ marginTop: 'auto', paddingBottom: 8 }}>
          <button
            ref={guideButtonRef}
            className={`rail-btn rail-btn-guide ${showGuideMenu || guideTourId ? 'active' : ''}`}
            onClick={() => setShowGuideMenu(!showGuideMenu)}
            title="💡 따라하기 (튜토리얼) 열기"
          >
            <Lightbulb className="w-5 h-5 text-[#ffb300]" strokeWidth={2.2} />
            <span className="font-bold text-[#ffb300]">가이드</span>
          </button>
        </div>
      </div>

      {/* ==================== 스텝 플라이아웃 패널 (340px, activePanel 1개만 열림) ==================== */}
      {activePanel && (
        <div data-tour="step-panel" className="step-panel">
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {activePanel === 'location' && (
              <section data-tour="panel-location">
                <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">1. Base Map or GIS</h2>

                {/* 선택된 RAPA 대상 정보 카드 — 상단바 RAPA Key 드롭다운과 연동 */}
                {aptListError && (
                  <div className="text-[10px] text-red-400 p-1.5 mb-2 bg-red-950/20 rounded border border-red-900/30 leading-tight">
                    apt_list.csv 로드 실패: {aptListError}
                  </div>
                )}
                {selectedAptRow ? (
                  <div className="border border-accent/40 rounded-lg p-3 bg-accent/5 space-y-1.5 mb-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-accent text-[11px]">{selectedAptRow.rapaKey}</span>
                      <span className="text-[9px] text-text-secondary">{selectedAptRow.hq} · {selectedAptRow.sido}</span>
                    </div>
                    {lastMoiraSource ? (
                      <span className={`inline-block text-[9px] font-mono px-1.5 py-0.5 rounded ${lastMoiraSource === 'athena-live' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-cyan-500/20 text-cyan-300'
                        }`}>
                        {lastMoiraSource === 'athena-live' ? '✓ Athena 실시간' : '◐ 배치 캐시'}
                      </span>
                    ) : (
                      <span className="inline-block text-[9px] font-mono px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">
                        ✕ MOIRA 폴리곤 조회 실패
                      </span>
                    )}
                    <div className="text-text-primary font-semibold text-[12px] truncate">{selectedAptRow.buildingName}</div>
                    <div className="text-[10px] text-text-secondary truncate">{selectedAptRow.address}</div>
                    <div className="text-[10px] text-text-secondary font-mono">
                      {selectedAptRow.lat.toFixed(6)}, {selectedAptRow.lng.toFixed(6)}
                    </div>
                    <div className="flex items-center justify-between pt-1 border-t border-zinc-800">
                      <span className="text-[10px] text-text-secondary">관로동</span>
                      {hasConduitBuilding(selectedAptRow) ? (
                        <span className="text-[10px] text-amber-300 font-mono text-right max-w-[180px] truncate" title={selectedAptRow.conduitBuilding}>
                          {selectedAptRow.conduitBuilding}
                        </span>
                      ) : (
                        <span className="text-[10px] text-zinc-500">해당없음 (건물 전체 대상)</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-[10px] text-text-secondary leading-relaxed mb-2">
                    상단바에서 RAPA Key를 선택하면 대상 아파트 정보와 단지/건물 폴리곤이 여기 표시됩니다. ({aptList.length}건 로드됨)
                  </p>
                )}

                {/* ==================================================================
                    python(Flask) 연동 — DB 재조회 / CAD 도면 처리
                    이 앱은 정적 배포라 python 실행·DB 접속이 불가하므로 Flask 앱에 위임한다.
                    ================================================================== */}
                <div className="border border-border-color rounded-lg p-3 bg-zinc-950/40 space-y-2.5 mb-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-accent tracking-wider uppercase flex items-center">
                      <Database className="w-3.5 h-3.5 mr-1.5" /> DB 실시간 조회
                    </span>
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                        pyApiOnline === null
                          ? 'bg-zinc-800 text-zinc-400'
                          : pyApiOnline
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-red-500/20 text-red-300'
                      }`}
                      title={
                        pyApiOnline
                          ? 'Flask(python) API에 연결됨'
                          : 'Flask 서버에 연결할 수 없습니다 — python app.py 실행 필요'
                      }
                    >
                      {pyApiOnline === null ? '확인 중' : pyApiOnline ? '● Flask 연결됨' : '○ Flask 없음'}
                    </span>
                  </div>

                  <p className="text-[10px] text-text-secondary leading-relaxed">
                    단지/건물 폴리곤과 자사 안테나를 사내 DB에서 지금 다시 가져옵니다.
                    조회에 수 분이 걸릴 수 있으며, 진행률이 아래에 표시됩니다.
                  </p>

                  <div className="flex gap-1.5">
                    <button
                      onClick={handlePyRefreshGeo}
                      disabled={pyBusy || !selectedAptRow || pyApiOnline === false}
                      className="flex-1 text-[10px] px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200 flex items-center justify-center gap-1"
                      title="단지 폴리곤 + 건물(단지 내 + 주변 65m)을 DB에서 재조회"
                    >
                      <Database className="w-3 h-3" /> 폴리곤 재조회
                    </button>
                    <button
                      onClick={handlePyRefreshAntennas}
                      disabled={pyBusy || !selectedAptRow || pyApiOnline === false}
                      className="flex-1 text-[10px] px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200 flex items-center justify-center gap-1"
                      title="주변 65m 자사 안테나를 DB에서 재조회"
                    >
                      <RadioTower className="w-3 h-3" /> 안테나 재조회
                    </button>
                  </div>

                  {/* 진행률 — Flask가 보내주는 단계별 메시지를 그대로 보여준다 */}
                  {pyBusy && (
                    <div className="space-y-1">
                      <div className="h-1 bg-zinc-800 rounded overflow-hidden">
                        <div
                          className="h-full bg-accent transition-all"
                          style={{
                            width: pyJob?.progress?.total
                              ? `${Math.round((pyJob.progress.done / pyJob.progress.total) * 100)}%`
                              : '40%',
                          }}
                        />
                      </div>
                      <div className="text-[9px] text-text-secondary font-mono truncate">
                        {pyJob?.progress?.message || '요청 중...'}
                      </div>
                    </div>
                  )}

                  {pyApiOnline === false && (
                    <div className="text-[9px] text-amber-300 bg-amber-950/20 border border-amber-900/30 rounded p-1.5 leading-tight">
                      Flask 서버에 연결할 수 없습니다. 로컬에서는 playground-daily-tmap-data-querying-l 에서
                      <span className="font-mono text-amber-200"> python app.py </span>
                      를 실행하세요.
                    </div>
                  )}
                </div>

                {/* 전체 자동 배치 — apt_list 전체 조회 → 파일 생성 → 10MB 검사 */}
                <BatchAutomationPanel online={pyApiOnline} notify={showAppNotification} />

                {/* CAD 도면 업로드 & 폴리곤 생성 */}
                <div className="mb-2">
                  <CadUploadPanel
                    rapaKey={selectedAptRow?.rapaKey ?? null}
                    complexName={selectedAptRow?.buildingName}
                    addrPrefix={selectedAptRow?.address}
                    lat={selectedAptRow?.lat}
                    lng={selectedAptRow?.lng}
                    onExtracted={handleCadExtracted}
                    notify={showAppNotification}
                  />
                </div>

                <p className="text-[10px] text-text-secondary leading-relaxed mb-2">
                  지도/배경/SHP 업로드, 지도 타일 전환, 샘플 데이터 로드, 검색창은 상단바로 이동했습니다.
                </p>

                {/* VWorld 검색 결과: 검색 입력창 자체는 상단바(UI-1.2)로 이동, 여기는 옵션 + 결과 리스트 */}
                <div className="border border-border-color rounded-lg p-3 bg-zinc-950/40 space-y-3 mt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-accent tracking-wider uppercase flex items-center">
                      <RadioTower className="w-3.5 h-3.5 mr-1.5 animate-pulse" /> VWorld 검색 결과
                    </span>
                    <span className="text-[9px] text-gray-500 font-mono">GetFeature 2.0</span>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-[10px] text-text-secondary">건물 데이터</span>
                        <span className="ml-1.5 px-1.5 py-0.5 bg-[var(--d-v1)]/20 text-[var(--d-v1)] text-[9px] rounded font-mono">LT_C_SPBD</span>
                        <span className="ml-1 text-[9px] text-gray-500">(도로명건물 외경)</span>
                      </div>
                      <label className="flex items-center space-x-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={useNameFilter}
                          onChange={e => setUseNameFilter(e.target.checked)}
                          className="rounded bg-bg-accent border-border-color text-accent w-3 h-3"
                        />
                        <span className="text-[10px] text-text-secondary whitespace-nowrap">단지명 필터</span>
                      </label>
                    </div>
                  </div>

                  {/* Status and Candidates list */}
                  {searchStatus === 'searching' && (
                    <div className="text-[11px] text-accent flex items-center justify-center py-1 bg-bg-accent/30 rounded">
                      <RotateCcw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> 단지 대표위치 검색 중...
                    </div>
                  )}

                  {searchStatus === 'no_result' && (
                    <div className="text-[11px] text-warning text-center py-1 bg-bg-accent/30 rounded">
                      검색 결과가 없습니다.
                    </div>
                  )}

                  {searchStatus === 'error' && (
                    <div className="text-[10px] text-red-400 p-1.5 bg-red-950/20 rounded border border-red-900/30 font-mono break-all leading-tight">
                      {errorMessage}
                    </div>
                  )}

                  {isFetchingPolygons && (
                    <div className="text-[11px] text-warning flex items-center justify-center py-1.5 bg-bg-accent/30 rounded border border-warning/10 animate-pulse">
                      <RotateCcw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> 단지 건물 폴리곤 다운로드 중...
                    </div>
                  )}

                  {searchCandidates.length > 0 && searchStatus === 'success' && (
                    <div className="space-y-1.5 pt-1.5 border-t border-zinc-800">
                      <span className="text-[10px] text-text-secondary font-semibold block mb-1">검색 결과 ({searchCandidates.length}):</span>
                      <div className="max-h-36 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                        {searchCandidates.map((c, idx) => (
                          <button
                            key={idx}
                            onClick={() => handleSelectCandidate(c)}
                            disabled={isFetchingPolygons}
                            className="w-full text-left p-1.5 bg-zinc-900 border border-zinc-800 rounded hover:border-accent hover:bg-zinc-800/80 transition-all text-[11px] line-clamp-2 block group cursor-pointer"
                          >
                            <div className="font-bold text-text-primary group-hover:text-accent transition-colors truncate">
                              {stripHtml(c.title)}
                            </div>
                            <div className="text-[9px] text-gray-400 truncate">
                              {c.address?.road || c.address?.parcel || '주소 정보 없음'}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {activePanel === 'duct' && (
              <div className="space-y-4">
                {/* ==================================================================
                    [관로동 추천] 투자 2년 전 시점에 '어느 동에 장비를 넣을지' 수동 선정용.
                    기존 LOS 시뮬레이션을 그대로 쓰되 조건만 보수적으로 바꾼다:
                      ① 목표 커버율 상향(기본 90%) — 나머지 파라미터는 모델입력 값 그대로
                      ② 단지 폴리곤 밖 건물: 차폐로만 쓰고 설치·커버리지 모수에서 제외
                      ③ 기준 분석 사이트 수 × 배수를 상한으로 걸어 과증가·장시간 연산 방지
                    ================================================================== */}
                <div>
                  <h2 className="text-sm font-semibold text-text-primary mb-1">관로동 추천</h2>
                  <p className="text-[11px] text-text-secondary leading-relaxed">
                    설계 전 단계에서 관로동(장비가 들어갈 동)을 고르기 위한 보수적 분석입니다.
                    기본 분석보다 목표 커버율을 올리고 단지 안 건물만 후보로 두어, 평소보다 여유 있게 후보를 뽑습니다.
                  </p>
                </div>

                <div className="space-y-2.5">
                  <div>
                    <label className="text-[10px] text-text-secondary block mb-1">목표 커버율 (%) — 기본 분석 {params.targetCoverage}%</label>
                    <input type="number" min={50} max={100} value={ductTarget}
                      onChange={e => setDuctTarget(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-text-primary font-mono" />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-secondary block mb-1">사이트 수 상한 (기준 분석 대비 배수)</label>
                    <input type="number" min={1} max={5} step={0.5} value={ductMultiplier}
                      onChange={e => setDuctMultiplier(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-text-primary font-mono" />
                    <p className="text-[10px] text-text-secondary mt-1 leading-relaxed">
                      목표 커버율에 못 미쳐도 이 개수에서 멈춥니다. 기준 사이트 수는 현재 결과가 있으면 그 값을, 없으면 기준 분석을 한 번 돌려 정합니다.
                    </p>
                  </div>
                  <div className="text-[10px] text-text-secondary border border-border-color rounded p-2 leading-relaxed">
                    · 단지 밖 건물은 신호를 막는 장애물로만 계산하고 장비를 올리지 않습니다.<br />
                    · 커버리지 분모도 단지 안 세대만 씁니다.<br />
                    · 빔폭·도달거리·후보 간격 등 나머지 조건은 모델입력 값을 그대로 씁니다.
                  </div>
                  <button
                    onClick={handleRunDuctRecommend}
                    disabled={isSimulating || buildings.length === 0}
                    className="w-full py-2 bg-[#00e5ff]/15 border border-[#00e5ff]/60 rounded text-xs text-[#9beef8] hover:bg-[#00e5ff]/25 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Play className="w-3.5 h-3.5 mr-1.5" /> {isSimulating ? '분석 중…' : '관로동 추천 실행'}
                  </button>
                </div>

                {ductRunInfo && (
                  <div className="text-[10px] font-mono text-text-secondary border border-border-color rounded p-2 space-y-0.5">
                    <div>기준 사이트 {ductRunInfo.baseline}개 → 상한 {ductRunInfo.cap}개</div>
                    <div>추천 결과 사이트 {ductRunInfo.sites}개 · 커버율 {ductRunInfo.coverage.toFixed(1)}% / 목표 {ductRunInfo.target}%</div>
                  </div>
                )}

                {ductRows.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-2)' }}>동별 추천 결과</span>
                      <span className="text-[9px] text-text-secondary">추천 {ductRows.filter(r => r.recommended).length}동 · CAD 관로동 {ductRows.filter(r => r.cad).length}동</span>
                    </div>
                    <div className="border border-border-color rounded overflow-hidden">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="bg-bg-accent text-text-secondary">
                            <th className="text-left px-2 py-1 font-medium">동</th>
                            <th className="text-right px-2 py-1 font-medium">사이트</th>
                            <th className="text-right px-2 py-1 font-medium">섹터</th>
                            <th className="text-center px-2 py-1 font-medium">CAD</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ductRows.map(r => (
                            <tr key={r.name} className={`border-t border-border-color ${r.recommended ? '' : 'opacity-60'}`}>
                              <td className="px-2 py-1 text-text-primary">{r.name}</td>
                              <td className="px-2 py-1 text-right font-mono">{r.sites || '-'}</td>
                              <td className="px-2 py-1 text-right font-mono">{r.sectors || '-'}</td>
                              <td className="px-2 py-1 text-center">{r.cad ? <span className="text-amber-300">관로동</span> : <span className="text-zinc-600">-</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[10px] text-text-secondary mt-1 leading-relaxed">
                      CAD 열은 도면에서 읽은 관로동 표시입니다. 추천과 다르면 도면 설계와 커버리지 판단이 갈린 동이니 직접 확인해 주세요.
                    </p>
                  </div>
                )}
              </div>
            )}

            {activePanel === 'model' && (
              <section>
                <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">Step 2 · AI 예측 (모델 입력)</h2>
                <p className="text-[11px] text-text-secondary leading-relaxed mb-3">
                  사내 DB의 아파트 피처(세대수/동수/바닥면적/지상층수 등)를 기반으로 LightGBM 모델이
                  추천 장비 수량을 예측합니다. 아래는 시각적 스캐폴딩이며, 실제 추론 로직은 다음 단계에서 연결됩니다.
                </p>

                {/* 피처 요약 카드 — TODO(백엔드 연동): 선택된 APT의 세대수/동수/바닥면적/지상층수를 여기 바인딩 */}
                <div className="bg-bg-accent border border-border-color rounded-xl p-4 text-xs space-y-2 font-mono">
                  <div className="flex justify-between"><span className="text-text-secondary font-sans">세대수</span><span className="text-text-primary">—</span></div>
                  <div className="flex justify-between"><span className="text-text-secondary font-sans">동수</span><span className="text-text-primary">—</span></div>
                  <div className="flex justify-between"><span className="text-text-secondary font-sans">바닥면적</span><span className="text-text-primary">—</span></div>
                  <div className="flex justify-between"><span className="text-text-secondary font-sans">지상층수</span><span className="text-text-primary">—</span></div>
                </div>

                {/* 실행 버튼 — TODO(백엔드 연동): onnxruntime-web 세션 추론 호출로 교체 */}
                <button
                  onClick={() => {
                    // placeholder demo: 실제 구현에서는 이 자리에서 onnx 세션 run() 호출
                    setAiPredResult({ rawPred: 3.82, finalPred: 4 });
                    setAiRevealed(true);
                  }}
                  className="w-full mt-3 py-2.5 rounded-lg font-bold text-sm flex items-center justify-center cursor-pointer transition-all hover:brightness-105"
                  style={{ background: 'var(--shell-accent)', color: 'var(--shell-ink)' }}
                >
                  ⚡ AI 예측 실행
                </button>

                {aiRevealed && aiPredResult && (
                  <div className="mt-3 rounded-xl p-4.5" style={{ background: 'var(--shell-ink)' }}>
                    <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--shell-ink-4)' }}>추천 장비 수 (final_pred)</div>
                    <div className="mt-1">
                      <span style={{ fontFamily: 'var(--shell-font-display)', fontSize: 40, fontWeight: 700, color: 'var(--shell-accent)' }}>
                        {aiPredResult.finalPred}
                      </span>
                      <span className="ml-2 text-sm font-medium" style={{ color: 'var(--shell-ink-4)' }}>EA</span>
                    </div>
                    <div className="mt-2 text-[11px] font-mono" style={{ color: 'var(--shell-ink-dark-sub)' }}>
                      raw_pred {aiPredResult.rawPred} · onnxruntime-web · LightGBM
                    </div>
                  </div>
                )}
              </section>
            )}

            {activePanel === 'tools' && (
              <section>
                <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">2. Draw Areas</h2>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setMode(prev => (prev === 'building' ? 'idle' : 'building'))}
                    className={`flex flex-col items-center p-2 rounded border cursor-pointer transition-colors ${mode === 'building' ? 'bg-bg-accent border-accent text-accent' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
                  >
                    <Square className="w-4.5 h-4.5 mb-1" />
                    <span className="text-[10px] font-medium text-center leading-tight">Building</span>
                  </button>
                  <button
                    onClick={() => setMode(prev => (prev === 'veranda' ? 'idle' : 'veranda'))}
                    className={`flex flex-col items-center p-2 rounded border cursor-pointer transition-colors ${mode === 'veranda' ? 'bg-bg-accent border-warning text-warning' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
                  >
                    <Minus className="w-4.5 h-4.5 mb-1" />
                    <span className="text-[10px] font-medium text-center leading-tight">1st 베란다</span>
                  </button>
                  <button
                    onClick={() => setMode(prev => (prev === 'second_veranda' ? 'idle' : 'second_veranda'))}
                    className={`flex flex-col items-center p-2 rounded border cursor-pointer transition-colors ${mode === 'second_veranda' ? 'bg-slate-800 border-slate-400 text-slate-200 font-semibold' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
                  >
                    <Minus className="w-4.5 h-4.5 mb-1" />
                    <span className="text-[10px] font-medium text-center leading-tight">2nd 베란다</span>
                  </button>
                  <button
                    onClick={() => setMode(prev => (prev === 'ruler' ? 'idle' : 'ruler'))}
                    className={`flex flex-col items-center p-2 rounded border cursor-pointer transition-colors ${mode === 'ruler' ? 'bg-bg-accent border-[#ff3d00] text-[#ff3d00]' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
                  >
                    <Ruler className="w-4.5 h-4.5 mb-1" />
                    <span className="text-[10px] font-medium text-center leading-tight">Scale Ruler</span>
                  </button>
                  <button
                    onClick={() => setMode(prev => (prev === 'eraser' ? 'idle' : 'eraser'))}
                    className={`flex flex-col items-center p-2 rounded border cursor-pointer transition-colors ${mode === 'eraser' ? 'bg-bg-accent border-error text-error' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
                  >
                    <Eraser className="w-4.5 h-4.5 mb-1" />
                    <span className="text-[10px] font-medium text-center leading-tight">Eraser</span>
                  </button>
                  <button
                    onClick={() => setMode(prev => (prev === 'equipment' ? 'idle' : 'equipment'))}
                    className={`flex flex-col items-center p-2 rounded border cursor-pointer transition-colors ${mode === 'equipment' ? 'bg-bg-accent border-[#ffb300] text-[#ffb300]' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
                  >
                    <RadioTower className="w-4.5 h-4.5 mb-1" />
                    <span className="text-[10px] font-medium text-center leading-tight">Place Site</span>
                  </button>
                </div>

                {/* Undo / Redo Row */}
                <div className="flex space-x-2 mt-2">
                  <button
                    onClick={handleUndo}
                    disabled={historyState.index <= 0}
                    className="flex-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center py-1.5 bg-bg-accent rounded border border-border-color transition-colors cursor-pointer"
                  >
                    <Undo className="w-3.5 h-3.5 mr-1" /> Undo
                  </button>
                  <button
                    onClick={handleRedo}
                    disabled={historyState.index >= historyState.history.length - 1}
                    className="flex-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center py-1.5 bg-bg-accent rounded border border-border-color transition-colors cursor-pointer"
                  >
                    <Redo className="w-3.5 h-3.5 mr-1" /> Redo
                  </button>
                </div>

                {/* Ruler Calibration Card */}
                {rulerLine && (
                  <div className="mt-2.5 p-2.5 bg-red-950/40 border border-red-800/60 rounded text-xs space-y-2">
                    <div className="flex items-center text-red-400 font-bold text-[11px]">
                      <Ruler className="w-4 h-4 mr-1.5 shrink-0" /> 스케일 보정 (Scale Calibration)
                    </div>
                    <p className="text-[10px] text-gray-300">
                      그려진 선: <strong className="text-text-primary font-mono">{Math.round(Math.sqrt((rulerLine.end.x - rulerLine.start.x) ** 2 + (rulerLine.end.y - rulerLine.start.y) ** 2))} px</strong>
                    </p>
                    <div className="flex items-center space-x-1.5">
                      <span className="text-[10px] text-gray-400 shrink-0">실제 거리:</span>
                      <input
                        type="number"
                        value={rulerInputMeters}
                        onChange={e => setRulerInputMeters(e.target.value)}
                        className="w-20 px-2 py-0.5 bg-bg-main border border-gray-700 rounded text-xs text-text-primary font-mono text-center focus:border-red-500"
                        placeholder="미터"
                      />
                      <span className="text-[10px] text-gray-400 shrink-0">미터(m)</span>
                      <button
                        onClick={handleApplyRulerCalibration}
                        className="px-2 py-1 bg-red-600 text-text-primary rounded text-[10px] font-bold hover:bg-red-500 transition-colors shrink-0 cursor-pointer"
                      >
                        적용
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-xs text-text-secondary mt-2">
                  {mode === 'building' && "Click to add points. Right-click to finish polygon."}
                  {mode === 'veranda' && "Click start and end points to draw a standard (1등급) veranda."}
                  {mode === 'second_veranda' && "Click start and end points to draw a second (2등급, 70% 가중치) veranda."}
                  {mode === 'ruler' && "Click start and end points of a known distance to calibrate scale (Pixels/Meter)."}
                  {mode === 'equipment' && "Click on the map/building edges to place a co-located 3-sector site."}
                  {mode === 'eraser' && "Click on a building, veranda, or site to remove it."}
                  {mode === 'idle' && "Select a tool to start drawing."}
                </p>

                <div className="mt-3.5 pt-2 border-t border-zinc-800 space-y-1.5 text-[10px]">
                  <div className="flex items-center justify-between text-text-secondary mb-1">
                    <span className="font-semibold uppercase tracking-wider text-[9px]">Simulation Targets</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="w-4 h-1.5 rounded bg-[var(--d-v1)]"></span>
                    <span className="text-gray-300">베란다 (Primary : 100% 점수)</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="w-4 h-1 border-t-2 border-dashed border-[var(--d-v2)]"></span>
                    <span className="text-gray-300">Second 베란다 (긴 벽면 : 70% 점수)</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="w-1.5 h-1.5 bg-gray-500 rounded-full"></span>
                    <span className="text-zinc-500">짧은 측면 벽 (콘크리트 : 노카운트)</span>
                  </div>
                </div>

                {/* [단지 위치 보정] CAD 추출 단지의 위치·방위를 VWorld 필지 경계와 형상 정합으로 맞춘다 (src/lib/georef.ts).
                    자동 보정 → 화면 적용 → 주황 파선(기준 경계)과 겹침 확인 → 보정 저장. 자동이 안 되면 수동 이동/회전 (2026-09-11) */}
                <div className="mt-3.5 border border-amber-800/50 rounded-lg p-2.5 bg-amber-950/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-amber-300 uppercase tracking-wider">단지 위치 보정</span>
                    {(sourceMoira as any)?.georeference?.confidence && (
                      <span className="text-[9px] font-mono text-amber-400/80" title={String((sourceMoira as any).georeference.method || '')}>
                        현재 신뢰도: {String((sourceMoira as any).georeference.confidence)}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-text-secondary leading-relaxed">
                    단지 모양과 같은 필지(지번형)·구역(블록형)을 VWorld에서 찾아 위치·방위를 맞춥니다. 주황 파선 = 정합 기준 경계.
                  </p>
                  <button
                    onClick={handleGeorefAuto}
                    disabled={!sourceMoira || georefBusy}
                    className="w-full py-1.5 bg-amber-900/40 border border-amber-700 rounded text-xs text-amber-100 hover:bg-amber-800/50 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Search className="w-3 h-3 mr-1" /> {georefBusy ? '필지 조회·정합 중…' : '자동 보정 (필지 형상 정합)'}
                  </button>
                  {georefProposal && (
                    <div className="text-[10px] leading-relaxed rounded border border-amber-900/60 p-1.5 space-y-1">
                      {georefProposal.best && (
                        <div className="font-mono text-amber-200">
                          [{georefProposal.confidence}] {georefProposal.best.label} · IoU {georefProposal.best.iou.toFixed(3)}<br />
                          이동 {georefProposal.best.shiftM}m · 회전 {georefProposal.best.rotDeg}° · 면적비 {georefProposal.best.areaRatio}
                        </div>
                      )}
                      <div className="text-text-secondary">{georefProposal.reason}</div>
                      {georefProposal.best && (georefProposal.best.shiftM > 0.5 || Math.abs(georefProposal.best.rotDeg) > 0.05) && (
                        <button onClick={handleGeorefApply} className="w-full py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">보정안 화면 적용</button>
                      )}
                    </div>
                  )}
                  <div className="text-[10px] text-text-secondary">수동 미세조정 (보폭
                    <select value={georefStep} onChange={e => setGeorefStep(Number(e.target.value))} className="mx-1 bg-transparent border border-border-color rounded text-[10px]">
                      {[1, 5, 20, 100].map(v => <option key={v} value={v}>{v}m</option>)}
                    </select>)
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(0, 0, 1)} title="반시계 1°" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">⟲ 1°</button>
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(0, georefStep, 0)} title="북쪽으로" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">↑</button>
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(0, 0, -1)} title="시계 1°" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">⟳ 1°</button>
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(-georefStep, 0, 0)} title="서쪽으로" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">←</button>
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(0, -georefStep, 0)} title="남쪽으로" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">↓</button>
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(georefStep, 0, 0)} title="동쪽으로" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">→</button>
                    {/* 직사각형 단지는 180° 뒤집어도 경계가 같아 자동 판별이 안 될 수 있다 → 방향 확인용 큰 회전 */}
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(0, 0, 90)} title="반시계 90°" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">⟲ 90°</button>
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(0, 0, 180)} title="180° 뒤집기 (방향 대칭 후보 확인)" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">180°</button>
                    <button disabled={!sourceMoira} onClick={() => handleGeorefNudge(0, 0, -90)} title="시계 90°" className="py-1 bg-amber-900/30 border border-amber-800/70 rounded text-[11px] text-amber-100 hover:bg-amber-800/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">⟳ 90°</button>
                  </div>
                  {Array.isArray((sourceMoira as any)?.georeference?.georef_fit?.rotationCandidates) && (
                    <div className="text-[10px] text-amber-300/90">⚠ 방향 대칭: 경계 모양만으로는 현재 방향과 180° 반대를 구분 못함 — 건물 배치를 확인하고 필요하면 180° 뒤집기 후 저장</div>
                  )}
                  <button
                    onClick={handleGeorefSave}
                    disabled={!georefDirty || isSavingDb}
                    className="w-full py-1.5 bg-emerald-900/40 border border-emerald-700 rounded text-xs text-emerald-200 hover:bg-emerald-800/50 transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Database className="w-3 h-3 mr-1" /> {georefDirty ? '보정 저장 (원본 반영)' : '저장할 변경 없음'}
                  </button>
                </div>

                {/* [DB 저장] 지우개 등으로 교정한 건물 폴리곤을 원본 소스 JSON에 반영 — Save Topology(export)와 역할이 다름.
                    수정 직후 바로 쓰는 동작이라 도구 탭으로 이동 (2026-08-15) */}
                <div className="mt-3.5 pt-2.5 border-t border-zinc-800 border border-emerald-800/50 rounded-lg p-2.5 bg-emerald-950/20 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-emerald-300 uppercase tracking-wider">건물 폴리곤 교정 (DB)</span>
                    {sourceMoira && (
                      <span className="text-[9px] font-mono text-emerald-400/70">{sourceMoira.buildings?.length ?? 0}동 원본</span>
                    )}
                  </div>
                  <p className="text-[10px] text-text-secondary leading-relaxed">
                    지우개로 중첩·불량 폴리곤을 정리한 뒤 저장하면 원본 JSON(<span className="font-mono">temps/{selectedRapaKey || '<rapaKey>'}.json</span>)이 교정되어,
                    다시 불러올 때와 LOS 배치에도 반영됩니다.
                  </p>
                  <button
                    onClick={handleSaveToDb}
                    disabled={!sourceMoira || isSavingDb}
                    title={sourceMoira ? 'DB(원본 JSON)에 교정 결과 저장' : 'RAPA Key로 불러온 단지에서만 사용할 수 있습니다'}
                    className="w-full py-1.5 bg-emerald-900/40 border border-emerald-700 rounded text-xs text-emerald-200 hover:bg-emerald-800/50 hover:text-text-primary transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Database className="w-3 h-3 mr-1" /> {isSavingDb ? '저장 중…' : 'DB 저장 (원본 반영)'}
                  </button>
                  <button
                    onClick={handleRestoreDb}
                    disabled={!selectedRapaKey || isSavingDb}
                    title="DB 저장 이전 원본으로 되돌리기"
                    className="w-full py-1 bg-transparent border border-border-color rounded text-[10px] text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Undo className="w-3 h-3 mr-1" /> 원본으로 복원
                  </button>
                </div>

                {/* 프로젝트 입출력 — '위치' 탭에서 이동(2026-08-15).
                    편집을 끝낸 자리에서 바로 저장할 수 있도록 편집 도구와 같은 탭에 둔다. */}
                <div className="mt-3.5 pt-2.5 border-t border-border-color">
                  <div className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--ink-2)' }}>
                    프로젝트 입출력
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <button onClick={handleSaveTopology} className="w-full py-1.5 bg-bg-accent border border-border-color rounded text-xs text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center cursor-pointer">
                      <Save className="w-3 h-3 mr-1" /> 내보내기
                    </button>
                    <label className="w-full py-1.5 bg-bg-accent border border-border-color rounded text-xs text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center cursor-pointer">
                      <FolderOpen className="w-3 h-3 mr-1" /> 불러오기
                      <input type="file" className="hidden" accept=".json" onChange={handleLoadTopology} />
                    </label>
                  </div>
                  <button onClick={handleExportGeoJSON} className="w-full py-1.5 bg-bg-accent border border-border-color rounded text-xs text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center cursor-pointer">
                    <Download className="w-3 h-3 mr-1" /> GeoJSON Export
                  </button>
                  <p className="text-[10px] mt-1.5 leading-relaxed" style={{ color: 'var(--ink-3)' }}>
                    현재 화면 상태를 파일로 저장합니다. 원본 JSON 교정은 위의 <span style={{ color: 'var(--ink-2)' }}>DB 저장</span>을 쓰세요.
                  </p>
                </div>

                <button onClick={clearDrawing} className="mt-3 text-xs text-text-secondary hover:text-text-primary flex items-center cursor-pointer">
                  <RotateCcw className="w-3 h-3 mr-1" /> Clear All Drawings
                </button>
              </section>
            )}

            {activePanel === 'settings' && (
              <section>
                <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">3. Parameters</h2>
                <div className="space-y-3">
                  {/* VWorld API Key & Proxy Options (UI-3.2) — 위치 패널에서 이동 */}
                  <div className="border border-border-color rounded-lg p-3 bg-zinc-950/40 space-y-2 text-xs">
                    <span className="text-[10px] font-bold text-accent tracking-wider uppercase">VWorld 연결 설정</span>
                    <div>
                      <label className="text-[10px] text-text-secondary block mb-0.5">VWorld 인증키</label>
                      <input
                        type="password"
                        placeholder="인증키가 없을 시 동작하지 않습니다"
                        value={vworldKey}
                        onChange={e => setVworldKey(e.target.value)}
                        className="w-full px-2 py-1 bg-bg-accent border border-border-color rounded font-mono text-[11px] text-text-primary focus:outline-none focus:border-accent"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-0.5">
                        <label className="text-[10px] text-text-secondary">VWorld 등록 도메인</label>
                        <span className="text-[9px] text-[#00e5ff] font-mono select-all">접속도메인: {window.location.origin}</span>
                      </div>
                      <input
                        type="text"
                        placeholder="예: localhost 또는 현재 사이트 주소"
                        value={vworldDomain}
                        onChange={e => setVworldDomain(e.target.value)}
                        className="w-full px-2 py-1 bg-bg-accent border border-border-color rounded font-mono text-[11px] text-text-primary focus:outline-none focus:border-accent"
                      />
                      <p className="text-[9px] text-gray-400 mt-1 leading-normal">
                        💡 브이월드 오픈플랫폼에서 발급받은 인증키의 <strong>등록 도메인</strong> 정보와 완전히 일치해야 합니다.
                      </p>
                    </div>
                    <div>
                      <label className="text-[10px] text-text-secondary block mb-1">API 호출 방식</label>
                      <div className="grid grid-cols-2 gap-1 bg-bg-accent p-0.5 rounded border border-border-color">
                        <button
                          type="button"
                          onClick={() => setVworldRequestMode('direct')}
                          className={`py-1 text-[10px] font-medium rounded transition-all ${vworldRequestMode === 'direct' ? 'bg-[#00e5ff] text-zinc-950 font-semibold shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                        >
                          직접 호출 (WAF 우회 권장)
                        </button>
                        <button
                          type="button"
                          onClick={() => setVworldRequestMode('proxy')}
                          className={`py-1 text-[10px] font-medium rounded transition-all ${vworldRequestMode === 'proxy' ? 'bg-[#00e5ff] text-zinc-950 font-semibold shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
                        >
                          서버 프록시 경유
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-text-secondary block mb-1">Pixels per Meter (Scale)</label>
                    <input type="number" value={params.pixelsPerMeter} onChange={e => setParams({ ...params, pixelsPerMeter: Number(e.target.value) })} className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-text-primary font-mono" />
                  </div>
                  <div>
                    <label className="text-xs text-text-secondary block mb-1">Target Coverage (%)</label>
                    <input type="number" value={params.targetCoverage} onChange={e => setParams({ ...params, targetCoverage: Number(e.target.value) })} className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-text-primary font-mono" />
                  </div>
                  <div>
                    <label className="text-xs text-text-secondary block mb-1">Beam Width (°)</label>
                    <input type="number" value={params.beamWidth} onChange={e => setParams({ ...params, beamWidth: Number(e.target.value) })} className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-text-primary font-mono" />
                  </div>
                  <div>
                    <label className="text-xs text-text-secondary block mb-1">Max Range (m) <span className="text-[10px] text-accent">(Beam Radius)</span></label>
                    <input type="number" value={params.maxRange} onChange={e => setParams({ ...params, maxRange: Number(e.target.value) })} className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-text-primary font-mono" />
                  </div>
                  <div>
                    <label className="text-xs text-text-secondary block mb-1">
                      Adjacent Buffer (m) <span className="text-[10px] text-accent">(인접 건물 · 안테나 공통 반경)</span>
                    </label>
                    <input
                      type="number"
                      value={params.adjacentBuildingBuffer ?? STANDARD_SIM_PARAMS.adjacentBuildingBuffer}
                      onChange={e => {
                        const val = Number(e.target.value);
                        setParams(prev => ({ ...prev, adjacentBuildingBuffer: val }));
                      }}
                      className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-text-primary font-mono"
                    />
                    {/* WG 검증 중인 잠정값임을 명시 — 확정되면 이 안내를 갱신할 것 */}
                    <p className="text-[10px] text-text-secondary leading-snug mt-1">
                      단지 폴리곤에서 이 거리만큼 확장한 범위의
                      <span className="text-text-primary"> 건물</span>과
                      <span className="text-text-primary"> 자사 안테나</span>를 함께 반영합니다.
                      단, 단지 폴리곤 <span className="text-amber-300">내부의 안테나는 제외</span>됩니다
                      (아파트 준공 시 철거될 기존 장비).
                    </p>
                    <p className="text-[10px] text-amber-300/90 leading-snug mt-1">
                      ※ 기본값 65m는 <span className="font-semibold">Working Group에서 적정성 검증 중인
                      잠정값</span>입니다. 확정 시 변경될 수 있으며, 이 값을 바꾸면 건물·안테나에
                      동일하게 적용됩니다.
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-text-secondary block mb-1">
                      Facility Search Radius (m) <span className="text-[10px] text-emerald-400">(자사 시설 검색 반경)</span>
                    </label>
                    <input
                      type="number"
                      value={params.facilitySearchRadius ?? 150}
                      onChange={e => {
                        const val = Number(e.target.value);
                        setParams(prev => ({ ...prev, facilitySearchRadius: val }));
                      }}
                      className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-text-primary font-mono"
                    />
                  </div>
                  <div className="flex items-center space-x-2 pt-1">
                    <input type="checkbox" id="strictCo" checked={params.strictCoLocation} onChange={e => setParams({ ...params, strictCoLocation: e.target.checked })} className="rounded bg-bg-accent border-border-color cursor-pointer" />
                    <label htmlFor="strictCo" className="text-xs text-text-secondary cursor-pointer">Strict 1 Pole / Building</label>
                  </div>

                  {/* 3가지 시뮬레이션 분석 모드 선택 UI */}
                  <div className="pt-2 border-t border-border-color/50">
                    <label className="text-xs font-semibold text-text-secondary block mb-1.5 uppercase tracking-wide">
                      Simulation Execution Mode
                    </label>
                    <div className="space-y-1.5">
                      <label className={`flex items-start space-x-2 p-2 rounded border cursor-pointer transition-colors ${params.simulationMode === 'pure_manual' ? 'bg-amber-500/10 border-amber-500 text-text-primary' : 'bg-bg-accent/40 border-border-color/60 text-text-secondary hover:border-zinc-500'}`}>
                        <input
                          type="radio"
                          name="simMode"
                          checked={params.simulationMode === 'pure_manual'}
                          onChange={() => setParams({ ...params, simulationMode: 'pure_manual', preventAutoSectors: true })}
                          className="mt-0.5 accent-amber-500 cursor-pointer"
                        />
                        <div>
                          <div className="text-xs font-bold text-amber-400">1. 순수 수동 분석 (Pure Manual)</div>
                          <div className="text-[10px] leading-tight text-zinc-400 mt-0.5">내가 직접 생성한 Sector만으로 분석 (신규 Site X, 2차 베란다 자동 섹터 X)</div>
                        </div>
                      </label>

                      <label className={`flex items-start space-x-2 p-2 rounded border cursor-pointer transition-colors ${params.simulationMode === 'manual_second_veranda' ? 'bg-cyan-500/10 border-cyan-500 text-text-primary' : 'bg-bg-accent/40 border-border-color/60 text-text-secondary hover:border-zinc-500'}`}>
                        <input
                          type="radio"
                          name="simMode"
                          checked={params.simulationMode === 'manual_second_veranda'}
                          onChange={() => setParams({ ...params, simulationMode: 'manual_second_veranda', preventAutoSectors: true })}
                          className="mt-0.5 accent-cyan-500 cursor-pointer"
                        />
                        <div>
                          <div className="text-xs font-bold text-cyan-400">2. 수동 + 2차 베란다 자동 섹터</div>
                          <div className="text-[10px] leading-tight text-zinc-400 mt-0.5">수동 Sector 기반 + 기존 수동 Site에 2차 베란다용 여분 Sector만 자동 추가</div>
                        </div>
                      </label>

                      <label className={`flex items-start space-x-2 p-2 rounded border cursor-pointer transition-colors ${params.simulationMode === 'full_auto' || !params.simulationMode ? 'bg-emerald-500/10 border-emerald-500 text-text-primary' : 'bg-bg-accent/40 border-border-color/60 text-text-secondary hover:border-zinc-500'}`}>
                        <input
                          type="radio"
                          name="simMode"
                          checked={params.simulationMode === 'full_auto' || !params.simulationMode}
                          onChange={() => setParams({ ...params, simulationMode: 'full_auto', preventAutoSectors: false })}
                          className="mt-0.5 accent-emerald-500 cursor-pointer"
                        />
                        <div>
                          <div className="text-xs font-bold text-emerald-400">3. 풀 오토 최적화 (Full Auto)</div>
                          <div className="text-[10px] leading-tight text-zinc-400 mt-0.5">수동 Sector + 신규 Auto Site 탐색/배치 + 2차 베란다 여분 Sector 풀 최적화</div>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              </section>
            )}


            {/* 결과(Results) 콘텐츠는 우측 결과 드로어로 이동함 — 이 아래 참조: <div className="results-drawer"> */}
          </div>
        </div>
      )}

      <div className="flex-1 relative bg-bg-main flex flex-col overflow-hidden">
        {/* ==================== 상단바 (UI-1.x 매핑) ==================== */}
        <div className="shell-topbar">
          {/* ── 1줄: 대상 선택 — 뷰 탭 / 본부·시도·읍면동 필터 / RAPA Key / 검색 ── */}
          <div className="shell-topbar-row">
            <div className="shell-view-tabs shrink-0">
              <button data-tour="tab-map" className={`shell-view-tab ${mainView === 'map' ? 'active' : ''}`} onClick={() => setMainView('map')}>지도</button>
              <button data-tour="tab-list" className={`shell-view-tab ${mainView === 'list' ? 'active' : ''}`} onClick={() => setMainView('list')}>전체 리스트</button>
            </div>

            <div className="w-px h-6 shrink-0" style={{ background: 'var(--shell-line-strong)' }} />

            {/* 지역 필터 — 셀렉트 3개가 상단바 폭을 잡아먹어 팝오버 1개로 접음 (2026-08-15).
                선택된 값은 버튼에 요약 표시하고, 활성 시 액센트로 상태를 알린다. */}
            <div data-tour="topbar-target" className="relative shrink-0" ref={regionFilterRef}>
              <button
                onClick={() => setShowRegionFilter(v => !v)}
                title="본부 · 시도 · 읍면동 필터"
                className="topbar-select flex items-center gap-1.5 cursor-pointer"
                style={{
                  width: 'auto', minWidth: 96, maxWidth: 200,
                  ...(regionFilterCount > 0
                    ? { borderColor: 'var(--accent-line)', color: 'var(--accent)', background: 'var(--accent-soft)' }
                    : {}),
                }}
              >
                <Filter className="w-3 h-3 shrink-0" />
                <span className="truncate">{regionFilterLabel}</span>
                {regionFilterCount > 0 && (
                  <span className="ml-auto shrink-0 font-mono text-[10px] opacity-80">{regionFilterCount}</span>
                )}
                <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
              </button>

              {showRegionFilter && (
                <div
                  className="absolute left-0 top-full mt-1.5 z-50 rounded-[var(--r-card)] border p-3 space-y-2.5 shadow-xl"
                  style={{ width: 240, background: 'var(--surface-1)', borderColor: 'var(--line-strong)' }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ink-2)' }}>지역 필터</span>
                    <button
                      onClick={() => { setFilterHq(''); setFilterSido(''); setFilterEmd(''); }}
                      className="text-[10px] cursor-pointer hover:underline"
                      style={{ color: 'var(--ink-3)' }}
                    >초기화</button>
                  </div>
                  <select
                    value={filterHq}
                    onChange={e => { setFilterHq(e.target.value); setFilterSido(''); setFilterEmd(''); }}
                    className="topbar-select w-full"
                    title="본부"
                  >
                    <option value="">본부 전체</option>
                    {uniqueHqOptions.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                  <select
                    value={filterSido}
                    onChange={e => { setFilterSido(e.target.value); setFilterEmd(''); }}
                    className="topbar-select w-full"
                    title="시도"
                  >
                    <option value="">시도 전체</option>
                    {uniqueSidoOptions.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                  <select
                    value={filterEmd}
                    onChange={e => setFilterEmd(e.target.value)}
                    className="topbar-select w-full"
                    title="읍면동(행정동)"
                  >
                    <option value="">읍면동 전체</option>
                    {uniqueEmdOptions.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                  <div className="text-[10px] font-mono pt-0.5" style={{ color: 'var(--ink-3)' }}>
                    대상 {aptListFilteredByEmd.length}건
                  </div>
                </div>
              )}
            </div>
            {/* RAPA Key 부분검색 — 키 일부만 입력해 바로 조회 (예: 2206-3699) */}
            <div ref={rapaSearchBoxRef} className="relative shrink-0" style={{ width: 180 }}>
              <Search className="w-3.5 h-3.5 absolute pointer-events-none" style={{ left: 9, top: 8, color: 'var(--shell-ink-4)' }} />
              <input
                type="text"
                placeholder="RAPA Key 검색"
                value={rapaSearch}
                onChange={e => { setRapaSearch(e.target.value); setShowRapaSearch(true); }}
                onFocus={() => setShowRapaSearch(true)}
                onBlur={() => window.setTimeout(() => setShowRapaSearch(false), 150)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && rapaSearchResults.length > 0) {
                    handleSelectRapaKey(rapaSearchResults[0].rapaKey);
                    setShowRapaSearch(false);
                  } else if (e.key === 'Escape') {
                    setShowRapaSearch(false);
                  }
                }}
                className="topbar-search-input font-mono"
                style={{ paddingLeft: 28 }}
                title="RAPA Key 일부 또는 단지명 입력 후 Enter"
              />
              {showRapaSearch && rapaSearch.trim().length > 0 && rapaMenuRect && createPortal(
                <div
                  className="fixed max-h-80 overflow-y-auto rounded-md border shadow-2xl"
                  style={{
                    top: rapaMenuRect.top, left: rapaMenuRect.left, width: 330, zIndex: 9999,
                    background: 'var(--shell-bg-surface)', borderColor: 'var(--shell-line-strong)',
                  }}
                >
                  {rapaSearchResults.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-text-secondary">일치하는 RAPA Key가 없습니다.</div>
                  ) : rapaSearchResults.map(r => {
                    const cache = cachedKeyInfo[r.rapaKey];
                    return (
                      <button
                        key={r.rapaKey}
                        onMouseDown={e => { e.preventDefault(); handleSelectRapaKey(r.rapaKey); setShowRapaSearch(false); }}
                        className="w-full text-left px-3 py-1.5 hover:bg-bg-accent border-b border-border-color last:border-b-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] font-semibold text-accent">{r.rapaKey}</span>
                          {cache && (
                            <span className={`text-[9px] font-mono px-1 py-0.5 rounded shrink-0 ${cache.editedAt ? 'bg-amber-500/20 text-amber-600' : 'bg-cyan-500/20 text-cyan-700'}`}>
                              {cache.editedAt ? '교정됨' : '캐시'} {cache.buildingCount}동
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-text-secondary truncate">{r.buildingName} · {r.sigungu} {r.emd}</div>
                      </button>
                    );
                  })}
                </div>,
                document.body
              )}
            </div>

            <select
              value={selectedRapaKey}
              onChange={e => handleSelectRapaKey(e.target.value)}
              disabled={isFetchingPolygons}
              className="topbar-select font-mono"
              style={{ width: 240 }}
              title="RAPA Key — 🔴 단지 폴리곤 미확보 / 🟠 PDF 추출 폴리곤 / 📄 도면 이미지 확보"
            >
              <option value="">RAPA Key 선택 ({aptListFinal.length})</option>
              {aptListFinal.map(r => {
                const st = polygonStatus[r.rapaKey];
                const mark = st ? (st.hasComplex ? (st.source === 'pdf_extraction' ? '🟠 ' : '') : '🔴 ') : '';
                const plan = st?.hasPlan ? ' 📄' : '';
                return (
                  <option key={r.rapaKey} value={r.rapaKey}>{mark}{r.rapaKey} · {r.buildingName}{plan}</option>
                );
              })}
            </select>

            {/* daisyUI 폼 셀렉트 드롭다운: 폴리곤 필터 (옵션 B) */}
            <select
              value={polygonFilter}
              onChange={(e) => setPolygonFilter(e.target.value as any)}
              className={`select select-sm font-mono text-[11px] h-7 min-h-7 px-2 rounded-[var(--r-ctl)] outline-none cursor-pointer transition-colors shrink-0 ${
                polygonFilter === 'no_polygon'
                  ? 'select-error bg-red-500/10 text-red-400 border-red-500/60 font-semibold'
                  : polygonFilter === 'has_polygon'
                  ? 'select-success bg-emerald-500/10 text-emerald-400 border-emerald-500/60 font-semibold'
                  : 'select-bordered bg-[var(--surface-2)] text-[var(--ink-1)] border-[var(--shell-line-strong)]'
              }`}
              title="단지 폴리곤 확보 상태별 필터 (클릭하여 대상 선택)"
            >
              <option value="all">📁 폴리곤: 전체</option>
              <option value="no_polygon">🔴 미확보만</option>
              <option value="has_polygon">🟢 미확보 제외</option>
            </select>

            <div className="w-px h-6 shrink-0" style={{ background: 'var(--shell-line-strong)' }} />

            {/* VWorld 검색창 (UI-1.2) — 결과는 좌측 '위치' 패널에 표시 */}
            <div className="relative flex-1" style={{ minWidth: 200, maxWidth: 460 }}>
              <Search className="w-3.5 h-3.5 absolute pointer-events-none" style={{ left: 10, top: 8, color: 'var(--shell-ink-4)' }} />
              <input
                type="text"
                placeholder="아파트 단지명 또는 주소 검색"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { handleVWorldSearch(); setActivePanel('location'); }
                }}
                onFocus={() => setActivePanel('location')}
                className="topbar-search-input"
              />
            </div>

            {/* 테마 토글 — 다크/라이트 전환 (선택값 localStorage 유지) */}
            <button
              onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? '라이트 테마로 전환' : '다크 테마로 전환'}
              className="shrink-0 flex items-center justify-center rounded-[var(--r-ctl)] cursor-pointer transition-colors"
              style={{
                width: 30, height: 30,
                background: 'var(--surface-2)',
                border: '1px solid var(--line-strong)',
                color: 'var(--ink-2)',
              }}
            >
              {theme === 'dark'
                ? <Sun className="w-3.5 h-3.5" strokeWidth={1.8} />
                : <Moon className="w-3.5 h-3.5" strokeWidth={1.8} />}
            </button>

            <div className="flex-1" />

          </div>

          {/* ── 2줄: 지도 제어 — 맵 타일 / 줌 / 업로드·샘플 ── */}
          <div className="shell-topbar-row">
            {/* 맵 타일 세그먼트 (UI-1.3) */}
            <div className="flex items-center gap-0.5 rounded-md p-0.5 shrink-0" style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)' }}>
              {([
                { key: 'Base', label: '일반' },
                { key: 'Satellite', label: '위성' },
                { key: 'Hybrid', label: '하이브리드' },
                { key: 'None', label: '끄기' },
              ] as const).map(tile => (
                <button
                  key={tile.key}
                  onClick={() => {
                    setMapTileType(tile.key);
                    if (tile.key === 'None') { setImageSrc(null); imageRef.current = null; }
                    else if (geoMapping) loadOpenMapBackground(geoMapping, tile.key);
                  }}
                  className="px-2 py-1 rounded text-[10.5px] font-medium cursor-pointer transition-colors"
                  style={mapTileType === tile.key
                    ? { background: 'var(--surface-3)', color: 'var(--ink-1)', fontWeight: 600 }
                    : { color: 'var(--ink-2)' }}
                >
                  {tile.label}
                </button>
              ))}
            </div>

            <div className="w-px h-6 shrink-0" style={{ background: 'var(--shell-line-strong)' }} />


            {/* AI 베란다 자동 세팅 버튼 */}
            <button
              data-tour="btn-ai-veranda"
              onClick={handleAiAutoVerandas}
              title="단지 내 건물 베란다 자동 세팅 (1차 거실 / 2차 배면)"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--r-ctl)] text-[11px] font-semibold cursor-pointer transition-colors shrink-0"
              style={{
                background: 'var(--accent-fill)',
                color: 'var(--accent-on-fill)',
                border: '1px solid var(--accent-fill)'
              }}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>AI 베란다 세팅</span>
            </button>

            <a
              href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/veranda_ai_viewer_v2.html`}
              target="_blank"
              rel="noreferrer"
              title="새 창에서 AI 베란다 세팅 검증 뷰어 열기"
              className="flex items-center gap-1 px-2 py-1.5 rounded-[var(--r-ctl)] border text-[11px] font-medium cursor-pointer transition-colors shrink-0"
              style={{ borderColor: 'var(--line-strong)', color: 'var(--ink-2)' }}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>검증 뷰어</span>
            </a>

            <div className="w-px h-6 shrink-0" style={{ background: 'var(--shell-line-strong)' }} />

            {/* 아이콘 버튼 3개: SHP 업로드 / 배경 이미지 업로드 / 리셋·샘플 로드 (UI-1.4~1.6) */}
            <label
              title="SHP (.zip) 업로드"
              className="w-8 h-8 shrink-0 rounded-md border flex items-center justify-center cursor-pointer"
              style={{ borderColor: 'var(--shell-line-strong)', color: 'var(--shell-ink-2)' }}
            >
              <Database className="w-3.5 h-3.5" />
              <input type="file" className="hidden" accept=".zip" onChange={handleShpUpload} />
            </label>
            <label
              title="배경 도면 이미지 업로드 (JPG/PNG)"
              className="w-8 h-8 shrink-0 rounded-md border flex items-center justify-center cursor-pointer"
              style={{ borderColor: 'var(--shell-line-strong)', color: 'var(--shell-ink-2)' }}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
            </label>
            <button
              title="샘플 데이터 로드"
              onClick={loadSampleData}
              className="w-8 h-8 shrink-0 rounded-[var(--r-ctl)] border flex items-center justify-center cursor-pointer"
              style={{ borderColor: 'var(--line-strong)', color: 'var(--ink-2)' }}
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            <div className="w-px h-6 shrink-0" style={{ background: 'var(--line-strong)' }} />

            {/* Athena 쿼리 로그 — 1줄에서 이동(2026-08-15). 상태는 색+점 두 채널로 표시 */}
            <button
              onClick={() => setShowMoiraDebugModal(true)}
              title="최근 Athena 쿼리 결과 및 상세 로그 팝업"
              className="shrink-0 flex items-center gap-1.5 px-2.5 h-8 rounded-[var(--r-ctl)] text-[11px] font-medium border transition-colors cursor-pointer"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--line-strong)',
                color: moiraDebugInfo?.liveStatus === 'success' ? 'var(--st-good)'
                  : moiraDebugInfo?.liveStatus === 'failed' ? 'var(--st-crit)'
                  : 'var(--ink-2)',
              }}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>Athena 로그</span>
              {moiraDebugInfo && (
                <span
                  className={`w-1.5 h-1.5 rounded-full ${moiraDebugInfo.liveStatus === 'idle' ? 'animate-ping' : ''}`}
                  style={{
                    background: moiraDebugInfo.liveStatus === 'success' ? 'var(--st-good)'
                      : moiraDebugInfo.liveStatus === 'failed' ? 'var(--st-crit)'
                      : moiraDebugInfo.liveStatus === 'skipped' ? 'var(--d-v1)'
                      : 'var(--st-warn)',
                  }}
                />
              )}
            </button>
          </div>
        </div>
        {mainView === 'list' && (
          <div data-tour="dashboard-table" className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <DashboardView
              aptList={aptList}
              currentParams={params}
              polygonStatus={polygonStatus}
              onOpenInMap={handleOpenInMapFromDashboard}
              showNotification={(type, text) => showAppNotification(text, type)}
            />
          </div>
        )}
        {mainView === 'map' && (
          <div data-tour="canvas-area" className="flex-1 min-h-0 relative">
            {/* 줌 컨트롤 — 상단바에서 캔버스 오버레이로 이동(2026-08-15).
                스크롤 컨테이너 바깥의 래퍼에 얹어야 스크롤을 따라 흘러가지 않는다.
                캔버스는 두 테마 모두 다크이므로 --canvas-* 토큰을 쓴다. */}
            <div
              className="absolute right-3 top-3 z-20 flex items-center gap-2 px-2.5 h-8 rounded-[var(--r-ctl)] border backdrop-blur-md"
              style={{
                background: 'var(--canvas-glass)',
                borderColor: 'var(--canvas-line)',
                color: 'var(--canvas-ink-2)',
              }}
            >
              <RotateCcw
                className="w-3.5 h-3.5 cursor-pointer hover:opacity-70 text-zinc-400 hover:text-white"
                title="화면 위치 & 줌 초기화"
                onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}
              />
              <div className="w-[1px] h-3.5 bg-zinc-700 mx-0.5" />
              <ZoomOut
                className="w-3.5 h-3.5 cursor-pointer hover:opacity-70"
                onClick={() => setZoom(z => Math.max(0.1, Math.round((z - 0.1) * 10) / 10))}
              />
              <input
                type="range" min="0.1" max="3" step="0.1" value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-24 accent-accent cursor-pointer"
              />
              <ZoomIn
                className="w-3.5 h-3.5 cursor-pointer hover:opacity-70"
                onClick={() => setZoom(z => Math.min(3, Math.round((z + 0.1) * 10) / 10))}
              />
              <span className="text-[11px] font-mono w-10 text-right" style={{ color: 'var(--canvas-ink-1)' }}>
                {Math.round(zoom * 100)}%
              </span>
            </div>

            <div
              ref={mapContainerRef}
              onMouseDown={handleMapMouseDown}
              onWheel={handleMapWheel}
              className={`absolute inset-0 overflow-hidden map-container p-8 ${
                isPanning ? 'cursor-grabbing select-none' : isSpacePressed || mode === 'idle' ? 'cursor-grab' : 'cursor-default'
              }`}
            >
            {/* 맵 좌측 상단: 실시간 베란다 총 거리 산출 오버레이 (접기 가능, 베란다 없으면 미표시) */}
            {verandas.length > 0 && (
              <div data-tour="veranda-overlay" className="absolute top-3 left-3 z-30 pointer-events-auto bg-zinc-950/85 backdrop-blur-md border border-zinc-800/90 rounded-xl shadow-2xl">
                <button
                  onClick={() => setVerandaOverlayOpen(v => !v)}
                  title={verandaOverlayOpen ? '접기' : '펼치기'}
                  className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-800/40 rounded-xl transition-colors"
                >
                  <Ruler className="w-4 h-4 text-[#00e5ff] shrink-0" />
                  <span className="text-xs font-bold text-text-primary tracking-wide">베란다 구간 총 길이</span>
                  {!verandaOverlayOpen && (
                    <span className="font-mono text-[11px] text-[#ffb300] ml-1">
                      {totalFirstVerandaMeters >= 1000
                        ? `${(totalFirstVerandaMeters / 1000).toFixed(2)}km`
                        : `${totalFirstVerandaMeters.toFixed(0)}m`}
                    </span>
                  )}
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-zinc-400 ml-auto shrink-0 transition-transform ${verandaOverlayOpen ? '' : '-rotate-90'}`}
                  />
                </button>

                {verandaOverlayOpen && (
                  <div className="px-3 pb-3 pt-1 space-y-2 text-xs min-w-[250px] border-t border-zinc-800/80">
                    <div className="flex items-center justify-between space-x-3 bg-zinc-900/60 px-2.5 py-1.5 rounded-lg border border-zinc-800/50 mt-2">
                      <div className="flex items-center space-x-2">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-[var(--d-v1)]" />
                        <span className="text-zinc-300 font-medium text-[11px]">전체 first 베란다 길이</span>
                      </div>
                      <span className="font-mono font-bold text-[#ffb300] text-xs">
                        {totalFirstVerandaMeters >= 1000
                          ? `${(totalFirstVerandaMeters / 1000).toFixed(2)} km (${Math.round(totalFirstVerandaMeters).toLocaleString()} m)`
                          : `${totalFirstVerandaMeters.toFixed(1)} m`}
                      </span>
                    </div>

                    <div className="flex items-center justify-between space-x-3 bg-zinc-900/60 px-2.5 py-1.5 rounded-lg border border-zinc-800/50">
                      <div className="flex items-center space-x-2">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-[var(--d-v2)]" />
                        <span className="text-zinc-300 font-medium text-[11px]">전체 second 베란다 길이</span>
                      </div>
                      <span className="font-mono font-bold text-[#ffd600] text-xs">
                        {totalSecondVerandaMeters >= 1000
                          ? `${(totalSecondVerandaMeters / 1000).toFixed(2)} km (${Math.round(totalSecondVerandaMeters).toLocaleString()} m)`
                          : `${totalSecondVerandaMeters.toFixed(1)} m`}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {(!imageSrc && buildings.length === 0) ? (
              <div className="h-full flex flex-col items-center justify-center text-text-secondary">
                <ImageIcon className="w-16 h-16 mb-4 opacity-50" />
                <p className="font-mono text-sm">Upload a map, SHP zip, or load sample to start</p>
              </div>
            ) : (
              <div
                className="inline-block relative shadow-2xl border border-border-color transition-none"
                style={{
                  width: canvasSize.width * zoom,
                  height: canvasSize.height * zoom,
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
                }}
              >
                <canvas
                  ref={canvasRef}
                  width={canvasSize.width}
                  height={canvasSize.height}
                  onClick={handleCanvasClick}
                  onContextMenu={handleCanvasRightClick}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseLeave={() => setHoveredBuildingIdx(-1)}
                  style={{
                    transform: `scale(${zoom})`,
                    transformOrigin: 'top left',
                    width: canvasSize.width,
                    height: canvasSize.height
                  }}
                  className={`${
                    isPanning ? 'cursor-grabbing' : isSpacePressed || mode === 'idle' ? 'cursor-grab' : 'cursor-crosshair'
                  } opacity-80 absolute top-0 left-0 bg-bg-main`}
                />
              </div>
            )}

            {/* 건물 마우스 호버(Hover) 시 세련된 실시간 플로팅 툴팁 (방안 2) */}
            {hoveredBuildingIdx >= 0 && buildings[hoveredBuildingIdx] && mousePos && (
              <div
                className="pointer-events-none absolute z-40 transition-all duration-75"
                style={{
                  left: Math.max(16, Math.min(mousePos.x * zoom + panOffset.x + 36, (mapContainerRef.current?.clientWidth || 800) - 240)),
                  top: Math.max(16, Math.min(mousePos.y * zoom + panOffset.y + 16, (mapContainerRef.current?.clientHeight || 600) - 160)),
                }}
              >
                {(() => {
                  const bIdx = hoveredBuildingIdx;
                  const bName = sourceMoira?.buildings?.[bIdx]?.bld_nm || `동 #${bIdx + 1}`;
                  const curRankRes = (result && result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
                  const bCov = (curRankRes?.buildingCoverages || result?.buildingCoverages || [])?.find((bc: any) => bc.bIdx === bIdx);

                  return (
                    <div className="bg-zinc-950/95 backdrop-blur-xl border border-zinc-700/90 rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.8)] p-3 text-xs min-w-[220px] space-y-2 ring-1 ring-white/10">
                      <div className="flex justify-between items-center border-b border-zinc-800 pb-1.5">
                        <span className="font-bold text-zinc-100 flex items-center gap-1.5">
                          <RadioTower className="w-3.5 h-3.5 text-accent" />
                          <span>{bName}</span>
                        </span>
                        {bCov ? (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded font-mono ${
                            bCov.ratio >= 90 ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                            bCov.ratio >= 50 ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                            'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          }`}>
                            {bCov.ratio >= 90 ? '양호' : bCov.ratio >= 50 ? '보통' : '음영'} · {Math.round(bCov.ratio)}%
                          </span>
                        ) : (
                          <span className="text-[10px] text-zinc-500 font-mono">분석 전</span>
                        )}
                      </div>

                      {bCov ? (
                        <div className="space-y-1.5 text-[11px] font-mono">
                          <div className="flex justify-between text-zinc-400">
                            <span>1차 베란다 커버:</span>
                            <span className="text-zinc-100 font-semibold">{bCov.covered}m / {bCov.total}m ({bCov.ratio.toFixed(1)}%)</span>
                          </div>
                          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden p-0.5 border border-zinc-700/60">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${
                                bCov.ratio >= 90 ? 'bg-gradient-to-r from-emerald-500 to-emerald-300' :
                                bCov.ratio >= 50 ? 'bg-gradient-to-r from-amber-500 to-amber-300' :
                                'bg-gradient-to-r from-rose-600 to-rose-400'
                              }`}
                              style={{ width: `${Math.min(100, Math.max(0, bCov.ratio))}%` }}
                            />
                          </div>
                          {bCov.secondCovered && bCov.secondCovered > 0 && (
                            <div className="flex justify-between text-[#ffd600] text-[10.5px] pt-1 border-t border-zinc-800/60">
                              <span className="flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#ffd600] inline-block"></span>
                                2차 베란다 보너스:
                              </span>
                              <span className="font-bold">+{bCov.secondCovered}m</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-[10.5px] text-zinc-400">
                          우측 하단 분석실행 시 세부 커버리지가 도출됩니다.
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
            </div>{/* /스크롤 컨테이너 */}

            {/* ==================== 맵 우측 하단 플로팅 3분할 분석 실행 컨트롤러 ==================== */}
            <div data-tour="floating-dock" className="absolute bottom-6 right-6 z-30 pointer-events-auto select-none">
              <div className="bg-zinc-950/95 backdrop-blur-xl border-2 border-[var(--accent)] rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.65),0_0_24px_var(--accent-soft)] p-3 flex flex-col gap-2 min-w-[320px] max-w-[390px]">
                {/* 상단 상태 바 */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center space-x-2">
                    <span className="relative flex h-2.5 w-2.5">
                      {isSimulating ? (
                        <>
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
                        </>
                      ) : buildings.length > 0 && verandas.length > 0 ? (
                        <>
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60"></span>
                          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                        </>
                      ) : (
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-zinc-600"></span>
                      )}
                    </span>
                    <span className="text-xs font-black tracking-wider text-zinc-100 flex items-center gap-1.5 font-sans">
                      <Play className="w-3 h-3 text-accent fill-accent" />
                      <span>분석실행</span>
                    </span>
                  </div>

                  <div className="flex items-center space-x-2 text-[10px] font-mono text-zinc-400">
                    {buildings.length > 0 && verandas.length > 0 ? (
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800/80 text-zinc-300 border border-zinc-700/50">
                        {buildings.length}동 · {verandas.length}베란다
                      </span>
                    ) : (
                      <span className="text-amber-400 font-sans font-medium">데이터 필요</span>
                    )}
                  </div>
                </div>

                {/* 3칸 직관적 분석 실행 버튼 (Tactile Action Buttons) */}
                <div className="grid grid-cols-3 gap-1.5">
                  {/* 1. 수동 실행 (M1) */}
                  <button
                    type="button"
                    disabled={isSimulating || buildings.length === 0 || verandas.length === 0}
                    onClick={() => handleExecuteSimMode('pure_manual')}
                    title="수동 생성 Sector만으로 즉시 분석 실행"
                    className={`group relative flex flex-col items-center justify-center py-2 px-1 rounded-xl border transition-all duration-150 text-center cursor-pointer shadow-md active:scale-95 ${
                      params.simulationMode === 'pure_manual'
                        ? 'bg-gradient-to-b from-amber-500/25 to-amber-950/60 border-amber-400 shadow-[0_0_14px_rgba(245,158,11,0.3)] ring-1 ring-amber-400/40'
                        : 'bg-gradient-to-b from-zinc-800/80 to-zinc-900/90 hover:from-amber-500/20 hover:to-zinc-900 border-zinc-700/70 hover:border-amber-500/60'
                    } disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:border-zinc-700/70 disabled:hover:from-zinc-800/80`}
                  >
                    <div className="flex items-center gap-1 mb-0.5">
                      <Play className="w-3 h-3 text-amber-400 fill-amber-400/40 group-hover:fill-amber-400 transition-colors" />
                      <span className="text-xs font-black text-zinc-100 group-hover:text-amber-300 tracking-tight">
                        수동
                      </span>
                    </div>
                    <span className="text-[9px] font-mono text-zinc-400 group-hover:text-zinc-300">
                      M1 · 기본
                    </span>
                  </button>

                  {/* 2. 수동+tunning 실행 (M2) */}
                  <button
                    type="button"
                    disabled={isSimulating || buildings.length === 0 || verandas.length === 0}
                    onClick={() => handleExecuteSimMode('manual_second_veranda')}
                    title="수동 Sector + 2차 베란다 튜닝 분석 실행"
                    className={`group relative flex flex-col items-center justify-center py-2 px-1 rounded-xl border transition-all duration-150 text-center cursor-pointer shadow-md active:scale-95 ${
                      params.simulationMode === 'manual_second_veranda'
                        ? 'bg-gradient-to-b from-cyan-500/25 to-cyan-950/60 border-cyan-400 shadow-[0_0_14px_rgba(0,229,255,0.3)] ring-1 ring-cyan-400/40'
                        : 'bg-gradient-to-b from-zinc-800/80 to-zinc-900/90 hover:from-cyan-500/20 hover:to-zinc-900 border-zinc-700/70 hover:border-cyan-500/60'
                    } disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:border-zinc-700/70 disabled:hover:from-zinc-800/80`}
                  >
                    <div className="flex items-center gap-1 mb-0.5">
                      <Play className="w-3 h-3 text-cyan-400 fill-cyan-400/40 group-hover:fill-cyan-400 transition-colors" />
                      <span className="text-xs font-black text-zinc-100 group-hover:text-cyan-300 tracking-tight">
                        수동+tunning
                      </span>
                    </div>
                    <span className="text-[9px] font-mono text-zinc-400 group-hover:text-zinc-300">
                      M2 · 튜닝
                    </span>
                  </button>

                  {/* 3. Auto 실행 (M3 - AI) */}
                  <button
                    type="button"
                    disabled={isSimulating || buildings.length === 0 || verandas.length === 0}
                    onClick={() => handleExecuteSimMode('full_auto')}
                    title="신규 Auto Site 탐색 + 풀 최적화 분석 실행"
                    className={`group relative flex flex-col items-center justify-center py-2 px-1 rounded-xl border transition-all duration-150 text-center cursor-pointer shadow-md active:scale-95 ${
                      params.simulationMode === 'full_auto' || !params.simulationMode
                        ? 'bg-gradient-to-b from-emerald-500/30 to-emerald-950/70 border-emerald-400 shadow-[0_0_18px_rgba(16,185,129,0.35)] ring-1 ring-emerald-400/50'
                        : 'bg-gradient-to-b from-zinc-800/80 to-zinc-900/90 hover:from-emerald-500/25 hover:to-zinc-900 border-zinc-700/70 hover:border-emerald-500/60'
                    } disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:border-zinc-700/70 disabled:hover:from-zinc-800/80`}
                  >
                    <div className="flex items-center gap-1 mb-0.5">
                      <Zap className="w-3 h-3 text-emerald-400 fill-emerald-400 group-hover:scale-110 transition-transform" />
                      <span className="text-xs font-black text-zinc-100 group-hover:text-emerald-300 tracking-tight">
                        Auto
                      </span>
                    </div>
                    <span className="text-[9px] font-mono font-bold text-emerald-400/90 group-hover:text-emerald-300">
                      M3 · 최적화
                    </span>
                  </button>
                </div>

                {/* 시뮬레이션 실행 중 실시간 프로그레스 바 미니 표시 */}
                {isSimulating && (
                  <div className="pt-1 border-t border-zinc-800/80 space-y-1.5">
                    <div className="flex justify-between items-center text-[10px] font-mono">
                      <span className="text-amber-400 font-semibold truncate max-w-[200px] flex items-center gap-1">
                        <RotateCcw className="w-3 h-3 animate-spin inline-block text-amber-400" />
                        {simStatusMessage}
                      </span>
                      <span className="text-amber-400 font-extrabold text-xs ml-1">{simProgress}%</span>
                    </div>
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden p-0.5 border border-zinc-700/80">
                      <div
                        className="h-full bg-gradient-to-r from-amber-600 via-amber-400 to-yellow-300 rounded-full transition-all duration-300 ease-out shadow-[0_0_10px_rgba(245,158,11,0.6)]"
                        style={{ width: `${simProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* AI Insights 패널 (토글 버튼은 결과 탭 하단 Download 버튼 아래로 이동, 2026-08-17) */}
            <AnimatePresence>
              {result && (
                <div className="fixed bottom-36 right-6 flex flex-col items-end space-y-4 z-50">
                  {showAiPanel && (
                    <motion.div
                      initial={{ opacity: 0, y: 20, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 20, scale: 0.95 }}
                      className="w-96 max-h-[70vh] bg-bg-panel border border-border-color rounded-xl shadow-2xl flex flex-col overflow-hidden"
                    >
                      <div className="bg-bg-accent p-3 border-b border-border-color flex justify-between items-center">
                        <div className="flex items-center text-xs text-warning font-bold tracking-wider uppercase">
                          <Sparkles className="w-4 h-4 mr-2" />
                          AI Analysis
                        </div>
                        <button onClick={() => setShowAiPanel(false)} className="text-text-secondary hover:text-text-primary p-1 hover:bg-bg-accent rounded transition-colors">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                        {!aiInsights && !isGeneratingInsights ? (
                          <div className="h-full flex flex-col items-center justify-center text-center py-8">
                            <Sparkles className="w-12 h-12 text-[#ffb300] mb-4 opacity-20" />
                            <p className="text-xs text-text-secondary mb-4">Click below to generate detailed insights about the simulation results.</p>
                            <button
                              onClick={handleGenerateAIInsights}
                              className="px-6 py-2 bg-warning text-black font-bold rounded-lg text-xs hover:bg-[#ffca28] transition-colors"
                            >
                              Generate Insights
                            </button>
                          </div>
                        ) : (
                          <div className="text-sm text-gray-300 leading-relaxed">
                            <div className="markdown-body">
                              <Markdown>{aiInsights || 'Analyzing results...'}</Markdown>
                            </div>
                            {isGeneratingInsights && (
                              <div className="flex items-center mt-4 text-warning text-xs">
                                <RotateCcw className="w-3 h-3 mr-2 animate-spin" />
                                Processing simulation data...
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}

                </div>
              )}
            </AnimatePresence>

            {/* Simulation Progress Modal Overlay */}
            <AnimatePresence>
              {isSimulating && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 bg-black/75 backdrop-blur-md z-[100] flex items-center justify-center p-4"
                >
                  <motion.div
                    initial={{ scale: 0.9, y: 20, opacity: 0 }}
                    animate={{ scale: 1, y: 0, opacity: 1 }}
                    exit={{ scale: 0.9, y: 20, opacity: 0 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    className="bg-zinc-900/95 border border-amber-500/50 rounded-2xl p-6 sm:p-8 max-w-md w-full shadow-[0_0_50px_rgba(245,158,11,0.2)] relative overflow-hidden"
                  >
                    {/* Glowing background accent */}
                    <div className="absolute -top-24 -right-24 w-48 h-48 bg-amber-500/15 rounded-full blur-3xl pointer-events-none" />

                    <div className="flex items-center space-x-3.5 mb-6">
                      <div className="p-3 bg-amber-500/10 border border-amber-500/40 rounded-xl relative shrink-0">
                        <RadioTower className="w-6 h-6 text-amber-400 animate-pulse" />
                        <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-amber-400 rounded-full animate-ping" />
                      </div>
                      <div>
                        <h3 className="text-base font-bold text-text-primary tracking-wide">RF 커버리지 시뮬레이션 분석 중</h3>
                        <p className="text-[11px] text-amber-400/90 font-mono mt-0.5">3GPP LOS & O2I Building Analysis Engine</p>
                      </div>
                    </div>

                    {/* Progress Info Header */}
                    <div className="flex justify-between items-end mb-2.5">
                      <span className="text-xs text-gray-300 font-medium flex items-center truncate max-w-[280px]">
                        <RotateCcw className="w-3.5 h-3.5 mr-2 text-amber-400 animate-spin shrink-0" />
                        <span className="truncate">{simStatusMessage}</span>
                      </span>
                      <span className="text-2xl font-extrabold text-amber-400 font-mono tracking-tight ml-2 shrink-0">
                        {simProgress}%
                      </span>
                    </div>

                    {/* Glassmorphic Progress Bar Track */}
                    <div className="h-4 bg-bg-main border border-border-color rounded-full overflow-hidden p-0.5 mb-6 relative">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-amber-600 via-amber-400 to-yellow-300 shadow-[0_0_15px_rgba(251,191,36,0.7)] relative overflow-hidden"
                        initial={{ width: '0%' }}
                        animate={{ width: `${simProgress}%` }}
                        transition={{ duration: 0.25, ease: "easeInOut" }}
                      />
                    </div>

                    {/* Step Indicators */}
                    <div className="grid grid-cols-4 gap-2 border-t border-zinc-800/80 pt-4">
                      {[
                        { label: 'LOS 투과', min: 20 },
                        { label: '섹터 탐색', min: 45 },
                        { label: '2차 베란다', min: 70 },
                        { label: '최적 매칭', min: 90 },
                      ].map((step, idx) => {
                        const isDone = simProgress >= step.min;
                        return (
                          <div key={idx} className="flex flex-col items-center text-center">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold mb-1.5 transition-all duration-300 ${isDone
                                ? 'bg-amber-400 text-black shadow-[0_0_10px_rgba(251,191,36,0.6)] scale-105'
                                : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                              }`}>
                              {isDone ? '✓' : idx + 1}
                            </div>
                            <span className={`text-[10px] tracking-tight ${isDone ? 'text-amber-300 font-semibold' : 'text-zinc-500'}`}>
                              {step.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ==================== 결과 드로어 (Step 5, 380px, 우측 고정) ==================== */}
      {drawerOpen && (result || manualEquipments.length > 0) && (
        <div data-tour="results-drawer" className="results-drawer">
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--shell-line)' }}>
            <div>
              <div className="step-panel-eyebrow">{result ? 'Step 5' : 'Step 4'}</div>
              <div className="step-panel-title">{result ? '시뮬레이션 결과' : '장비 구성'}</div>
            </div>
            <button onClick={() => setDrawerOpen(false)} className="text-zinc-400 hover:text-zinc-700 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-4 space-y-4">
            {/* Rank 선택 드롭다운 메뉴 (UI-5.1) */}
            {result && params.simulationMode === 'full_auto' && (
              <div className="p-2.5 bg-gray-900 border border-zinc-700 rounded shadow-md">
                <label className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider block mb-1 flex items-center">
                  <Filter className="w-3.5 h-3.5 mr-1 text-amber-400" />
                  후보 순위 선택 (Top Candidates)
                </label>
                <select
                  value={selectedRank}
                  onChange={(e) => setSelectedRank(Number(e.target.value))}
                  className="w-full bg-bg-main border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-text-primary font-mono focus:outline-none focus:border-amber-400"
                >
                  <option value={1}>🏆 Rank 1 (최종 최적 선택안)</option>
                  <option value={2}>🥈 Rank 2 후보안</option>
                  <option value={3}>🥉 Rank 3 후보안</option>
                  <option value={4}>4️⃣ Rank 4 후보안</option>
                  <option value={5}>5️⃣ Rank 5 후보안</option>
                </select>
              </div>
            )}

            {/* 요약 카드 (UI-5.2) — result 없이 드로어가 열릴 수 있으므로 반드시 가드.
                (tsconfig에 strict가 없어 타입 검사로는 이 널 참조가 잡히지 않는다) */}
            {result && (() => {
              const curRankRes = (result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
              const dispEqs = curRankRes ? curRankRes.equipments : result.equipments;
              const dispRatio = curRankRes ? curRankRes.coverageRatio : result.coverageRatio;
              const dispSecond = curRankRes ? curRankRes.secondCoveredSamples : result.secondCoveredSamples;

              return (
                <div className="p-3 bg-bg-accent border-l-4 border-accent rounded">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-[1.5px]">Results</h3>
                    <span className="text-[10px] font-mono font-semibold px-2 py-0.5 bg-accent/20 text-accent border border-accent/40 rounded">
                      Rank {selectedRank} {selectedRank === 1 ? '(CHOSEN)' : 'CANDIDATE'}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm mb-1 pb-0.5">
                    <span className="text-text-secondary text-xs uppercase">Equipments:</span>
                    <span className="font-bold text-text-primary font-mono text-lg">{dispEqs.length.toString().padStart(2, '0')}</span>
                  </div>
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className="text-text-secondary text-xs uppercase">커버리지 (2차 70% 반영):</span>
                    <span className="font-bold text-success font-mono text-lg">{dispRatio.toFixed(1)}%</span>
                  </div>
                  {result.searchSummary && result.searchSummary.cases > 0 && (
                    <div className="text-[10px] leading-relaxed text-zinc-400 border-t border-zinc-800 pt-1.5 mt-1">
                      전체 건물 {result.searchSummary.buildings}개동의 <span className="font-mono text-zinc-300">{result.searchSummary.points.toLocaleString()}</span>개 포인트 분석,
                      포인트별 <span className="font-mono text-zinc-300">{result.searchSummary.iterations}</span>회 × {result.searchSummary.directions}방향 시뮬레이션으로
                      총 <span className="font-mono text-zinc-300">{result.searchSummary.cases.toLocaleString()}</span>개 케이스 분석 완료
                    </div>
                  )}
                  {dispSecond && dispSecond.length > 0 && (
                    <div className="flex justify-between text-sm border-t border-zinc-800 pt-1.5 mt-1">
                      <span className="text-zinc-400 text-[11px] uppercase flex items-center">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#ffd600] mr-1.5 inline-block animate-pulse"></span>
                        2nd 베란다 투영 기여:
                      </span>
                      <span className="font-bold text-[#ffd600] font-mono text-xs">2차 {dispSecond.length}m → +{Math.round(dispSecond.length * SECOND_VERANDA_WEIGHT)}m 환산 가산</span>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 동별 커버리지 순위 리스트 (방안 3) */}
            {result && (() => {
              const curRankRes = (result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
              const bCoverages = curRankRes?.buildingCoverages || result?.buildingCoverages || [];
              if (bCoverages.length === 0) return null;

              return (
                <section className="mb-4 bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3 space-y-2.5">
                  <div className="flex justify-between items-center border-b border-zinc-800 pb-1.5">
                    <h3 className="text-xs font-bold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-accent" />
                      <span>동별 커버리지 현황 ({bCoverages.length}개 동)</span>
                    </h3>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      양호 {bCoverages.filter(b => b.ratio >= 90).length} · 보통 {bCoverages.filter(b => b.ratio >= 50 && b.ratio < 90).length} · 음영 {bCoverages.filter(b => b.ratio < 50).length}
                    </span>
                  </div>

                  <div className="space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
                    {bCoverages.map((bc) => {
                      const bName = sourceMoira?.buildings?.[bc.bIdx]?.bld_nm || `동 #${bc.bIdx + 1}`;
                      const isHovered = hoveredBuildingIdx === bc.bIdx;
                      return (
                        <div
                          key={bc.bIdx}
                          onMouseEnter={() => setHoveredBuildingIdx(bc.bIdx)}
                          onMouseLeave={() => setHoveredBuildingIdx(-1)}
                          className={`p-2 rounded-lg border transition-all text-xs cursor-pointer ${
                            isHovered
                              ? 'bg-zinc-800/90 border-accent shadow-sm'
                              : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex justify-between items-center mb-1">
                            <span className="font-bold text-zinc-200 flex items-center gap-1">
                              <span className={`w-1.5 h-1.5 rounded-full ${
                                bc.ratio >= 90 ? 'bg-emerald-400' :
                                bc.ratio >= 50 ? 'bg-amber-400' : 'bg-rose-400'
                              }`} />
                              {bName}
                            </span>
                            <div className="flex items-center gap-2">
                              {bc.secondCovered && bc.secondCovered > 0 ? (
                                <span className="text-[10px] text-[#ffd600] font-mono font-semibold">
                                  +{bc.secondCovered}m
                                </span>
                              ) : null}
                              <span className={`font-mono font-bold text-xs ${
                                bc.ratio >= 90 ? 'text-emerald-400' :
                                bc.ratio >= 50 ? 'text-amber-400' : 'text-rose-400'
                              }`}>
                                {bc.ratio.toFixed(1)}%
                              </span>
                            </div>
                          </div>

                          {/* Progress bar */}
                          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${
                                bc.ratio >= 90 ? 'bg-emerald-400' :
                                bc.ratio >= 50 ? 'bg-amber-400' : 'bg-rose-400'
                              }`}
                              style={{ width: `${Math.min(100, Math.max(0, bc.ratio))}%` }}
                            />
                          </div>

                          <div className="flex justify-between text-[10px] text-zinc-400 font-mono mt-1">
                            <span>1차 커버: {bc.covered}m / {bc.total}m</span>
                            <span>{bc.ratio >= 90 ? '양호' : bc.ratio >= 50 ? '보통' : '음영'}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })()}

            {/* 장비 섹터 (UI-3.4) — 좌측 패널에서 이동. 커버리지 결과와 같은 시선에서 조정한다. */}
              {(() => {
                const currentRankResult = (result && result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
                // 기존 안테나는 각도/삭제 편집 대상이 아니므로 목록에서 제외하고 개수만 따로 표기한다
                const activeEquipments = (currentRankResult ? currentRankResult.equipments : (result ? result.equipments : [...existingAntennas, ...manualEquipments]))
                  .filter(e => !e.isExisting);
                const existingCount = (result ? result.equipments : existingAntennas).filter(e => e.isExisting).length;
                const siteKeyOrder = buildSiteOrder(activeEquipments);
                const SITE_PALETTE_UI = SITE_PALETTE;
                return (
                  <section className="mb-4">
                    <div className="flex justify-between items-center mb-2 border-b border-border-color pb-1">
                      <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-[1.5px]">
                        4. Equipment Sectors ({activeEquipments.length})
                      </h2>
                      <span className="flex items-center gap-1.5">
                        {existingCount > 0 && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300 border border-slate-400/30">
                            기존 안테나 {existingCount}
                          </span>
                        )}
                        {activeEquipments.length > 0 && (
                          <span className="text-[10px] text-amber-400 font-mono">
                            {result ? 'Auto + Manual' : 'Manual Only'}
                          </span>
                        )}
                      </span>
                    </div>

                    {activeEquipments.length === 0 && (
                      <p className="text-xs text-text-secondary italic">No sectors placed or generated.</p>
                    )}

                    {selectedSiteKey && (
                      <button
                        onClick={() => setSelectedSiteKey(null)}
                        className="w-full mb-2 py-1 rounded-[var(--r-ctl)] border text-[10.5px] cursor-pointer transition-colors"
                        style={{ borderColor: 'var(--accent-line)', color: 'var(--accent)', background: 'var(--accent-soft)' }}
                      >
                        Site {(siteKeyOrder.get(selectedSiteKey) ?? 0) + 1} 만 표시 중 · 클릭하면 전체 보기
                      </button>
                    )}

                    <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                      {activeEquipments.map((eq) => {
                        const sKey = `${Math.round(eq.x)},${Math.round(eq.y)}`;
                        const sNo = (siteKeyOrder.get(sKey) ?? 0) + 1;
                        const sColor = SITE_PALETTE_UI[(siteKeyOrder.get(sKey) ?? 0) % SITE_PALETTE_UI.length];
                        const dimmed = Boolean(selectedSiteKey) && selectedSiteKey !== sKey;
                        return (
                        <div
                          key={eq.id}
                          onClick={() => setSelectedSiteKey(prev => (prev === sKey ? null : sKey))}
                          title="클릭하면 이 Site만 캔버스에 강조됩니다"
                          className="p-2.5 bg-bg-accent/80 rounded-lg text-xs transition-all cursor-pointer"
                          style={{
                            border: '1px solid',
                            borderColor: selectedSiteKey === sKey ? 'var(--accent-line)' : 'var(--line-strong)',
                            opacity: dimmed ? 0.4 : 1,
                          }}
                        >
                          <div className="flex justify-between items-center mb-1.5">
                            <div className="flex items-center space-x-1.5">
                              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: sColor }} />
                              <span className="font-mono font-bold" style={{ color: 'var(--ink-1)' }}>{sNo}</span>
                              <span className="font-bold font-mono" style={{ color: 'var(--ink-2)' }}>{eq.id}</span>
                              <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-semibold ${eq.isManual ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'}`}>
                                {eq.isManual ? 'Manual' : 'Auto'}
                              </span>
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteEq(eq.id); }}
                              className="text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 px-2 py-0.5 rounded transition-colors font-medium cursor-pointer"
                            >
                              Remove
                            </button>
                          </div>
                          <div className="flex items-center space-x-2">
                            <span className="text-text-secondary text-[11px] w-20 font-mono shrink-0">Angle: {eq.angle}°</span>
                            <input
                              type="range"
                              min="0"
                              max="359"
                              value={eq.angle}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => updateEqAngle(eq.id, Number(e.target.value))}
                              className="flex-1 cursor-pointer"
                              style={{ accentColor: sColor }}
                            />
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })()}

            {/* 분석 실행 결과 & 사이트별 요약 리포트 (한글화 + 위경도 표기) */}
            {result && (() => {
              const currentRankResult = (result && result.rankResults && result.rankResults[selectedRank]) ? result.rankResults[selectedRank] : null;
              const activeEquipments = currentRankResult ? currentRankResult.equipments : result.equipments;
              const siteKeyOrder = buildSiteOrder(activeEquipments);
              const SITE_PALETTE_UI = SITE_PALETTE;

              // Group equipments by Site
              const siteGroups = new Map<string, { siteNo: number; color: string; x: number; y: number; bIdx?: number; sectors: Equipment[] }>();
              activeEquipments.forEach((eq) => {
                const sKey = `${Math.round(eq.x)},${Math.round(eq.y)}`;
                const sNo = (siteKeyOrder.get(sKey) ?? 0) + 1;
                const sColor = SITE_PALETTE_UI[(siteKeyOrder.get(sKey) ?? 0) % SITE_PALETTE_UI.length];
                if (!siteGroups.has(sKey)) {
                  siteGroups.set(sKey, {
                    siteNo: sNo,
                    color: sColor,
                    x: eq.x,
                    y: eq.y,
                    bIdx: eq.bIdx,
                    sectors: []
                  });
                }
                siteGroups.get(sKey)!.sectors.push(eq);
              });

              const sortedSites = Array.from(siteGroups.values()).sort((a, b) => a.siteNo - b.siteNo);

              // Extract special events from logs
              const specialLogs = result.logs.filter(l =>
                l.message.includes('구조') ||
                l.message.includes('확장') ||
                l.message.includes('보너스') ||
                l.message.includes('통합') ||
                l.message.includes('삭감')
              );

              return (
                <div className="space-y-3">
                  {/* 사이트별 배치 및 커버리지 요약 테이블 */}
                  <div className="bg-zinc-950/70 rounded-xl border border-zinc-800/80 overflow-hidden shadow-md">
                    <div className="bg-zinc-900/90 border-b border-zinc-800 p-2.5 flex items-center justify-between text-xs">
                      <div className="font-bold text-zinc-100 flex items-center gap-1.5">
                        <RadioTower className="w-3.5 h-3.5 text-accent" />
                        <span>사이트별 배치 & 커버리지 요약</span>
                      </div>
                      <span className="text-[10px] text-zinc-400 font-mono">
                        {geoMapping ? '🌐 위경도 (WGS84)' : '📍 캔버스 좌표'}
                      </span>
                    </div>

                    <div className="divide-y divide-zinc-800/60 max-h-[260px] overflow-y-auto pr-1">
                      {sortedSites.map((st) => {
                        let coordText = `X: ${Math.round(st.x)}, Y: ${Math.round(st.y)}`;
                        if (geoMapping) {
                          const [lon, lat] = canvasToLonLat(st.x, st.y, geoMapping);
                          coordText = `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
                        }
                        const bldgName = st.bIdx !== undefined
                          ? (sourceMoira?.buildings?.[st.bIdx]?.bld_nm || `동 #${st.bIdx + 1}`)
                          : '단지 외부';

                        const totalSecured = st.sectors.reduce((sum, s) => sum + (s.coveredPoints?.length || 0), 0);

                        return (
                          <div key={st.siteNo} className="p-2.5 hover:bg-zinc-900/40 transition-colors text-xs space-y-1.5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: st.color }} />
                                <span className="font-bold text-zinc-100 font-mono">Site #{st.siteNo}</span>
                                <span className="text-[11px] px-1.5 py-0.5 bg-zinc-800 text-zinc-300 rounded border border-zinc-700/50">
                                  {bldgName}
                                </span>
                              </div>
                              <span className="text-[11px] font-mono text-accent font-bold">
                                {totalSecured > 0 ? `${totalSecured}m 확보` : '배치 완료'}
                              </span>
                            </div>

                            <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono">
                              <span className="truncate max-w-[180px]" title={coordText}>
                                📍 {coordText}
                              </span>
                              <span className="text-zinc-500">
                                {st.sectors.length}개 Sector
                              </span>
                            </div>

                            {/* Sector 목록 */}
                            <div className="grid grid-cols-1 gap-1 pt-0.5">
                              {st.sectors.map((sec) => {
                                const secLabel = sec.id.split('-').pop() || sec.id;
                                const secM = sec.coveredPoints?.length || 0;
                                return (
                                  <div
                                    key={sec.id}
                                    className="flex items-center justify-between bg-zinc-900/60 px-2 py-1 rounded text-[11px] font-mono border border-zinc-800/40"
                                  >
                                    <span className="text-zinc-300 flex items-center gap-1">
                                      <span className="text-zinc-400 font-bold">• Sector {secLabel}:</span>
                                      <span>{sec.angle}° 방향</span>
                                    </span>
                                    <span className="text-emerald-400 font-medium">
                                      {secM > 0 ? `${secM}m` : '-'}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 특이사항 및 보조 섹터 (구조/튜닝/보너스) 요약 카드 */}
                  {specialLogs.length > 0 && (
                    <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-2.5 text-xs space-y-1.5">
                      <div className="flex items-center gap-1.5 font-bold text-amber-400 text-[11px] uppercase tracking-wider">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>특이사항 및 보조 섹터 (구조 / 튜닝)</span>
                      </div>
                      <div className="space-y-1 text-[11px] text-zinc-300">
                        {specialLogs.slice(0, 4).map((sl, idx) => (
                          <div key={idx} className="flex items-start gap-1">
                            <span className="text-amber-400 shrink-0">•</span>
                            <span className="text-zinc-300 leading-tight">{sl.message}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 상세 실행 로그 (접이식 아코디언) */}
                  <details className="bg-zinc-950/40 rounded-xl border border-zinc-800 text-xs overflow-hidden group">
                    <summary className="p-2.5 bg-zinc-900/80 cursor-pointer flex items-center justify-between text-zinc-400 hover:text-zinc-200 font-mono text-[11px] select-none">
                      <span className="flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-accent" />
                        <span>상세 실행 로그 ({result.logs.length}건)</span>
                      </span>
                      <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180 text-zinc-500" />
                    </summary>
                    <div className="p-2.5 max-h-40 overflow-y-auto space-y-1.5 font-mono text-[10.5px] text-zinc-300 bg-zinc-950/90 divide-y divide-zinc-800/40">
                      {result.logs.map((log, i) => (
                        <div key={i} className="pt-1 first:pt-0 leading-tight">
                          <span className="text-accent/80 font-bold mr-1">
                            [{log.id || `LOG-${i+1}`}]
                          </span>
                          <span>{log.message}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              );
            })()}

            {/* 리포트 다운로드 (UI-5.5) — 결과가 있을 때만 */}
            {result && (
              <div className="space-y-2">
                <button
                  onClick={handleSaveToDashboard}
                  disabled={!selectedRapaKey || !geoMapping}
                  title={
                    !selectedRapaKey
                      ? 'RAPA Key로 로드된 단지만 전체 리스트에 저장할 수 있습니다'
                      : !geoMapping
                      ? 'MOIRA 지리 좌표계 매핑이 있는 단지만 전체 리스트에 저장할 수 있습니다 (SHP/이미지 제외)'
                      : '현재 수동 분석/조정 결과를 전체 리스트 대시보드에 저장합니다'
                  }
                  className={`w-full py-2 px-3 rounded flex items-center justify-center transition-all text-xs font-semibold ${
                    selectedRapaKey && geoMapping
                      ? 'bg-[var(--surface-3)] hover:bg-[var(--accent)] hover:text-white text-[var(--ink-1)] border border-[var(--line-strong)] cursor-pointer'
                      : 'bg-zinc-800 text-zinc-500 border border-zinc-700 cursor-not-allowed opacity-60'
                  }`}
                >
                  <Save className="w-4 h-4 mr-2" /> 전체 리스트에 저장 (화면 분석 결과)
                </button>

                <button
                  onClick={handleDownloadReport}
                  className="w-full py-2 bg-bg-accent text-text-primary border border-border-color hover:brightness-110 rounded flex items-center justify-center transition-all text-xs font-semibold cursor-pointer"
                >
                  <Download className="w-4 h-4 mr-2" /> Download Results (ZIP)
                </button>

                {/* AI Insights (UI-6.1 이동 배치) — 클릭 시 우하단 AI 분석 패널 토글 */}
                <button
                  onClick={() => setShowAiPanel(!showAiPanel)}
                  className={`w-full py-2 rounded flex items-center justify-center transition-all text-xs font-semibold cursor-pointer border ${showAiPanel
                      ? 'bg-warning text-black border-warning'
                      : 'bg-bg-accent text-warning border-border-color hover:brightness-110'
                    }`}
                >
                  <Sparkles className="w-4 h-4 mr-2" /> AI Insights{showAiPanel ? ' (패널 닫기)' : ''}
                </button>
              </div>
            )}

            {!result && (
              <p className="text-[11px] leading-relaxed px-1" style={{ color: 'var(--ink-3)' }}>
                시뮬레이션을 실행하면 커버리지 요약·동별 달성률·실행 로그가 여기에 표시됩니다.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* [임시 디버그 팝업] MOIRA Athena 쿼리 결과 실시간 확인 모달 */}
      {/* ========================================================================= */}
      {showMoiraDebugModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="bg-[#18181b] border border-zinc-700 rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden text-zinc-200 font-sans">
            {/* Modal Header */}
            <div className="px-5 py-3.5 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Database className="w-4 h-4 text-accent" />
                <h3 className="font-semibold text-sm text-text-primary">MOIRA Athena 쿼리 결과 확인 <span className="text-[10px] text-zinc-400 font-normal">(임시 디버그)</span></h3>
                {moiraDebugInfo?.liveStatus === 'loading' && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse">조회 진행중...</span>
                )}
                {moiraDebugInfo?.liveStatus === 'success' && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">실시간 성공 (HTTP {moiraDebugInfo.httpStatus || 200})</span>
                )}
                {moiraDebugInfo?.liveStatus === 'failed' && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">실시간 실패 (HTTP {moiraDebugInfo.httpStatus || 'ERR'})</span>
                )}
                {moiraDebugInfo?.liveStatus === 'skipped' && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30">배치 캐시 사용 (실시간 쿼리 생략)</span>
                )}
              </div>
              <button
                onClick={() => setShowMoiraDebugModal(false)}
                className="p-1 rounded-md text-zinc-400 hover:text-text-primary hover:bg-zinc-800 transition-colors"
                title="닫기"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              {/* 1. 기본 대상 정보 */}
              <div className="bg-zinc-900/60 p-3 rounded-lg border border-zinc-800 space-y-1.5 font-mono">
                <div className="flex justify-between text-[11px]">
                  <span className="text-zinc-400">RAPA 식별코드:</span>
                  <span className="font-bold text-accent">{moiraDebugInfo?.rapaKey || '미선택'}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-zinc-400">건물명/공사명:</span>
                  <span className="text-text-primary font-sans">{moiraDebugInfo?.apartmentName || '-'}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-zinc-400">대상 위경도:</span>
                  <span className="text-zinc-300">{moiraDebugInfo?.lat ? `${moiraDebugInfo.lat.toFixed(6)}, ${moiraDebugInfo.lng.toFixed(6)}` : '-'}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-zinc-400">요청 시각:</span>
                  <span className="text-zinc-400">{moiraDebugInfo?.timestamp || '-'}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-zinc-400">최종 적용 소스:</span>
                  <span className="font-semibold text-text-primary">
                    {moiraDebugInfo?.finalSource === 'athena-live' && '🟢 Athena 실시간 (live)'}
                    {moiraDebugInfo?.finalSource === 'athena-cache' && '🟡 배치 캐시 (public/complex_polygons.json)'}
                    {moiraDebugInfo?.finalSource === 'none' && '🔴 폴리곤 없음 (배경 지도 타일만 표시)'}
                  </span>
                </div>
              </div>

              {/* 2. 에러 메시지 (실패 시) */}
              {moiraDebugInfo?.liveStatus === 'failed' && (
                <div className="bg-rose-950/40 border border-rose-800/60 p-3.5 rounded-lg space-y-2">
                  <div className="flex items-center gap-2 text-rose-300 font-semibold text-xs">
                    <AlertTriangle className="w-4 h-4 text-rose-400" />
                    <span>Athena 실시간 조회 실패 원인</span>
                  </div>
                  <pre className="p-2.5 bg-bg-main text-rose-400 font-mono text-[11px] rounded overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {moiraDebugInfo.liveError || JSON.stringify(moiraDebugInfo.rawResponse, null, 2)}
                  </pre>
                  {moiraDebugInfo.liveError?.includes('idcube_hive_connector') && (
                    <div className="text-[11px] text-zinc-300 bg-zinc-900/80 p-2.5 rounded border border-zinc-800 space-y-1">
                      <div className="font-bold text-amber-300">💡 사내 환경 체크 팁:</div>
                      <div>• Node.js 서버가 실행된 파이썬 환경에 <code>idcube_hive_connector</code> 패키지가 필요합니다.</div>
                      <div>• 가상환경을 쓰시는 경우: <code>export MOIRA_PYTHON_BIN=/Users/1109425/cinderella/bin/python</code> 후 서버를 실행하시거나, 해당 환경에 패키지를 설치해주세요.</div>
                    </div>
                  )}
                </div>
              )}

              {/* 3. 성공(실시간/캐시) 시 테이블 매칭 상세 */}
              {(moiraDebugInfo?.liveStatus === 'success' || moiraDebugInfo?.liveStatus === 'skipped') && (
                <div className="space-y-3">
                  {/* 단지 폴리곤 */}
                  <div className="bg-zinc-900/60 p-3 rounded-lg border border-zinc-800 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-zinc-200 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-cyan-400" />
                        1. 단지 폴리곤 (o_moira.ap_bld_cplx_inf)
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${moiraDebugInfo.complexFound ? 'bg-cyan-500/20 text-cyan-300' : 'bg-zinc-700 text-zinc-400'}`}>
                        {moiraDebugInfo.complexFound ? 'MATCHED' : 'NOT FOUND'}
                      </span>
                    </div>
                    {moiraDebugInfo.complexFound ? (
                      <div className="text-[11px] text-zinc-300 space-y-0.5 pl-3 border-l-2 border-cyan-500/50">
                        <div>단지 정보 ID (PK): <span className="font-mono text-text-primary font-bold">{moiraDebugInfo.complexId}</span></div>
                        <div>단지 소분류명: <span className="text-text-primary">{moiraDebugInfo.complexSclNm || '-'}</span></div>
                      </div>
                    ) : (
                      <div className="text-[11px] text-amber-400 pl-3">
                        위경도가 속한 단지 폴리곤을 찾지 못하여 반경 500m BBox 폴백으로 건물을 탐색했습니다.
                      </div>
                    )}
                  </div>

                  {/* 건물 폴리곤 */}
                  <div className="bg-zinc-900/60 p-3 rounded-lg border border-zinc-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-zinc-200 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                        2. 건물 폴리곤 목록 (o_moira.ac_bld_bas)
                      </span>
                      <span className="text-[11px] font-mono text-emerald-400 font-bold">
                        {moiraDebugInfo.buildingCount}개 건물 수신
                      </span>
                    </div>
                    {moiraDebugInfo.buildingsSummary && moiraDebugInfo.buildingsSummary.length > 0 ? (
                      <div className="max-h-40 overflow-y-auto space-y-1 pr-1 font-mono text-[10.5px]">
                        {moiraDebugInfo.buildingsSummary.map((b, idx) => (
                          <div key={idx} className="flex items-center justify-between bg-bg-main px-2.5 py-1 rounded border border-border-color">
                            <span className="text-text-primary font-sans truncate max-w-[280px]">#{idx + 1} {b.name}</span>
                            <span className="text-zinc-400">{b.floors} / {b.height}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-zinc-400 pl-3">수신된 건물 데이터가 없습니다.</div>
                    )}
                  </div>
                </div>
              )}

              {/* 4. Raw Response JSON (접기/펼치기) */}
              <details className="bg-zinc-900/60 p-3 rounded-lg border border-zinc-800 text-[11px]">
                <summary className="font-semibold text-zinc-300 cursor-pointer select-none hover:text-text-primary flex items-center justify-between">
                  <span>📄 Raw Response JSON 보기</span>
                  <span className="text-[10px] text-zinc-400 font-mono">클릭하여 펼치기</span>
                </summary>
                <div className="mt-2.5 relative">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(moiraDebugInfo?.rawResponse || {}, null, 2));
                      showAppNotification("클립보드에 복사되었습니다.", "info");
                    }}
                    className="absolute top-2 right-2 px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-[10px] font-mono border border-zinc-700"
                  >
                    JSON 복사
                  </button>
                  <pre className="p-2.5 bg-bg-main text-text-primary font-mono text-[10.5px] rounded overflow-x-auto max-h-56 border border-border-color">
                    {JSON.stringify(moiraDebugInfo?.rawResponse || {}, null, 2)}
                  </pre>
                </div>
              </details>
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 bg-zinc-900/90 border-t border-zinc-800 flex justify-end">
              <button
                onClick={() => setShowMoiraDebugModal(false)}
                className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-text-primary rounded-md text-xs font-semibold transition-colors"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== 따라하기 (튜토리얼) 선택 팝오버 ==================== */}
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
                bottom: Math.max(16, window.innerHeight - r.bottom),
                zIndex: 99990,
              }}
              className="w-80 rounded-2xl border border-[var(--accent)]/30 shadow-[0_12px_40px_rgba(0,0,0,0.7),0_0_24px_var(--accent-soft)] overflow-hidden pointer-events-auto select-none"
            >
              <div style={{ background: 'rgba(10,13,18,0.96)', backdropFilter: 'blur(20px)' }} className="rounded-2xl">
                <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between border-b border-zinc-800/80">
                  <div className="flex items-center gap-2">
                    <span className="text-base">💡</span>
                    <span className="text-xs font-black tracking-wider" style={{ color: 'var(--accent)' }}>
                      따라하기 (튜토리얼)
                    </span>
                  </div>
                  <button
                    onClick={() => setShowGuideMenu(false)}
                    className="text-zinc-500 hover:text-zinc-300 p-0.5 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="p-1.5 space-y-1.5">
                  {[
                    {
                      id: 'workflow' as const,
                      num: '1',
                      label: 'Work Flow (이렇게 쓰세요!)',
                      desc: '8 steps · 대상선택 ➔ 폴리곤 ➔ 베란다 ➔ 도구/설정 ➔ 분석 ➔ 저장',
                      icon: '🚀',
                    },
                    {
                      id: 'dashboard' as const,
                      num: '2',
                      label: '전체 리스트 기능 (배치 & 대시보드)',
                      desc: '7 steps · 대시보드 지표 ➔ 지도에서 열기 ➔ 배치(Batch) 설정 & 실행',
                      icon: '📊',
                    },
                  ].map((tour) => (
                    <button
                      key={tour.id}
                      onClick={() => { setGuideTourId(tour.id); setShowGuideMenu(false); }}
                      className="w-full text-left px-3.5 py-3 rounded-xl hover:bg-zinc-800/70 transition-all flex items-center justify-between group cursor-pointer border border-transparent hover:border-[var(--accent)]/30 bg-zinc-900/40"
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="text-base mt-0.5">{tour.icon}</span>
                        <div>
                          <div className="text-xs font-bold text-zinc-100 group-hover:text-[var(--accent)] transition-colors">
                            {tour.label}
                          </div>
                          <div className="text-[10.5px] text-zinc-400 mt-0.5 leading-snug">{tour.desc}</div>
                        </div>
                      </div>
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-600 -rotate-90 group-hover:text-[var(--accent)] transition-colors shrink-0 ml-1" />
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* ==================== 따라하기 (튜토리얼) 오버레이 ==================== */}
      {guideTourId && (
        <GuideTour
          tourId={guideTourId}
          onClose={() => setGuideTourId(null)}
          setActivePanel={setActivePanel}
          setMainView={setMainView}
          setDrawerOpen={setDrawerOpen}
        />
      )}
    </div>
  );
}


