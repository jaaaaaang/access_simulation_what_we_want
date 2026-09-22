/**
 * 전체 자동화 배치 패널 — 기존 주피터 수동 절차를 버튼 하나로 대체
 * ---------------------------------------------------------------------------
 * 지금까지: 주피터에서 폴리곤 코드 실행 → 안테나 코드 실행 → 10MB 검사 →
 *           생성된 JSON을 직접 gitlab에 업로드
 * 앞으로:   [전체 배치 실행] 한 번 → 서버가 위 3단계를 수행 →
 *           [산출물 다운로드]로 zip 받아 로컬에서 커밋
 */

import { useEffect, useState } from 'react';
import { Play, Download, RefreshCw, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import {
  getBatchDownloadUrl,
  getBatchOutputs,
  runFullBatch,
  type BatchOutputs,
  type BatchSummary,
  type PyJob,
} from '../lib/pyApi';

type Props = {
  /** Flask 연결 여부 — 부모(App)가 ping으로 판정한 값 */
  online: boolean | null;
  notify?: (msg: string, kind?: 'success' | 'warning' | 'error' | 'info') => void;
};

export default function BatchAutomationPanel({ online, notify }: Props) {
  const [outputs, setOutputs] = useState<BatchOutputs | null>(null);
  const [job, setJob] = useState<PyJob | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withAntenna, setWithAntenna] = useState(true);
  const [withGeo, setWithGeo] = useState(true);

  const refresh = async () => {
    if (!online) return;
    try {
      setOutputs(await getBatchOutputs());
    } catch {
      setOutputs(null);
    }
  };

  useEffect(() => { refresh(); }, [online]);

  const handleRun = async () => {
    if (!confirm(
      'apt_list 전체를 사내 DB에서 조회합니다.\n' +
      '대상이 288건이라 수십 분이 걸릴 수 있습니다.\n\n진행할까요?'
    )) return;

    setBusy(true);
    setError(null);
    setSummary(null);
    setJob(null);
    try {
      const res = await runFullBatch({ withGeo, withAntenna, onProgress: setJob });
      setSummary(res);
      await refresh();
      const nFiles = res.written?.length ?? 0;
      if (res.largeFiles?.length) {
        notify?.(
          `배치 완료 (${nFiles}개 생성) — 단, 10MB 초과 파일 ${res.largeFiles.length}개가 있어 gitlab 업로드 전 확인이 필요합니다.`,
          'warning'
        );
      } else {
        notify?.(`전체 배치 완료: ${nFiles}개 파일 생성`, 'success');
      }
    } catch (err: any) {
      setError(err.message);
      notify?.(`배치 실패: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (online === false) return null;   // Flask 없으면 숨김 (상단에 이미 안내가 있음)

  const pct = job?.progress?.total
    ? Math.round((job.progress.done / job.progress.total) * 100)
    : null;

  return (
    <div className="border border-border-color rounded-lg p-3 bg-zinc-950/40 space-y-2.5 mb-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-accent tracking-wider uppercase flex items-center">
          <Play className="w-3.5 h-3.5 mr-1.5" /> 전체 자동 배치
        </span>
        <button
          onClick={refresh}
          disabled={busy}
          className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center gap-1 disabled:opacity-40"
        >
          <RefreshCw className="w-2.5 h-2.5" /> 새로고침
        </button>
      </div>

      <p className="text-[10px] text-text-secondary leading-relaxed">
        apt_list 전체를 조회해 <span className="font-mono">temps/*.json</span> 과
        <span className="font-mono"> antenna_assets.json</span> 을 생성하고,
        gitlab 10MB 제한 초과 파일까지 자동으로 검사합니다.
      </p>

      {/* 실행 대상 선택 */}
      <div className="flex gap-3 text-[10px]">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={withGeo} onChange={e => setWithGeo(e.target.checked)}
                 disabled={busy} className="accent-[var(--accent)]" />
          <span className="text-text-secondary">폴리곤</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={withAntenna} onChange={e => setWithAntenna(e.target.checked)}
                 disabled={busy} className="accent-[var(--accent)]" />
          <span className="text-text-secondary">자사 안테나</span>
        </label>
      </div>

      <div className="flex gap-1.5">
        <button
          onClick={handleRun}
          disabled={busy || (!withGeo && !withAntenna)}
          className="flex-1 text-[10px] px-2 py-1.5 rounded bg-accent/80 hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center gap-1"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          {busy ? '실행 중...' : '전체 배치 실행'}
        </button>
        <a
          href={getBatchDownloadUrl()}
          className={`flex-1 text-[10px] px-2 py-1.5 rounded flex items-center justify-center gap-1 ${
            outputs?.tempsCount
              ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
              : 'bg-zinc-900 text-zinc-600 pointer-events-none'
          }`}
          title="산출물을 zip으로 받아 로컬에서 git commit 하세요"
        >
          <Download className="w-3 h-3" /> 산출물 받기
        </a>
      </div>

      {/* 진행률 */}
      {busy && (
        <div className="space-y-1">
          <div className="h-1 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-accent transition-all"
                 style={{ width: pct !== null ? `${pct}%` : '30%' }} />
          </div>
          <div className="text-[9px] text-text-secondary font-mono truncate"
               title={job?.progress?.message}>
            {job?.progress?.message || '요청 중...'}
            {pct !== null ? ` (${pct}%)` : ''}
          </div>
        </div>
      )}

      {/* 현재 산출물 상태 */}
      {outputs && !busy && (
        <div className="text-[9px] text-text-secondary font-mono space-y-0.5 pt-1 border-t border-zinc-800">
          <div>temps: {outputs.tempsCount}개
            {outputs.antennaFile
              ? ` · antenna_assets.json ${(outputs.antennaFile.sizeBytes / 1048576).toFixed(1)}MB`
              : ' · antenna_assets.json 없음'}
          </div>
          <div className="truncate" title={outputs.outputDir}>저장 위치: {outputs.outputDir}</div>
        </div>
      )}

      {/* 10MB 초과 경고 — 수동으로 확인하던 절차의 자동화 결과 */}
      {outputs?.largeFiles?.length ? (
        <div className="text-[9px] text-amber-300 bg-amber-950/20 border border-amber-900/30 rounded p-1.5 space-y-0.5">
          <div className="flex items-center gap-1 font-semibold">
            <AlertTriangle className="w-3 h-3" /> gitlab 10MB 초과 {outputs.largeFiles.length}개
          </div>
          {outputs.largeFiles.slice(0, 5).map(f => (
            <div key={f.file} className="font-mono">{f.file} — {f.sizeMB}MB</div>
          ))}
        </div>
      ) : null}

      {/* 실행 결과 요약 */}
      {summary && !busy && (
        <div className="text-[9px] bg-emerald-950/20 border border-emerald-900/30 rounded p-1.5 space-y-0.5">
          <div className="text-emerald-300 font-semibold flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> 배치 완료
          </div>
          <div className="text-text-secondary font-mono">대상 {summary.targetCount}건</div>
          {summary.geo && (
            <div className="text-text-secondary font-mono">
              폴리곤 {summary.geo.ok}건 성공
              {summary.geo.failed.length ? ` / ${summary.geo.failed.length}건 실패` : ''}
              {` (조회 ${summary.geo.neighborMeters}m)`}
            </div>
          )}
          {summary.antenna && (
            <div className="text-text-secondary font-mono">
              안테나 {summary.antenna.antennaCount}개 / {summary.antenna.targetCount}단지 (dt={summary.antenna.dt})
            </div>
          )}
          {summary.cadUsed.length > 0 && (
            <div className="text-cyan-300 font-mono">CAD로 생성: {summary.cadUsed.length}건</div>
          )}
          {summary.cadFailed.length > 0 && (
            <div className="text-amber-300 font-mono">CAD 실패: {summary.cadFailed.length}건</div>
          )}
          {summary.antennaError && (
            <div className="text-amber-300 leading-tight">안테나: {summary.antennaError}</div>
          )}
          <div className="text-text-secondary leading-tight pt-0.5">
            → [산출물 받기]로 zip을 받아 로컬 public/ 에 풀고 git commit 하세요.
          </div>
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
