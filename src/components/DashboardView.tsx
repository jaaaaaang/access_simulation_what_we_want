import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Play,
  Square,
  RotateCw,
  RotateCcw,
  Search,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Layers,
  Radio,
  Sliders,
  Trash2,
  X,
  ChevronRight,
  ExternalLink,
  Filter,
  CheckSquare,
  Square as SquareIcon,
  HelpCircle,
  Cpu,
} from 'lucide-react';
import { AptListRow } from '../lib/aptList';
import {
  BatchResult,
  ResultIndex,
  ResultIndexItem,
  BatchJobStatus,
  BatchJobItem,
  SimulationParams,
  TopRankSummary,
  PolygonStatusItem,
} from '../types';
import { prepareSceneFromMoira } from '../lib/scenePrep';
import { MoiraComplexPolygonResult } from '../lib/moiraPolygon';
import { STANDARD_SIM_PARAMS } from '../lib/standardParams';
import { getApiUrl } from '../lib/api';

// ============================================================================
// Props
// ============================================================================
export interface DashboardViewProps {
  aptList: AptListRow[];
  currentParams: SimulationParams;
  polygonStatus?: Record<string, PolygonStatusItem>;
  onOpenInMap?: (rapaKey: string) => void;
  showNotification?: (type: 'info' | 'success' | 'warning' | 'error', text: string) => void;
}

// ============================================================================
// MiniMap SVG Renderer for TopRanks
// ============================================================================
interface TopRankMiniMapProps {
  rapaKey: string;
  rankSummary: TopRankSummary;
}

