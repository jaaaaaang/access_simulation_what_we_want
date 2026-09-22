/**
 * CAD(DXF) 업로드 & 폴리곤 생성 패널
 * ---------------------------------------------------------------------------
 * MOIRA(Athena)에 단지 폴리곤이 없는 대상은 설계 도면(DXF)에서 폴리곤을 만들어야 한다.
 * 이 패널에서:
 *   ① DXF 파일을 Flask 서버로 업로드 (파일명은 <rapaKey>.dxf 로 저장)
 *   ② 서버가 도면을 해석해 단지/건물 폴리곤 생성 + 주변 건물(65m) 조회
 *   ③ 결과를 시뮬레이터에 그대로 적용
 *
 * 실제 처리는 전부 Flask(python)가 하고, 이 컴포넌트는 요청/진행률/결과 표시만 담당한다.
 */

import { useEffect, useRef, useState } from 'react';
import { FileUp, Loader2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  extractFromCadJob,
  listCadFiles,
  pingPyApi,
  uploadCadFile,
  type CadFileItem,
  type PyJob,
  type PyPingResult,
} from '../lib/pyApi';

type Props = {
  /** 현재 선택된 RAPA Key — 업로드 파일명이 된다 */
  rapaKey: string | null;
  /** 단지명 (선택) */
  complexName?: string;
  /** 지오코딩용 주소 접두 (예: "대구 동구 신암동") — GCP 정합에 사용 */
  addrPrefix?: string;
  /** 단지 대표 좌표 — v3 추출의 앵커로 서버에 전달 */
  lat?: number | null;
  lng?: number | null;
  /** 추출 완료 시 호출 — temps 스키마와 동일한 결과 객체를 넘긴다 */
  onExtracted: (result: any) => void;
  /** 알림 표시 */
  notify?: (msg: string, kind?: 'success' | 'warning' | 'error' | 'info') => void;
};