const TopRankMiniMap: React.FC<TopRankMiniMapProps> = ({ rapaKey, rankSummary }) => {
  const [sceneData, setSceneData] = useState<{
    buildings: { x: number; y: number }[][];
    viewBox: string;
  } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    const loadMoira = async () => {
      try {
        const primaryKey = rapaKey.startsWith('m-') ? rapaKey : `m-${rapaKey}`;
        const fallbackKey = rapaKey.startsWith('m-') ? rapaKey.slice(2) : rapaKey;

        let res = await fetch(getApiUrl(`/temps/${primaryKey}.json`));
        if (!res.ok) {
          res = await fetch(getApiUrl(`/temps/${fallbackKey}.json`));
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const moiraData: MoiraComplexPolygonResult = await res.json();
        if (!isMounted) return;

        const prep = prepareSceneFromMoira(moiraData, { generateVerandas: false });

        // Calculate bounding box for SVG viewBox
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        prep.buildings.forEach((pts) => {
          pts.forEach((pt) => {
            if (pt.x < minX) minX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y > maxY) maxY = pt.y;
          });
        });

        if (minX === Infinity) {
          minX = 0; minY = 0; maxX = 635; maxY = 800;
        }

        const padding = 25;
        const width = Math.max(100, maxX - minX + padding * 2);
        const height = Math.max(100, maxY - minY + padding * 2);
        const vx = minX - padding;
        const vy = minY - padding;

        setSceneData({
          buildings: prep.buildings,
          viewBox: `${vx} ${vy} ${width} ${height}`,
        });
        setLoading(false);
      } catch (err: any) {
        if (!isMounted) return;
        setError(err.message || '건물 데이터 로드 실패');
        setLoading(false);
      }
    };

    loadMoira();

    return () => { isMounted = false; };
  }, [rapaKey]);

  if (loading) {
    return (
      <div className="w-full h-36 flex items-center justify-center bg-[var(--surface-2)] rounded border border-[var(--line)] text-xs text-[var(--ink-3)]">
        미니맵 로딩 중...
      </div>
    );
  }

  if (error || !sceneData) {
    return (
      <div className="w-full h-36 flex items-center justify-center bg-[var(--surface-2)] rounded border border-[var(--line)] text-xs text-[var(--ink-3)]">
        미니맵 표시 불가
      </div>
    );
  }

  // 65도 빔 부채꼴 생성 함수 (r: 32px)
  const renderSectorArc = (cx: number, cy: number, angleDeg: number, key: string) => {
    const r = 32;
    const halfBeam = 32.5; // 65도 빔폭의 절반
    const a1 = ((angleDeg - halfBeam - 90) * Math.PI) / 180;
    const a2 = ((angleDeg + halfBeam - 90) * Math.PI) / 180;

    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);

    const pathData = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z`;

    return (
      <g key={key}>
        <path
          d={pathData}
          fill="rgba(25, 158, 112, 0.35)"
          stroke="#199E70"
          strokeWidth="1.2"
        />
        <line
          x1={cx}
          y1={cy}
          x2={cx + r * Math.cos(((angleDeg - 90) * Math.PI) / 180)}
          y2={cy + r * Math.sin(((angleDeg - 90) * Math.PI) / 180)}
          stroke="#199E70"
          strokeWidth="1.5"
          strokeDasharray="2,2"
        />
      </g>
    );
  };

  return (
    <div className="w-full h-36 bg-[var(--canvas-void)] rounded border border-[var(--line)] overflow-hidden relative">
      <svg
        viewBox={sceneData.viewBox}
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* 건물 폴리곤 */}
        {sceneData.buildings.map((pts, bIdx) => {
          const pointsStr = pts.map((p) => `${p.x},${p.y}`).join(' ');
          return (
            <polygon
              key={`b-${bIdx}`}
              points={pointsStr}
              fill="var(--surface-3)"
              stroke="var(--line-strong)"
              strokeWidth="1.5"
            />
          );
        })}

        {/* 장비 섹터 빔 */}
        {rankSummary.sites.map((site, sIdx) =>
          site.angles.map((ang, aIdx) =>
            renderSectorArc(site.x, site.y, ang, `sec-${sIdx}-${aIdx}`)
          )
        )}

        {/* 장비 설치 사이트 점 */}
        {rankSummary.sites.map((site, sIdx) => (
          <g key={`site-${sIdx}`}>
            <circle
              cx={site.x}
              cy={site.y}
              r="4.5"
              fill="#199E70"
              stroke="#FFFFFF"
              strokeWidth="1.5"
            />
            <circle
              cx={site.x}
              cy={site.y}
              r="1.8"
              fill="#FFFFFF"
            />
          </g>
        ))}
      </svg>
    </div>
  );
};

// ============================================================================
// DashboardView Component
// ============================================================================
export const DashboardView: React.FC<DashboardViewProps> = ({
  aptList,
  currentParams,
  polygonStatus = {},
  onOpenInMap,
  showNotification = () => {},
}) => {
  // State
  const [indexData, setIndexData] = useState<ResultIndex>({ updatedAt: '', items: {} });
  const [batchStatus, setBatchStatus] = useState<BatchJobStatus>({
    status: 'idle',
    concurrency: 2,
    totalCount: 0,
    completedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    activeWorkers: 0,
    currentRapaKeys: [],
    items: [],
  });
  const [loading, setLoading] = useState<boolean>(true);

  // Filters & Search
  const [selectedHq, setSelectedHq] = useState<string>('');
  const [selectedSido, setSelectedSido] = useState<string>('');
  const [selectedEmd, setSelectedEmd] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'OK' | 'WARN' | 'NOK' | 'unanalyzed' | 'running'>('all');
  const [polygonFilter, setPolygonFilter] = useState<'all' | 'no_polygon' | 'has_polygon'>('all'); // '전체' | '미확보만' | '미확보제외(확보만)'
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Sorting
  const [sortField, setSortField] = useState<'coverage' | 'date' | 'status' | 'rapaKey' | 'name'>('coverage');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Selected Checkboxes
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [isRetryMode, setIsRetryMode] = useState<boolean>(false);
  const [modalParams, setModalParams] = useState<SimulationParams>({ ...currentParams });
  const [modalConcurrency, setModalConcurrency] = useState<number>(2);
  const [modalSkipAnalyzed, setModalSkipAnalyzed] = useState<boolean>(true);
  const [startingBatch, setStartingBatch] = useState<boolean>(false);

// Drawer State
  const [selectedDetailKey, setSelectedDetailKey] = useState<string | null>(null);
  const [detailResult, setDetailResult] = useState<BatchResult | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  // --------------------------------------------------------------------------
  // Fetch Index and Status
  // --------------------------------------------------------------------------
  const fetchIndex = useCallback(async () => {
    const base = (import.meta as any).env?.BASE_URL || '/';
    try {
      const res = await fetch(getApiUrl('/api/results/list'));
      if (res.ok) {
        const data: ResultIndex = await res.json();
        setIndexData(data);
        return;
      }
    } catch {
      // 서버 없는 정적 배포 환경에서는 정적 파일로 진행
    }
    // 사내망 정적 배포 폴백 (public/results_index.json)
    try {
      const sRes = await fetch(`${base}results_index.json`);
      if (sRes.ok) {
        const data: ResultIndex = await sRes.json();
        setIndexData(data);
      }
    } catch (err) {
      console.warn('정적 결과 인덱스 로드 실패:', err);
    }
  }, []);

  const fetchBatchStatus = useCallback(async () => {
    try {
      const res = await fetch(getApiUrl('/api/batch/status'));
      if (res.ok) {
        const data: BatchJobStatus = await res.json();
        setBatchStatus(data);
        return data;
      }
    } catch (err: any) {
      console.error('Failed to fetch batch status:', err);
    }
    return null;
  }, []);
  // Initial Load
  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    Promise.all([fetchIndex(), fetchBatchStatus()]).finally(() => {
      if (isMounted) setLoading(false);
    });
    return () => { isMounted = false; };
  }, [fetchIndex, fetchBatchStatus]);

  // Polling Loop when batch is running
  useEffect(() => {
    if (batchStatus.status !== 'running') return;
    const timer = setInterval(() => {
      fetchBatchStatus();
      fetchIndex();
    }, 2000);
    return () => clearInterval(timer);
  }, [batchStatus.status, fetchBatchStatus, fetchIndex]);

  // --------------------------------------------------------------------------
  // Fetch Detail Result (Selected Key)
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!selectedDetailKey) {
      setDetailResult(null);
      return;
    }

    let isMounted = true;
    setDetailLoading(true);
    const base = (import.meta as any).env?.BASE_URL || '/';

    const loadData = async () => {
      // nginx 정적 배포에서는 /api/* 가 404 이거나 SPA 폴백으로 index.html(200)이 온다 → JSON 여부까지 확인
      const readJson = async (url: string): Promise<any | null> => {
        try {
          const r = await fetch(url);
          if (!r.ok) return null;
          const text = await r.text();
          if (!text.trim().startsWith('{')) return null;
          return JSON.parse(text);
        } catch {
          return null;
        }
      };
      const data = (await readJson(getApiUrl(`/api/results/${selectedDetailKey}`)))
        || (await readJson(`${base}results/${selectedDetailKey}.json`));
      if (data) return data;
      throw new Error('결과를 찾을 수 없습니다.');
    };

    loadData()
      .then((data: BatchResult) => {
        if (isMounted) {
          setDetailResult(data);
          setDetailLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setDetailResult(null);
          setDetailLoading(false);
          showNotification('error', `결과 상세를 불러오지 못했습니다: ${err.message}`);
        }
      });

    return () => { isMounted = false; };
  }, [selectedDetailKey, showNotification]);

  // --------------------------------------------------------------------------
  // Derived / Filtered Table Rows
  // --------------------------------------------------------------------------
  const uniqueHqOptions = useMemo(() => {
    return Array.from(new Set(aptList.map((r) => r.hq))).filter(Boolean).sort();
  }, [aptList]);

  const uniqueSidoOptions = useMemo(() => {
    const list = selectedHq ? aptList.filter((r) => r.hq === selectedHq) : aptList;
    return Array.from(new Set(list.map((r) => r.sido))).filter(Boolean).sort();
  }, [aptList, selectedHq]);

  const uniqueEmdOptions = useMemo(() => {
    let list = aptList;
    if (selectedHq) list = list.filter((r) => r.hq === selectedHq);
    if (selectedSido) list = list.filter((r) => r.sido === selectedSido);
    return Array.from(new Set(list.map((r) => r.emd))).filter(Boolean).sort();
  }, [aptList, selectedHq, selectedSido]);

  // Running job map from batchManager (포괄 정보 매핑)
  const runningJobMap = useMemo(() => {
    const map = new Map<string, BatchJobItem>();
    if (batchStatus && batchStatus.items) {
      batchStatus.items.forEach((item) => {
        map.set(item.rapaKey, item);
      });
    }
    return map;
  }, [batchStatus]);

  // Pending queue sequence index mapping
  const pendingIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    if (batchStatus && batchStatus.items) {
      let idx = 1;
      batchStatus.items.forEach((item) => {
        if (item.status === 'pending') {
          map.set(item.rapaKey, idx++);
        }
      });
    }
    return map;
  }, [batchStatus]);

  const joinedRows = useMemo(() => {
    return aptList.map((row) => {
      const resultItem: ResultIndexItem | undefined = indexData.items[row.rapaKey];
      const batchJob = runningJobMap.get(row.rapaKey);
      const batchJobStatus = batchJob?.status;
      const queueNumber = pendingIndexMap.get(row.rapaKey);
      const st = polygonStatus[row.rapaKey];
      const hasPolygon = Boolean(st?.hasComplex);

      let effectiveStatus: 'OK' | 'WARN' | 'NOK' | 'running' | 'pending' | 'unanalyzed' = 'unanalyzed';

      if (batchStatus.status === 'running' && batchJobStatus === 'running') {
        effectiveStatus = 'running';
      } else if (batchStatus.status === 'running' && batchJobStatus === 'pending') {
        effectiveStatus = 'pending';
      } else if (resultItem) {
        effectiveStatus = resultItem.status;
      }

      return {
        ...row,
        result: resultItem,
        status: effectiveStatus,
        batchJob,
        batchProgress: batchJob?.progress || 10,
        queueNumber,
        coverageRatio: resultItem?.coverageRatio,
        siteCount: resultItem?.siteCount,
        sectorCount: resultItem?.sectorCount,
        analyzedAt: resultItem?.analyzedAt,
        durationSec: resultItem?.durationSec || batchJob?.durationSec,
        hasPolygon,
        polygonSource: st?.source ?? null,
        hasPlan: Boolean(st?.hasPlan),
      };
    });
  }, [aptList, indexData, runningJobMap, pendingIndexMap, batchStatus.status, polygonStatus]);

  const filteredRows = useMemo(() => {
    let list = joinedRows;

    if (selectedHq) list = list.filter((r) => r.hq === selectedHq);
    if (selectedSido) list = list.filter((r) => r.sido === selectedSido);
    if (selectedEmd) list = list.filter((r) => r.emd === selectedEmd);

    if (statusFilter !== 'all') {
      list = list.filter((r) => r.status === statusFilter);
    }

    // 폴리곤 필터 (전체 / 미확보만 / 미확보 제외)
    if (polygonFilter === 'no_polygon') {
      list = list.filter((r) => !polygonStatus[r.rapaKey]?.hasComplex);
    } else if (polygonFilter === 'has_polygon') {
      list = list.filter((r) => Boolean(polygonStatus[r.rapaKey]?.hasComplex));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((r) =>
        r.rapaKey.toLowerCase().includes(q) ||
        r.buildingName.toLowerCase().includes(q) ||
        r.projectName.toLowerCase().includes(q) ||
        r.address.toLowerCase().includes(q)
      );
    }

    // Sort
    return [...list].sort((a, b) => {
      let valA: any = 0;
      let valB: any = 0;

      if (sortField === 'coverage') {
        valA = a.coverageRatio ?? -1;
        valB = b.coverageRatio ?? -1;
      } else if (sortField === 'date') {
        valA = a.analyzedAt ? new Date(a.analyzedAt).getTime() : 0;
        valB = b.analyzedAt ? new Date(b.analyzedAt).getTime() : 0;
      } else if (sortField === 'status') {
        const order = { OK: 4, WARN: 3, running: 2, pending: 1, unanalyzed: 0, NOK: -1 };
        valA = order[a.status] ?? 0;
        valB = order[b.status] ?? 0;
      } else if (sortField === 'rapaKey') {
        return sortOrder === 'asc'
          ? a.rapaKey.localeCompare(b.rapaKey)
          : b.rapaKey.localeCompare(a.rapaKey);
      } else if (sortField === 'name') {
        return sortOrder === 'asc'
          ? a.buildingName.localeCompare(b.buildingName)
          : b.buildingName.localeCompare(a.buildingName);
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
  }, [joinedRows, selectedHq, selectedSido, selectedEmd, statusFilter, polygonFilter, polygonStatus, searchQuery, sortField, sortOrder]);

  // --------------------------------------------------------------------------
  // Summary Metrics
  // --------------------------------------------------------------------------
  const summary = useMemo(() => {
    const total = joinedRows.length;
    let okCount = 0;
    let warnCount = 0;
    let nokCount = 0;
    let totalCoverage = 0;
    let totalSites = 0;
    let totalSectors = 0;
    let analyzedCount = 0;

    joinedRows.forEach((r) => {
      if (r.result) {
        if (r.result.status === 'OK') {
          okCount++;
          if (r.result.coverageRatio !== undefined) {
            totalCoverage += r.result.coverageRatio;
            analyzedCount++;
          }
          totalSites += r.result.siteCount || 0;
          totalSectors += r.result.sectorCount || 0;
        } else if (r.result.status === 'WARN') {
          warnCount++;
          analyzedCount++;
        } else if (r.result.status === 'NOK') {
          nokCount++;
        }
      }
    });

    const unanalyzedCount = Math.max(0, total - (okCount + warnCount + nokCount));
    const avgCoverage = analyzedCount > 0 ? (totalCoverage / analyzedCount).toFixed(1) : '0.0';
    const noPolygonCount = joinedRows.filter((r) => !polygonStatus[r.rapaKey]?.hasComplex).length;

    return {
      total,
      okCount,
      warnCount,
      nokCount,
      unanalyzedCount,
      avgCoverage,
      totalSites,
      totalSectors,
      noPolygonCount,
    };
  }, [joinedRows, polygonStatus]);

  const manualCountInSelection = useMemo(() => {
    return Array.from(selectedKeys).filter((k) => indexData.items[k]?.source === 'manual').length;
  }, [selectedKeys, indexData]);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------
  const handleSelectAllFiltered = () => {
    const allKeys = new Set(filteredRows.map((r) => r.rapaKey));
    const isAllSelected = filteredRows.every((r) => selectedKeys.has(r.rapaKey));

    if (isAllSelected) {
      const next = new Set(selectedKeys);
      filteredRows.forEach((r) => next.delete(r.rapaKey));
      setSelectedKeys(next);
    } else {
      const next = new Set(selectedKeys);
      allKeys.forEach((k) => next.add(k));
      setSelectedKeys(next);
    }
  };

  const handleToggleKey = (key: string) => {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedKeys(next);
  };

  const handleOpenBatchModal = (keysToRun?: string[], isRetry = false) => {
    if (keysToRun && keysToRun.length > 0) {
      setSelectedKeys(new Set(keysToRun));
    }
    setIsRetryMode(isRetry);
    setModalSkipAnalyzed(!isRetry);
    setModalParams({ ...currentParams });
    setIsModalOpen(true);
  };

  const handleRetryFailed = () => {
    const failedKeys = joinedRows
      .filter((r) => r.status === 'NOK' || r.status === 'WARN')
      .map((r) => r.rapaKey);

    if (failedKeys.length === 0) {
      showNotification('info', '재시도할 실패 또는 경고(WARN) 건이 없습니다.');
      return;
    }
    handleOpenBatchModal(failedKeys, true);
  };

  const handleStartBatch = async () => {
    const keys = Array.from(selectedKeys);
    if (keys.length === 0) {
      showNotification('warning', '선택된 단지가 없습니다.');
      return;
    }

    // 폴리곤 미확보 단지 사전 분리 (안전 방어: 에러 폭탄 방지)
    const validKeys = keys.filter(k => Boolean(polygonStatus[k]?.hasComplex));
    const unacquiredCount = keys.length - validKeys.length;

    if (validKeys.length === 0) {
      showNotification('error', `선택한 ${keys.length}개 단지 모두 폴리곤 미확보(🔴) 상태입니다. CAD/PDF 도면 추출 후 배치를 실행하세요.`);
      return;
    }

    // 파라미터 화이트리스트 구성 (pixelsPerMeter, analysisArea, preventAutoSectors 오염 절대 방지)
    const sanitizedParams: Partial<SimulationParams> = {
      beamWidth: typeof modalParams.beamWidth === 'number' ? modalParams.beamWidth : STANDARD_SIM_PARAMS.beamWidth,
      maxRange: typeof modalParams.maxRange === 'number' ? modalParams.maxRange : STANDARD_SIM_PARAMS.maxRange,
      targetCoverage: typeof modalParams.targetCoverage === 'number' ? modalParams.targetCoverage : STANDARD_SIM_PARAMS.targetCoverage,
      adjacentBuildingBuffer: typeof modalParams.adjacentBuildingBuffer === 'number' ? modalParams.adjacentBuildingBuffer : STANDARD_SIM_PARAMS.adjacentBuildingBuffer,
      facilitySearchRadius: typeof modalParams.facilitySearchRadius === 'number' ? modalParams.facilitySearchRadius : STANDARD_SIM_PARAMS.facilitySearchRadius,
      strictCoLocation: modalParams.strictCoLocation !== false,
      simulationMode: 'full_auto',
    };

    setStartingBatch(true);
    try {
      const res = await fetch(getApiUrl('/api/batch/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rapaKeys: validKeys,
          params: sanitizedParams,
          concurrency: modalConcurrency,
          skipAnalyzed: modalSkipAnalyzed,
          forceRerun: !modalSkipAnalyzed,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const skipMsg = unacquiredCount > 0 ? ` (미확보 ${unacquiredCount}건 자동 제외)` : '';
      showNotification('success', `🚀 배치 작업이 시작되었습니다 (총 ${data.total}건 중 ${data.queued}건 큐 등록${skipMsg}).`);
      setIsModalOpen(false);
      fetchBatchStatus();
    } catch (err: any) {
      showNotification('error', `배치 시작 실패: ${err.message}`);
    } finally {
      setStartingBatch(false);
    }
  };

  const handleCancelBatch = async () => {
    if (!window.confirm('현재 진행 중인 배치 시뮬레이션을 중단하시겠습니까?')) {
      return;
    }

    try {
      const res = await fetch(getApiUrl('/api/batch/cancel'), { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showNotification('info', `배치가 취소되었습니다 (${data.stoppedCount}개 프로세스 중단).`);
        fetchBatchStatus();
        fetchIndex();
      } else {
        throw new Error(data.error || '취소 요청 실패');
      }
    } catch (err: any) {
      showNotification('error', `배치 취소 오류: ${err.message}`);
    }
  };

  const handleDeleteResult = async (rapaKey: string) => {
    if (!window.confirm(`[${rapaKey}] 분석 결과를 삭제하시겠습니까?`)) {
      return;
    }

    try {
      const res = await fetch(getApiUrl(`/api/results/${rapaKey}`), { method: 'DELETE' });
      if (res.ok) {
        showNotification('success', `[${rapaKey}] 결과가 삭제되었습니다.`);
        setSelectedDetailKey(null);
        fetchIndex();
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err: any) {
      showNotification('error', `결과 삭제 실패: ${err.message}`);
    }
  };

  // --------------------------------------------------------------------------
  // Render Helpers
  // --------------------------------------------------------------------------
  const renderStatusBadge = (
    status: 'OK' | 'WARN' | 'NOK' | 'running' | 'pending' | 'unanalyzed',
    reason?: string | null,
    source?: 'batch' | 'manual',
    batchProgress?: number,
    queueNumber?: number
  ) => {
    let badge: React.ReactNode;
    switch (status) {
      case 'OK':
        badge = (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-3 h-3" /> 완료
          </span>
        );
        break;
      case 'WARN':
        badge = (
          <span
            title={reason || '커버리지 0% 또는 목표 미달'}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30 cursor-help"
          >
            <AlertTriangle className="w-3 h-3" /> 경고
          </span>
        );
        break;
      case 'NOK':
        badge = (
          <span
            title={reason || '시뮬레이션 실패'}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30 cursor-help"
          >
            <XCircle className="w-3 h-3" /> 실패
          </span>
        );
        break;
      case 'running':
        badge = (
          <div className="flex flex-col gap-1 min-w-[96px]">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
              <Cpu className="w-3 h-3 animate-spin text-amber-400" /> 분석중
            </span>
            <div className="flex items-center gap-1.5">
              <progress
                className="progress progress-warning w-16 h-1.5 bg-zinc-800"
                value={batchProgress || 10}
                max="100"
              />
              <span className="font-mono text-[10px] text-amber-400 font-bold">{batchProgress || 10}%</span>
            </div>
          </div>
        );
        break;
      case 'pending':
        badge = (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-500/15 text-zinc-400 border border-zinc-500/30">
            <Clock className="w-3 h-3 text-zinc-400" /> 대기 {queueNumber ? `#${queueNumber}` : ''}
          </span>
        );
        break;
      default:
        badge = (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--surface-3)] text-[var(--ink-3)] border border-[var(--line)]">
            미분석
          </span>
        );
    }

    if (source === 'manual') {
      return (
        <div className="inline-flex items-center gap-1">
          {badge}
          <span
            title="지도 탭에서 수동으로 분석/조정 후 저장된 결과입니다"
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/35 cursor-help"
          >
            수동
          </span>
        </div>
      );
    }

    return badge;
  };

  const renderCoverageBar = (ratio?: number, status?: string, batchProgress?: number) => {
    // 1. 실행 중인 경우: 화려하게 충전되는 게이지바로 표출
    if (status === 'running') {
      const pct = batchProgress || 10;
      return (
        <div className="flex flex-col gap-1 min-w-[130px]">
          <div className="flex justify-between items-center text-[10px] font-mono">
            <span className="text-amber-400/90 font-medium flex items-center gap-1">
              <RotateCcw className="w-2.5 h-2.5 animate-spin" /> 연산 충전 중
            </span>
            <span className="text-amber-400 font-extrabold">{pct}%</span>
          </div>
          <div className="h-2 bg-zinc-800/90 rounded-full overflow-hidden p-0.5 border border-amber-500/30 shadow-[0_0_8px_rgba(245,158,11,0.3)]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-500 via-amber-400 to-yellow-300 transition-all duration-300 ease-out shadow-[0_0_10px_rgba(245,158,11,0.6)]"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      );
    }

    // 2. 대기 큐에 있는 경우
    if (status === 'pending') {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 font-mono">
          <Clock className="w-3 h-3 text-zinc-500 animate-pulse" /> 큐 순서 대기 중
        </div>
      );
    }

    if (ratio === undefined || ratio === null) {
      return <span className="text-xs text-[var(--ink-3)] font-mono">-</span>;
    }

    let colorClass = 'bg-rose-500';
    let textClass = 'text-rose-400';
    if (ratio >= 60) {
      colorClass = 'bg-emerald-500';
      textClass = 'text-emerald-400';
    } else if (ratio >= 30) {
      colorClass = 'bg-amber-500';
      textClass = 'text-amber-400';
    }

    return (
      <div className="flex items-center gap-2 min-w-[100px]">
        <div className="flex-1 h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${colorClass}`}
            style={{ width: `${Math.min(100, Math.max(0, ratio))}%` }}
          />
        </div>
        <span className={`text-xs font-mono font-semibold w-11 text-right ${textClass}`}>
          {ratio.toFixed(1)}%
        </span>
      </div>
    );
  };

  // Estimated duration for modal
  const estimatedTimeText = useMemo(() => {
    const count = selectedKeys.size;
    if (count === 0) return '0분';
    const mins = Math.ceil((count * 4) / Math.max(1, modalConcurrency));
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `${h}시간 ${m}분`;
    }
    return `약 ${mins}분`;
  }, [selectedKeys.size, modalConcurrency]);

  // --------------------------------------------------------------------------
  // JSX Render
  // --------------------------------------------------------------------------
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--bg-app)] text-[var(--ink-1)] select-none">
      {/* ====================================================================
          TOP HEADER: Summary Metrics or Live Progress Bar
          ==================================================================== */}
      <div className="p-4 border-b border-[var(--line)] bg-[var(--surface-1)]">
        {batchStatus.status === 'running' ? (
          // 🚀 LIVE PROGRESS HEADER (When batch is running)
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-[var(--surface-2)] p-4 rounded-[var(--r-card)] border border-sky-500/30 shadow-lg">
            <div className="flex-1 w-full">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500"></span>
                  </span>
                  <span className="text-sm font-bold text-sky-400">대량 배치 시뮬레이션 실행 중</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 font-mono">
                    워커 {batchStatus.activeWorkers}/{batchStatus.concurrency}
                  </span>
                </div>
                <div className="text-xs font-mono text-[var(--ink-2)]">
                  완료 {batchStatus.completedCount} / 실패 {batchStatus.failedCount} / 전체 {batchStatus.totalCount}
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-2.5 bg-[var(--surface-3)] rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-gradient-to-r from-sky-500 to-emerald-400 transition-all duration-500 rounded-full"
                  style={{
                    width: `${Math.round(((batchStatus.completedCount + batchStatus.failedCount) / Math.max(1, batchStatus.totalCount)) * 100)}%`,
                  }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between text-xs text-[var(--ink-3)] gap-2">
                <div className="flex items-center gap-1">
                  <span>현재 실행 중:</span>
                  <span className="font-mono text-sky-300 font-medium">
                    {batchStatus.currentRapaKeys?.length ? batchStatus.currentRapaKeys.join(', ') : '워커 배정 중...'}
                  </span>
                </div>
                <div>
                  {batchStatus.estimatedRemainingSec !== undefined ? (
                    <span>
                      예상 잔여 시간: <strong className="text-[var(--ink-1)]">
                        {Math.ceil(batchStatus.estimatedRemainingSec / 60)}분 ({batchStatus.estimatedRemainingSec}초)
                      </strong>
                    </span>
                  ) : (
                    <span>잔여 시간 계산 중...</span>
                  )}
                </div>
              </div>
            </div>

            <button
              onClick={handleCancelBatch}
              className="flex items-center gap-1.5 px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-[var(--r-btn)] transition-colors shadow-md shrink-0"
            >
              <Square className="w-3.5 h-3.5" /> 배치 취소
            </button>
          </div>
        ) : (
          // 📊 SUMMARY CARDS ROW (When idle)
          <div data-tour="dashboard-summary" className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <div className="p-3 bg-[var(--surface-2)] rounded-[var(--r-card)] border border-[var(--line)] flex flex-col">
              <span className="text-xs text-[var(--ink-3)] font-medium">전체 대상</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-xl font-bold font-mono text-[var(--ink-1)]">{summary.total}</span>
                <span className="text-xs text-[var(--ink-3)]">개 단지</span>
              </div>
            </div>

            <div className="p-3 bg-[var(--surface-2)] rounded-[var(--r-card)] border border-emerald-500/20 flex flex-col">
              <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> 완료 (OK)
              </span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-xl font-bold font-mono text-emerald-400">{summary.okCount}</span>
                <span className="text-xs text-[var(--ink-3)]">건</span>
              </div>
            </div>

            <div className="p-3 bg-[var(--surface-2)] rounded-[var(--r-card)] border border-amber-500/20 flex flex-col">
              <span className="text-xs text-amber-400 font-medium flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> 경고 (WARN)
              </span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-xl font-bold font-mono text-amber-400">{summary.warnCount}</span>
                <span className="text-xs text-[var(--ink-3)]">건</span>
              </div>
            </div>

            <div className="p-3 bg-[var(--surface-2)] rounded-[var(--r-card)] border border-rose-500/20 flex flex-col">
              <span className="text-xs text-rose-400 font-medium flex items-center gap-1">
                <XCircle className="w-3 h-3" /> 실패 (NOK)
              </span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-xl font-bold font-mono text-rose-400">{summary.nokCount}</span>
                <span className="text-xs text-[var(--ink-3)]">건</span>
              </div>
            </div>

            <div className="p-3 bg-[var(--surface-2)] rounded-[var(--r-card)] border border-[var(--line)] flex flex-col">
              <span className="text-xs text-[var(--ink-3)] font-medium">미분석</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-xl font-bold font-mono text-[var(--ink-2)]">{summary.unanalyzedCount}</span>
                <span className="text-xs text-[var(--ink-3)]">건</span>
              </div>
            </div>

            <div className="p-3 bg-[var(--surface-2)] rounded-[var(--r-card)] border border-[var(--line)] flex flex-col">
              <span className="text-xs text-[var(--ink-3)] font-medium">평균 커버리지</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-xl font-bold font-mono text-emerald-400">{summary.avgCoverage}</span>
                <span className="text-xs text-[var(--ink-3)]">%</span>
              </div>
            </div>

            <div className="p-3 bg-[var(--surface-2)] rounded-[var(--r-card)] border border-[var(--line)] flex flex-col">
              <span className="text-xs text-[var(--ink-3)] font-medium">총 Site / Sector</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-base font-bold font-mono text-[var(--accent)]">
                  {summary.totalSites} <span className="text-xs font-normal text-[var(--ink-3)]">/</span> {summary.totalSectors}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ====================================================================
          TOOLBAR: Filters, Search, and Action Buttons
          ==================================================================== */}
      <div className="p-3 border-b border-[var(--line)] bg-[var(--surface-1)] flex flex-wrap items-center justify-between gap-3">
        {/* Filters & Search */}
        <div className="flex flex-wrap items-center gap-2">
          {/* 본부 */}
          <select
            value={selectedHq}
            onChange={(e) => { setSelectedHq(e.target.value); setSelectedSido(''); setSelectedEmd(''); }}
            className="h-8 px-2 text-xs bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-[var(--ink-1)] outline-none"
          >
            <option value="">본부 전체</option>
            {uniqueHqOptions.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>

          {/* 시도 */}
          <select
            value={selectedSido}
            onChange={(e) => { setSelectedSido(e.target.value); setSelectedEmd(''); }}
            className="h-8 px-2 text-xs bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-[var(--ink-1)] outline-none"
          >
            <option value="">시도 전체</option>
            {uniqueSidoOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          {/* 읍면동 */}
          <select
            value={selectedEmd}
            onChange={(e) => setSelectedEmd(e.target.value)}
            className="h-8 px-2 text-xs bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-[var(--ink-1)] outline-none"
          >
            <option value="">읍면동 전체</option>
            {uniqueEmdOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>

          {/* 상태 필터 */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="h-8 px-2 text-xs bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-[var(--ink-1)] outline-none"
          >
            <option value="all">상태 전체</option>
            <option value="OK">완료 (OK)</option>
            <option value="WARN">경고 (WARN)</option>
            <option value="NOK">실패 (NOK)</option>
            <option value="unanalyzed">미분석</option>
          </select>

          {/* daisyUI 셀렉트 드롭다운: 폴리곤 확보 상태별 필터 (옵션 B) */}
          <select
            value={polygonFilter}
            onChange={(e) => setPolygonFilter(e.target.value as any)}
            className={`select select-sm font-mono text-xs h-8 min-h-8 px-2.5 rounded-[var(--r-ctl)] outline-none cursor-pointer transition-colors shrink-0 ${
              polygonFilter === 'no_polygon'
                ? 'select-error bg-red-500/10 text-red-400 border-red-500/60 font-semibold'
                : polygonFilter === 'has_polygon'
                ? 'select-success bg-emerald-500/10 text-emerald-400 border-emerald-500/60 font-semibold'
                : 'select-bordered bg-[var(--surface-2)] text-[var(--ink-1)] border-[var(--line)]'
            }`}
            title="단지 폴리곤 확보 상태별 필터"
          >
            <option value="all">📁 폴리곤: 전체 ({summary.total}건)</option>
            <option value="no_polygon">🔴 미확보만 ({summary.noPolygonCount}건) — 도면 추출용</option>
            <option value="has_polygon">🟢 미확보 제외 ({summary.total - summary.noPolygonCount}건) — 시뮬레이션용</option>
          </select>

          {/* 검색창 */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--ink-3)]" />
            <input
              type="text"
              placeholder="단지명, RAPA Key, 주소 검색..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 pr-3 text-xs bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-[var(--ink-1)] placeholder-[var(--ink-3)] outline-none w-56 focus:border-[var(--accent)]"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-2 text-[var(--ink-3)] hover:text-[var(--ink-1)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div data-tour="dashboard-batch-actions" className="flex items-center gap-2">
          {/* 실패만 재시도 */}
          {(summary.nokCount > 0 || summary.warnCount > 0) && (
            <button
              onClick={handleRetryFailed}
              disabled={batchStatus.status === 'running'}
              className="flex items-center gap-1.5 px-3 h-8 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-semibold rounded-[var(--r-btn)] transition-colors disabled:opacity-50"
            >
              <RotateCw className="w-3.5 h-3.5" /> 실패/경고 재시도 ({summary.nokCount + summary.warnCount})
            </button>
          )}

          {/* 선택 배치 시작 버튼 */}
          <button
            onClick={() => handleOpenBatchModal(Array.from(selectedKeys))}
            disabled={selectedKeys.size === 0 || batchStatus.status === 'running'}
            className="flex items-center gap-1.5 px-4 h-8 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-bold rounded-[var(--r-btn)] transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Play className="w-3.5 h-3.5" />
            <span>선택 단지 시뮬레이션 ({selectedKeys.size})</span>
          </button>
        </div>
      </div>

      {/* ====================================================================
          TABLE CONTENT
          ==================================================================== */}
      <div data-tour="dashboard-table-content" className="flex-1 overflow-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead className="sticky top-0 bg-[var(--surface-1)] border-b border-[var(--line)] z-10">
            <tr className="text-[var(--ink-3)] font-semibold">
              <th className="w-10 px-3 py-2.5 text-center">
                <input
                  type="checkbox"
                  checked={filteredRows.length > 0 && filteredRows.every((r) => selectedKeys.has(r.rapaKey))}
                  onChange={handleSelectAllFiltered}
                  className="rounded border-[var(--line)] cursor-pointer accent-[var(--accent)]"
                />
              </th>
              <th className="w-24 px-3 py-2.5">
                <button
                  onClick={() => {
                    if (sortField === 'status') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                    else { setSortField('status'); setSortOrder('desc'); }
                  }}
                  className="flex items-center gap-1 hover:text-[var(--ink-1)]"
                >
                  상태 {sortField === 'status' && (sortOrder === 'asc' ? '↑' : '↓')}
                </button>
              </th>
              <th className="px-3 py-2.5">
                <button
                  onClick={() => {
                    if (sortField === 'name') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                    else { setSortField('name'); setSortOrder('asc'); }
                  }}
                  className="flex items-center gap-1 hover:text-[var(--ink-1)]"
                >
                  RAPA Key / 단지명 {sortField === 'name' && (sortOrder === 'asc' ? '↑' : '↓')}
                </button>
              </th>
              <th className="w-40 px-3 py-2.5">지역 (본부/시도/동)</th>
              <th className="w-36 px-3 py-2.5">
                <button
                  onClick={() => {
                    if (sortField === 'coverage') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                    else { setSortField('coverage'); setSortOrder('desc'); }
                  }}
                  className="flex items-center gap-1 hover:text-[var(--ink-1)]"
                >
                  커버리지 % {sortField === 'coverage' && (sortOrder === 'asc' ? '↑' : '↓')}
                </button>
              </th>
              <th className="w-24 px-3 py-2.5">Site / Sector</th>
              <th className="w-20 px-3 py-2.5">소요시간</th>
              <th className="w-28 px-3 py-2.5">
                <button
                  onClick={() => {
                    if (sortField === 'date') setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
                    else { setSortField('date'); setSortOrder('desc'); }
                  }}
                  className="flex items-center gap-1 hover:text-[var(--ink-1)]"
                >
                  분석일시 {sortField === 'date' && (sortOrder === 'asc' ? '↑' : '↓')}
                </button>
              </th>
              <th className="w-16 px-3 py-2.5 text-center">상세</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-[var(--ink-3)]">
                  {loading ? '데이터를 불러오는 중입니다...' : '검색 및 필터 조건에 일치하는 단지가 없습니다.'}
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => {
                const isSelected = selectedKeys.has(row.rapaKey);
                return (
                  <tr
                    key={row.rapaKey}
                    onClick={() => setSelectedDetailKey(row.rapaKey)}
                    className={`hover:bg-[var(--surface-2)] transition-colors cursor-pointer ${
                      isSelected ? 'bg-[var(--accent-soft)]' : ''
                    } ${selectedDetailKey === row.rapaKey ? 'bg-[var(--surface-3)] font-medium' : ''}`}
                  >
                    <td
                      className="px-3 py-2.5 text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleKey(row.rapaKey)}
                        className="rounded border-[var(--line)] cursor-pointer accent-[var(--accent)]"
                      />
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {renderStatusBadge(
                        row.status,
                        row.result?.warningMsg || row.result?.errorMsg,
                        row.result?.source,
                        row.batchProgress,
                        row.queueNumber
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-xs text-[var(--ink-3)]">{row.rapaKey}</span>
                          <span className="font-semibold text-[var(--ink-1)]">{row.buildingName}</span>
                          {!row.hasPolygon && (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-400 border border-red-500/30 shrink-0"
                              title="단지 폴리곤 미확보 (배치 불가, CAD/PDF 도면 추출 필요)"
                            >
                              🔴 미확보
                            </span>
                          )}
                          {row.hasPolygon && row.polygonSource === 'pdf_extraction' && (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0"
                              title="PDF 추출 폴리곤"
                            >
                              🟠 PDF
                            </span>
                          )}
                          {row.hasPlan && (
                            <span className="text-xs shrink-0" title="도면 이미지 확보">📄</span>
                          )}
                        </div>
                        <span className="text-[11px] text-[var(--ink-3)] truncate max-w-md">{row.address}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[var(--ink-2)]">
                      <div>{row.hq}</div>
                      <div className="text-[11px] text-[var(--ink-3)]">{row.sido} {row.sigungu} {row.emd}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      {renderCoverageBar(row.coverageRatio, row.status, row.batchProgress)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[var(--ink-2)]">
                      {row.status === 'running' ? (
                        <span className="text-amber-400 text-[11px] font-medium animate-pulse">최적 안테나 탐색 중...</span>
                      ) : row.status === 'pending' ? (
                        <span className="text-zinc-500 text-[11px]">대기 중</span>
                      ) : row.siteCount !== undefined ? (
                        `${row.siteCount}개 / ${row.sectorCount || 0}개`
                      ) : '-'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-[var(--ink-3)]">
                      {row.status === 'running' ? (
                        <span className="text-amber-400 font-bold">{row.batchJob?.elapsedSec || 1}s...</span>
                      ) : row.durationSec ? (
                        `${row.durationSec}s`
                      ) : '-'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--ink-3)]">
                      {row.status === 'running' ? (
                        <span className="text-amber-400/80 text-[10px]">진행 중</span>
                      ) : row.analyzedAt ? (
                        row.analyzedAt.slice(5, 16).replace('T', ' ')
                      ) : '-'}
                    </td>
                    <td
                      className="px-3 py-2.5 text-center"
                      onClick={(e) => { e.stopPropagation(); setSelectedDetailKey(row.rapaKey); }}
                    >
                      <button className="p-1 text-[var(--ink-3)] hover:text-[var(--ink-1)] hover:bg-[var(--surface-3)] rounded">
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ====================================================================
          DETAIL DRAWER (Sliding Panel on Row Click)
          ==================================================================== */}
      {selectedDetailKey && (
        <div className="fixed inset-y-0 right-0 w-[480px] max-w-full bg-[var(--surface-1)] border-l border-[var(--line-strong)] shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-200">
          {/* Drawer Header */}
          <div className="p-4 border-b border-[var(--line)] flex items-center justify-between bg-[var(--surface-2)]">
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold text-[var(--accent)]">{selectedDetailKey}</span>
                {detailResult && renderStatusBadge(detailResult.status, detailResult.warningMsg || detailResult.errorMsg, detailResult.source)}
              </div>
              <h3 className="text-sm font-bold text-[var(--ink-1)] mt-0.5">
                {aptList.find((r) => r.rapaKey === selectedDetailKey)?.buildingName || selectedDetailKey}
              </h3>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleDeleteResult(selectedDetailKey)}
                title="결과 삭제"
                className="p-1.5 text-[var(--ink-3)] hover:text-rose-400 hover:bg-[var(--surface-3)] rounded transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setSelectedDetailKey(null)}
                className="p-1.5 text-[var(--ink-3)] hover:text-[var(--ink-1)] hover:bg-[var(--surface-3)] rounded transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Drawer Body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar">
            {detailLoading ? (
              <div className="py-20 text-center text-xs text-[var(--ink-3)]">
                결과 상세 정보를 로드하는 중...
              </div>
            ) : !detailResult ? (
              <div className="py-12 text-center text-xs text-[var(--ink-3)]">
                <p>아직 시뮬레이션 분석이 수행되지 않은 단지입니다.</p>
                <button
                  onClick={() => handleOpenBatchModal([selectedDetailKey])}
                  className="mt-3 px-3 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-semibold rounded-[var(--r-btn)]"
                >
                  지금 시뮬레이션 실행
                </button>
              </div>
            ) : (
              <>
                {/* Warning / Error Alert */}
                {detailResult.status === 'WARN' && (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-[var(--r-ctl)] text-xs text-amber-300 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <strong className="font-semibold block">경고 (WARN) 발생:</strong>
                      {detailResult.warningMsg || '커버리지 0% (배치 대상 없음 또는 목표 커버리지 미도달)'}
                    </div>
                  </div>
                )}
                {detailResult.status === 'NOK' && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-[var(--r-ctl)] text-xs text-rose-300 flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <div>
                      <strong className="font-semibold block">시뮬레이션 실패 (NOK):</strong>
                      {detailResult.errorMsg || '알 수 없는 오류'}
                    </div>
                  </div>
                )}

                {/* Rank1 Summary Box */}
                {detailResult.rank1 && (
                  <div className="bg-[var(--surface-2)] p-4 rounded-[var(--r-card)] border border-[var(--line)] space-y-3">
                    <div className="flex items-center justify-between border-b border-[var(--line)] pb-2">
                      <span className="text-xs font-bold text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> 최적 배치 (Rank 1) 결과
                      </span>
                      <span className="text-xs font-mono font-bold text-emerald-400">
                        커버리지 {detailResult.rank1.coverageRatio}%
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-[var(--ink-3)]">설치 Site / Sector:</span>
                        <div className="font-mono font-semibold text-[var(--ink-1)]">
                          {detailResult.rank1.sites.length}개 Site /{' '}
                          {detailResult.rank1.sites.reduce((acc, s) => acc + s.sectors.length, 0)}개 Sector
                        </div>
                      </div>
                      <div>
                        <span className="text-[var(--ink-3)]">2차 베란다 커버 샘플:</span>
                        <div className="font-mono font-semibold text-[var(--ink-1)]">
                          {detailResult.rank1.secondCoveredSamples || detailResult.rank1.secondCoverage || 0} 샘플
                        </div>
                      </div>
                      <div>
                        <span className="text-[var(--ink-3)]">분석 소요 시간:</span>
                        <div className="font-mono font-semibold text-[var(--ink-1)]">{detailResult.durationSec}초</div>
                      </div>
                      <div>
                        <span className="text-[var(--ink-3)]">건물 수 / 베란다 AI:</span>
                        <div className="font-mono font-semibold text-[var(--ink-1)]">
                          {detailResult.scene?.buildingCount || 0}동 ({detailResult.scene?.verandaSource || 'v2.2'})
                        </div>
                      </div>
                    </div>

                    {/* Installed Sites Table */}
                    {detailResult.rank1.sites.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-[var(--line)]">
                        <span className="text-[11px] text-[var(--ink-3)] font-semibold block mb-1.5">배치된 장비 위치:</span>
                        <div className="space-y-1.5">
                          {detailResult.rank1.sites.map((site, sIdx) => (
                            <div
                              key={sIdx}
                              className="p-2 bg-[var(--surface-3)] rounded text-xs flex items-center justify-between font-mono"
                            >
                                <div>
                                  <span className="font-bold text-emerald-400">Site {(site.siteIdx ?? sIdx) + 1}</span>
                                  {site.bIdx !== undefined && (
                                    <span className="text-[var(--ink-3)] ml-1.5">({site.bIdx + 1}동)</span>
                                  )}
                                  {(typeof site.lng === 'number' && typeof site.lat === 'number') ? (
                                    <span className="text-[var(--ink-3)] text-[11px] ml-2">
                                      [{site.lng.toFixed(5)}, {site.lat.toFixed(5)}]
                                    </span>
                                  ) : (
                                    <span className="text-[var(--ink-3)] text-[11px] ml-2">
                                      ({Math.round(site.x)}, {Math.round(site.y)})
                                    </span>
                                  )}
                                </div>
                              <div className="flex gap-1">
                                {site.sectors.map((sec, secIdx) => (
                                  <span
                                    key={secIdx}
                                    className="px-1.5 py-0.5 bg-[var(--surface-2)] text-[var(--accent)] font-bold rounded text-[11px] border border-[var(--line)]"
                                  >
                                    {sec.angle}°
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Building Coverages List */}
                {detailResult.rank1?.buildingCoverages && detailResult.rank1.buildingCoverages.length > 0 && (
                  <div className="bg-[var(--surface-2)] p-4 rounded-[var(--r-card)] border border-[var(--line)]">
                    <h4 className="text-xs font-bold text-[var(--ink-2)] mb-3">건물별 커버리지 현황</h4>
                    <div className="space-y-2">
                      {detailResult.rank1.buildingCoverages.map((b) => (
                        <div key={b.bIdx} className="flex items-center justify-between text-xs gap-3">
                          <span className="font-mono text-[var(--ink-3)] w-12">{b.bIdx + 1}동</span>
                          <div className="flex-1 h-2 bg-[var(--surface-3)] rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                b.ratio >= 60 ? 'bg-emerald-500' : b.ratio >= 30 ? 'bg-amber-500' : 'bg-rose-500'
                              }`}
                              style={{ width: `${Math.min(100, Math.max(0, b.ratio))}%` }}
                            />
                          </div>
                          <span className="font-mono font-semibold w-16 text-right text-[var(--ink-1)]">
                            {b.ratio.toFixed(1)}%
                          </span>
                          <span className="font-mono text-[11px] text-[var(--ink-3)] w-14 text-right">
                            ({b.covered}/{b.total})
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Top 1~5 Comparison Cards with SVG MiniMaps */}
                {detailResult.topRanks && detailResult.topRanks.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-xs font-bold text-[var(--ink-2)] flex items-center justify-between">
                      <span>Top 1~5 순위별 배치 후보 비교</span>
                      <span className="text-[11px] text-[var(--ink-3)] font-normal">미니맵 벡터 시각화</span>
                    </h4>

                    <div className="space-y-3">
                      {detailResult.topRanks.map((tr) => (
                        <div
                          key={tr.rank}
                          className="bg-[var(--surface-2)] p-3 rounded-[var(--r-card)] border border-[var(--line)] space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${
                                tr.rank === 1
                                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                  : 'bg-[var(--surface-3)] text-[var(--ink-2)]'
                              }`}>
                                Rank {tr.rank} {tr.rank === 1 && '(최적)'}
                              </span>
                              <span className="text-xs font-mono font-semibold text-[var(--ink-1)]">
                                {tr.coverageRatio}%
                              </span>
                            </div>
                            <span className="text-xs font-mono text-[var(--ink-3)]">
                              Site {tr.siteCount}개 / Sector {tr.sectorCount}개
                            </span>
                          </div>

                          {/* MiniMap SVG */}
                          <TopRankMiniMap rapaKey={selectedDetailKey} rankSummary={tr} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Drawer Footer Actions */}
          <div className="p-4 border-t border-[var(--line)] bg-[var(--surface-2)] flex items-center gap-2">
            <button
              onClick={() => {
                if (selectedDetailKey) {
                  onOpenInMap?.(selectedDetailKey);
                }
              }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-[var(--surface-3)] hover:bg-[var(--accent)] hover:text-white text-[var(--ink-1)] text-xs font-semibold rounded-[var(--r-btn)] border border-[var(--line-strong)] cursor-pointer transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" /> 지도에서 열기
            </button>
            <button
              onClick={() => handleOpenBatchModal([selectedDetailKey])}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-bold rounded-[var(--r-btn)] transition-colors"
            >
              재분석
            </button>
          </div>
        </div>
      )}

      {/* ====================================================================
          BATCH START MODAL
          ==================================================================== */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--surface-1)] border border-[var(--line-strong)] rounded-[var(--r-card)] shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-4 border-b border-[var(--line)] bg-[var(--surface-2)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-[var(--accent)]" />
                <h3 className="text-sm font-bold text-[var(--ink-1)]">대량 배치 시뮬레이션 설정</h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1 text-[var(--ink-3)] hover:text-[var(--ink-1)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-5 overflow-y-auto flex-1 text-xs">
              {/* Target Summary */}
              <div className="p-3 bg-[var(--surface-2)] rounded-[var(--r-ctl)] border border-[var(--line)]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--ink-3)]">선택된 대상 단지:</span>
                  <span className="font-mono font-bold text-base text-[var(--accent)]">
                    {selectedKeys.size}개 단지
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-[var(--ink-3)]">
                  <span>예상 소요 시간:</span>
                  <span className="font-mono text-[var(--ink-1)] font-semibold">{estimatedTimeText}</span>
                </div>
              </div>

              {/* Retry Mode Notice Banner */}
              {isRetryMode && (
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-[var(--r-ctl)] text-xs text-amber-300 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>재시도 대상 <strong>{selectedKeys.size}건</strong>은 <strong>강제 재분석(Force Rerun)</strong>으로 실행됩니다.</span>
                </div>
              )}

              {/* Manual Result Override Warning Banner */}
              {!modalSkipAnalyzed && manualCountInSelection > 0 && (
                <div className="p-2.5 bg-purple-500/10 border border-purple-500/30 rounded-[var(--r-ctl)] text-xs text-purple-300 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-purple-400 shrink-0" />
                  <span>선택된 단지 중 <strong>{manualCountInSelection}건</strong>의 수동 저장 결과가 포함되어 있습니다. 강제 재분석 시 배치 결과로 대체됩니다.</span>
                </div>
              )}

              {/* Skip vs Force Rerun Option */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-[var(--ink-2)] block">기존 분석 건 처리 방식</label>
                <div className="grid grid-cols-2 gap-2">
                  <label
                    className={`p-2.5 rounded-[var(--r-ctl)] border flex items-center gap-2 cursor-pointer transition-colors ${
                      modalSkipAnalyzed
                        ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--ink-1)]'
                        : 'bg-[var(--surface-2)] border-[var(--line)] text-[var(--ink-3)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="skipOption"
                      checked={modalSkipAnalyzed}
                      onChange={() => setModalSkipAnalyzed(true)}
                      className="accent-[var(--accent)]"
                    />
                    <div>
                      <span className="font-semibold block">완료 건 건너뛰기</span>
                      <span className="text-[11px] text-[var(--ink-3)]">이미 분석된 단지 Skip</span>
                    </div>
                  </label>

                  <label
                    className={`p-2.5 rounded-[var(--r-ctl)] border flex items-center gap-2 cursor-pointer transition-colors ${
                      !modalSkipAnalyzed
                        ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--ink-1)]'
                        : 'bg-[var(--surface-2)] border-[var(--line)] text-[var(--ink-3)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="skipOption"
                      checked={!modalSkipAnalyzed}
                      onChange={() => setModalSkipAnalyzed(false)}
                      className="accent-[var(--accent)]"
                    />
                    <div>
                      <span className="font-semibold block">강제 재분석</span>
                      <span className="text-[11px] text-[var(--ink-3)]">모든 단지 새로 연산</span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Concurrency Setting */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-[var(--ink-2)]">동시 실행 워커 수 (Concurrency)</label>
                  <span className="font-mono font-bold text-[var(--accent)]">{modalConcurrency}개 프로세스</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="4"
                  step="1"
                  value={modalConcurrency}
                  onChange={(e) => setModalConcurrency(parseInt(e.target.value, 10))}
                  className="w-full accent-[var(--accent)]"
                />
                <div className="flex justify-between text-[10px] text-[var(--ink-3)] font-mono">
                  <span>1 (안전)</span>
                  <span>2 (권장 기본값)</span>
                  <span>3</span>
                  <span>4 (최대 병렬)</span>
                </div>
              </div>

              {/* Simulation Params Form */}
              <div className="space-y-3 pt-3 border-t border-[var(--line)]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--ink-2)]">공통 시뮬레이션 파라미터</span>
                  <button
                    type="button"
                    onClick={() => {
                      setModalParams({
                        ...modalParams,
                        ...STANDARD_SIM_PARAMS,
                        strictCoLocation: true,
                        simulationMode: 'full_auto',
                      });
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] bg-[var(--accent-soft)] hover:bg-[var(--accent)]/20 border border-[var(--accent-line)] rounded-[var(--r-btn)] transition-colors cursor-pointer"
                    title="표준 기본 파라미터(65° / 150m / 60%)로 즉시 초기화합니다"
                  >
                    <RotateCcw className="w-3 h-3" /> 표준 기본값 리셋 (65°/150m/60%)
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] text-[var(--ink-3)] block mb-1">안테나 빔폭 (°)</label>
                    <input
                      type="number"
                      value={modalParams.beamWidth}
                      onChange={(e) => setModalParams({ ...modalParams, beamWidth: parseFloat(e.target.value) || 65 })}
                      className="w-full h-8 px-2 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-xs font-mono text-[var(--ink-1)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-[var(--ink-3)] block mb-1">최대 도달거리 (m)</label>
                    <input
                      type="number"
                      value={modalParams.maxRange}
                      onChange={(e) => setModalParams({ ...modalParams, maxRange: parseFloat(e.target.value) || 150 })}
                      className="w-full h-8 px-2 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-xs font-mono text-[var(--ink-1)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-[var(--ink-3)] block mb-1">목표 커버리지 (%)</label>
                    <input
                      type="number"
                      value={modalParams.targetCoverage}
                      onChange={(e) => setModalParams({ ...modalParams, targetCoverage: parseFloat(e.target.value) || 60 })}
                      className="w-full h-8 px-2 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-xs font-mono text-[var(--ink-1)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-[var(--ink-3)] block mb-1">인접 건물 고려 반경 (m)</label>
                    <input
                      type="number"
                      value={modalParams.adjacentBuildingBuffer ?? 65}
                      onChange={(e) => setModalParams({ ...modalParams, adjacentBuildingBuffer: parseFloat(e.target.value) || 65 })}
                      className="w-full h-8 px-2 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-xs font-mono text-[var(--ink-1)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-[var(--ink-3)] block mb-1">자사 시설 검색 반경 (m)</label>
                    <input
                      type="number"
                      value={modalParams.facilitySearchRadius ?? 150}
                      onChange={(e) => setModalParams({ ...modalParams, facilitySearchRadius: parseFloat(e.target.value) || 150 })}
                      className="w-full h-8 px-2 bg-[var(--surface-2)] border border-[var(--line)] rounded-[var(--r-ctl)] text-xs font-mono text-[var(--ink-1)] outline-none"
                    />
                  </div>

                  <div className="flex items-center pt-4">
                    <label className="flex items-center gap-2 cursor-pointer text-xs">
                      <input
                        type="checkbox"
                        checked={modalParams.strictCoLocation !== false}
                        onChange={(e) => setModalParams({ ...modalParams, strictCoLocation: e.target.checked })}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-[var(--ink-2)]">공용 기지국 엄격 모드</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-[var(--line)] bg-[var(--surface-2)] flex items-center justify-end gap-2">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 bg-[var(--surface-3)] hover:bg-[var(--surface-2)] text-[var(--ink-2)] text-xs font-semibold rounded-[var(--r-btn)] transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleStartBatch}
                disabled={startingBatch || selectedKeys.size === 0}
                className="flex items-center gap-1.5 px-5 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-bold rounded-[var(--r-btn)] transition-colors shadow-md disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                {startingBatch ? '시작 요청 중...' : '시뮬레이션 시작'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