export default function CadUploadPanel({
  rapaKey,
  complexName,
  addrPrefix,
  lat,
  lng,
  onExtracted,
  notify,
}: Props) {
  const [ping, setPing] = useState<PyPingResult | null>(null);
  const [pingChecked, setPingChecked] = useState(false);
  const [files, setFiles] = useState<CadFileItem[]>([]);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [job, setJob] = useState<PyJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const p = await pingPyApi();
    setPing(p);
    setPingChecked(true);
    if (p) {
      try {
        setFiles(await listCadFiles());
      } catch {
        setFiles([]);
      }
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const uploaded = files.find(f => f.rapaKey === rapaKey);

  const handlePick = () => inputRef.current?.click();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일 다시 선택 가능하게
    if (!file) return;
    if (!rapaKey) {
      notify?.('먼저 상단바에서 RAPA Key를 선택해 주세요.', 'warning');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.dxf')) {
      notify?.('DXF 파일만 업로드할 수 있습니다. DWG는 ODA File Converter로 변환 후 올려주세요.', 'warning');
      return;
    }

    setError(null);
    setBusy(true);
    setUploadPct(0);
    try {
      const res = await uploadCadFile(rapaKey, file, setUploadPct);
      notify?.(`CAD 업로드 완료: ${res.fileName} (${(res.sizeBytes / 1048576).toFixed(1)}MB)`, 'success');
      setFiles(await listCadFiles());
    } catch (err: any) {
      setError(err.message);
      notify?.(`업로드 실패: ${err.message}`, 'error');
    } finally {
      setUploadPct(null);
      setBusy(false);
    }
  };

  const handleExtract = async () => {
    if (!rapaKey) return;
    setError(null);
    setBusy(true);
    setJob(null);
    setLastResult(null);
    try {
      const result = await extractFromCadJob(rapaKey, {
        complexName,
        addrPrefix,
        lat: lat ?? null,
        lng: lng ?? null,
        neighborMeters: 65,
        withNeighbors: true,
        onProgress: setJob,
      });
      setLastResult(result);
      onExtracted(result);
      const n = result?.buildings?.length ?? 0;
      const geo = result?.georeferenced;
      const duct = result?.stats?.duct_buildings;
      const eng = result?.engine === 'rapa_v3' ? 'v3' : '구버전';
      notify?.(
        `CAD 추출 완료(${eng}): 건물 ${n}개` + (duct ? ` · 관로동 ${duct}동` : '')
        + (geo ? ' — 위치는 대표좌표 기준, 도구 탭 \'단지 위치 보정\'으로 맞추세요' : ' — 좌표 정합 실패(로컬 mm 좌표)'),
        geo ? 'success' : 'warning'
      );
    } catch (err: any) {
      setError(err.message);
      notify?.(`CAD 추출 실패: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  // Flask 서버에 연결되지 않은 경우 — 기능 자체를 숨기지 않고 이유를 알려준다
  if (pingChecked && !ping) {
    return (
      <div className="border border-zinc-800 rounded-lg p-3 bg-zinc-950/40 text-[10px] text-text-secondary space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-zinc-400 tracking-wider uppercase flex items-center">
            <FileUp className="w-3.5 h-3.5 mr-1.5" /> CAD 도면 업로드
          </span>
          <button onClick={refresh} className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center gap-1">
            <RefreshCw className="w-2.5 h-2.5" /> 재시도
          </button>
        </div>
        <p className="leading-relaxed">
          python(Flask) 서버에 연결할 수 없습니다. 이 기능은 DB 조회·도면 해석을 Flask 서버에 위임합니다.
        </p>
        <p className="font-mono text-[9px] text-zinc-500">
          로컬: <span className="text-zinc-400">python app.py</span> 로 Flask를 먼저 실행하세요 (포트 8080).
        </p>
      </div>
    );
  }

  const pct = job?.progress?.total
    ? Math.round((job.progress.done / job.progress.total) * 100)
    : null;

  return (
    <div className="border border-border-color rounded-lg p-3 bg-zinc-950/40 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-accent tracking-wider uppercase flex items-center">
          <FileUp className="w-3.5 h-3.5 mr-1.5" /> CAD 도면 → 폴리곤
        </span>
        <span className="text-[9px] text-gray-500 font-mono">DXF · 65m</span>
      </div>

      <p className="text-[10px] text-text-secondary leading-relaxed">
        MOIRA에 단지 폴리곤이 없는 대상은 설계 도면(DXF)에서 단지/건물 폴리곤을 만들고,
        주변 건물(65m)은 DB에서 함께 가져옵니다.
      </p>

      {/* 서버 준비 상태 */}
      {ping && !ping.capabilities.rapa_dxf_extract && (
        <div className="text-[9px] text-amber-300 bg-amber-950/20 border border-amber-900/30 rounded p-1.5 leading-tight flex gap-1.5">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>
            서버에 rapa_dxf_extract 패키지가 없어 도면 해석이 실패합니다.
            Flask 서버의 PYTHONPATH에 해당 패키지를 추가해 주세요.
          </span>
        </div>
      )}

      {/* 현재 대상 */}
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-text-secondary">대상</span>
        <span className="font-mono text-accent truncate max-w-[170px]">
          {rapaKey || '— RAPA Key 미선택 —'}
        </span>
      </div>

      {/* 업로드 상태 */}
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-text-secondary">업로드된 도면</span>
        {uploaded ? (
          <span className="font-mono text-emerald-300 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            {(uploaded.sizeBytes / 1048576).toFixed(1)}MB
          </span>
        ) : (
          <span className="text-zinc-500">없음</span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".dxf"
        onChange={handleFile}
        className="hidden"
      />

      <div className="flex gap-1.5">
        <button
          onClick={handlePick}
          disabled={busy || !rapaKey}
          className="flex-1 text-[10px] px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-200 flex items-center justify-center gap-1"
        >
          <FileUp className="w-3 h-3" />
          {uploaded ? 'DXF 교체' : 'DXF 업로드'}
        </button>
        <button
          onClick={handleExtract}
          disabled={busy || !rapaKey || !uploaded}
          className="flex-1 text-[10px] px-2 py-1.5 rounded bg-accent/80 hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center gap-1"
        >
          {busy && job ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          폴리곤 생성
        </button>
      </div>

      {/* 업로드 진행률 */}
      {uploadPct !== null && (
        <div className="space-y-1">
          <div className="h-1 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-cyan-400 transition-all" style={{ width: `${uploadPct}%` }} />
          </div>
          <div className="text-[9px] text-text-secondary font-mono">업로드 {uploadPct}%</div>
        </div>
      )}

      {/* 추출 진행률 — 서버가 보내주는 단계별 메시지 */}
      {job && busy && (
        <div className="space-y-1">
          <div className="h-1 bg-zinc-800 rounded overflow-hidden">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: pct !== null ? `${pct}%` : '40%' }}
            />
          </div>
          <div className="text-[9px] text-text-secondary font-mono truncate" title={job.progress?.message}>
            {job.status === 'pending' ? '대기 중' : job.progress?.message || '처리 중'}
          </div>
        </div>
      )}

      {/* 결과 요약 */}
      {lastResult && !busy && (
        <div className="text-[9px] bg-emerald-950/20 border border-emerald-900/30 rounded p-1.5 space-y-0.5">
          <div className="text-emerald-300 font-semibold">추출 완료</div>
          <div className="text-text-secondary font-mono">
            건물 {lastResult.buildings?.length ?? 0}개
            {lastResult.stats ? ` (단지내 ${lastResult.stats.inComplex} / 주변 ${lastResult.stats.neighbors})` : ''}
          </div>
          {lastResult.georeference && (
            <div className="text-text-secondary font-mono">
              좌표정합 RMS {lastResult.georeference.gcp_rms_m}m · GCP {lastResult.georeference.n_gcp}점
            </div>
          )}
          {lastResult.georeferenced === false && (
            <div className="text-amber-300 leading-tight">
              좌표 정합에 실패해 로컬(mm) 좌표입니다. 주소 접두를 지정하면 정확도가 올라갑니다.
            </div>
          )}
          {lastResult.neighborError && (
            <div className="text-amber-300 leading-tight">주변 건물: {lastResult.neighborError}</div>
          )}
        </div>
      )}

      {error && (
        <div className="text-[9px] text-red-300 bg-red-950/20 border border-red-900/30 rounded p-1.5 leading-tight">
          {error}
        </div>
      )}
    </div>
  );
}
