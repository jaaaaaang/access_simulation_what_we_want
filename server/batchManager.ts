import fs from 'fs/promises';
import path from 'path';
import { fork, ChildProcess } from 'child_process';
import {
  SimulationParams,
  BatchResult,
  ResultIndex,
  ResultIndexItem,
  BatchJobStatus,
  BatchJobItem,
  BatchStatus,
  BatchStartParams,
} from '../src/types';
import { validateRapaKey, safeFilePath, atomicWriteJson } from '../src/lib/pathUtils';
import { STANDARD_SIM_PARAMS } from '../src/lib/standardParams';
import { findTempsFile } from '../scripts/losRunner';

class AsyncLock {
  private queue: Promise<any> = Promise.resolve();

  public acquire<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => task());
    this.queue = next.then(() => { }, () => { });
    return next;
  }
}

export interface BatchManagerOptions {
  baseDir?: string;
  dataDir?: string;
  batchDir?: string;
  resultsDir?: string;
}

export class BatchManager {
  private baseDir: string;
  private dataDir: string;
  private batchDir: string;
  private resultsDir: string;
  private queueFile: string;
  private indexFile: string;

  private status: BatchStatus = 'idle';
  private concurrency: number = 2;
  private params: Partial<SimulationParams> = {};
  private items: BatchJobItem[] = [];
  private startedAt?: string;
  private finishedAt?: string;

  private activeProcesses: Map<string, ChildProcess> = new Map();
  private runningKeys: Set<string> = new Set();
  private initialized: boolean = false;

  private queueLock = new AsyncLock();
  private indexLock = new AsyncLock();

  constructor(options: BatchManagerOptions = {}) {
    this.baseDir = options.baseDir || process.cwd();
    this.dataDir = options.dataDir || path.join(this.baseDir, 'data');
    this.batchDir = options.batchDir || path.join(this.dataDir, 'batch');
    this.resultsDir = options.resultsDir || path.join(this.dataDir, 'results');
    this.queueFile = path.join(this.batchDir, 'queue.json');
    this.indexFile = path.join(this.resultsDir, '_index.json');
  }

  /**
   * 매니저 초기화: 디렉토리 생성 및 이전 큐 상태/인덱스 복구
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.batchDir, { recursive: true });
    await fs.mkdir(this.resultsDir, { recursive: true });

    // 1. 큐 복구
    try {
      const rawQueue = await fs.readFile(this.queueFile, 'utf8');
      const savedQueue: BatchJobStatus = JSON.parse(rawQueue);
      if (savedQueue && Array.isArray(savedQueue.items)) {
        this.items = savedQueue.items.map((item) => {
          // 서버 재시작 전 실행 중이던 항목은 실패 처리
          if (item.status === 'running') {
            return {
              ...item,
              status: 'failed',
              error: '서버 재시작으로 인한 중단',
            };
          }
          return item;
        });

        this.concurrency = savedQueue.concurrency || 2;
        this.status = savedQueue.status === 'running' ? 'cancelled' : savedQueue.status;
        this.startedAt = savedQueue.startedAt;
        this.finishedAt = savedQueue.finishedAt || new Date().toISOString();
      }
    } catch {
      // 큐 파일이 없는 경우 정상 초기화
    }

    // 2. 인덱스 파일 확인 및 없으면 생성
    try {
      await fs.access(this.indexFile);
    } catch {
      const initialIndex: ResultIndex = {
        updatedAt: new Date().toISOString(),
        items: {},
      };
      await atomicWriteJson(this.indexFile, initialIndex);
    }

    this.initialized = true;
  }

  /**
   * 큐 상태를 queue.json에 원자적 & 직렬화 저장
   */
  private async persistQueue(): Promise<void> {
    return this.queueLock.acquire(async () => {
      try {
        const statusObj = this.getStatus();
        await atomicWriteJson(this.queueFile, statusObj);
      } catch (err: any) {
        console.error('[BatchManager] 큐 영속화 실패:', err.message);
      }
    });
  }

  /**
   * _index.json 인덱스 업데이트 (원자적 & 직렬화 갱신)
   */
  private async updateIndex(rapaKey: string, resultItem: ResultIndexItem): Promise<void> {
    return this.indexLock.acquire(async () => {
      try {
        let index: ResultIndex = { updatedAt: new Date().toISOString(), items: {} };
        try {
          const raw = await fs.readFile(this.indexFile, 'utf8');
          index = JSON.parse(raw);
        } catch { }

        index.items[rapaKey] = resultItem;
        index.updatedAt = new Date().toISOString();

        await atomicWriteJson(this.indexFile, index);
      } catch (err: any) {
        console.error('[BatchManager] _index.json 갱신 실패:', err.message);
      }
    });
  }

  /**
   * 배치 작업 시작
   */
  public async startBatch(options: BatchStartParams): Promise<{
    status: BatchStatus;
    total: number;
    queued: number;
    skipped: number;
  }> {
    await this.init();

    if (this.status === 'running') {
      throw new Error('이미 배치가 실행 중입니다. 기존 배치를 취소하거나 완료 후 다시 시작하세요.');
    }

    const rawKeys = Array.from(new Set(options.rapaKeys || [])).filter(Boolean);
    if (rawKeys.length === 0) {
      throw new Error('배치 분석 대상 rapaKey 목록이 비어 있습니다.');
    }

    // Key 유효성 검사 및 정제
    const rapaKeys = rawKeys.map((k) => validateRapaKey(k));

    this.concurrency = Math.min(4, Math.max(1, options.concurrency || 2));
    
    // 파라미터 화이트리스트 (PPM, analysisArea, preventAutoSectors 오염 방어)
    const rawParams = options.params || {};
    this.params = {
      beamWidth: typeof rawParams.beamWidth === 'number' ? rawParams.beamWidth : STANDARD_SIM_PARAMS.beamWidth,
      maxRange: typeof rawParams.maxRange === 'number' ? rawParams.maxRange : STANDARD_SIM_PARAMS.maxRange,
      targetCoverage: typeof rawParams.targetCoverage === 'number' ? rawParams.targetCoverage : STANDARD_SIM_PARAMS.targetCoverage,
      adjacentBuildingBuffer: typeof rawParams.adjacentBuildingBuffer === 'number' ? rawParams.adjacentBuildingBuffer : STANDARD_SIM_PARAMS.adjacentBuildingBuffer,
      facilitySearchRadius: typeof rawParams.facilitySearchRadius === 'number' ? rawParams.facilitySearchRadius : STANDARD_SIM_PARAMS.facilitySearchRadius,
      candidateStepMeters: typeof rawParams.candidateStepMeters === 'number' ? rawParams.candidateStepMeters : STANDARD_SIM_PARAMS.candidateStepMeters,
      strictCoLocation: rawParams.strictCoLocation !== false,
      simulationMode: 'full_auto',
    };
    const skipAnalyzed = options.skipAnalyzed !== false && !options.forceRerun;

    // 이미 완료된 항목 확인
    let existingIndex: ResultIndex = { updatedAt: '', items: {} };
    try {
      const raw = await fs.readFile(this.indexFile, 'utf8');
      existingIndex = JSON.parse(raw);
    } catch { }

    const newItems: BatchJobItem[] = [];
    let skippedCount = 0;
    let queuedCount = 0;

    const tempsDir = path.join(this.baseDir, 'public', 'temps');
    for (const key of rapaKeys) {
      const existingStatus = existingIndex.items[key]?.status;
      const isAlreadyDone = existingStatus === 'OK' || existingStatus === 'WARN';
      if (skipAnalyzed && isAlreadyDone) {
        newItems.push({
          rapaKey: key,
          status: 'skipped',
          coverageRatio: existingIndex.items[key].coverageRatio,
          siteCount: existingIndex.items[key].siteCount,
          sectorCount: existingIndex.items[key].sectorCount,
          durationSec: existingIndex.items[key].durationSec,
        });
        skippedCount++;
        continue;
      }

      // 폴리곤 파일 존재 및 유효 데이터 안전 검사 (미확보 단지는 에러 폭탄 방지를 위해 skipped 처리)
      const tempsPath = await findTempsFile(key, tempsDir);
      let isValidPolygon = false;
      if (tempsPath) {
        try {
          const raw = await fs.readFile(tempsPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.buildings?.length > 0 || parsed.complex?.polygon?.length >= 3) && !parsed.skipped) {
            isValidPolygon = true;
          }
        } catch { }
      }

      if (!isValidPolygon) {
        newItems.push({
          rapaKey: key,
          status: 'skipped',
          error: '단지 폴리곤 미확보 (배치 대상 제외)',
        });
        skippedCount++;
        continue;
      }

      newItems.push({
        rapaKey: key,
        status: 'pending',
      });
      queuedCount++;
    }

    this.items = newItems;
    this.status = queuedCount > 0 ? 'running' : 'completed';
    this.startedAt = new Date().toISOString();
    this.finishedAt = queuedCount > 0 ? undefined : new Date().toISOString();

    await this.persistQueue();

    if (queuedCount > 0) {
      // 비동기 워커 루프 시작
      this.drainQueue();
    }

    return {
      status: this.status,
      total: rapaKeys.length,
      queued: queuedCount,
      skipped: skippedCount,
    };
  }

  /**
   * 워커 풀 작업 스케줄링 (동시성 제어)
   */
  private async drainQueue(): Promise<void> {
    if (this.status !== 'running') return;

    while (this.runningKeys.size < this.concurrency) {
      const nextItem = this.items.find((item) => item.status === 'pending');
      if (!nextItem) break;

      const rapaKey = nextItem.rapaKey;
      this.runningKeys.add(rapaKey);
      nextItem.status = 'running';
      nextItem.startTime = new Date().toISOString();
      await this.persistQueue();

      this.spawnWorker(nextItem).then(() => {
        this.runningKeys.delete(rapaKey);
        this.activeProcesses.delete(rapaKey);
        this.persistQueue();

        // 큐에 남은 작업이 더 있는지 확인
        const hasPending = this.items.some((i) => i.status === 'pending');
        if (hasPending && this.status === 'running') {
          this.drainQueue();
        } else if (this.runningKeys.size === 0 && this.status === 'running') {
          // 모든 작업 완료
          this.status = 'completed';
          this.finishedAt = new Date().toISOString();
          this.persistQueue();
          console.log(`[BatchManager] 🏁 전체 배치 작업 완료 (총 ${this.items.length}건)`);
        }
      });
    }
  }

  /**
   * scripts/losRunner.ts 를 child_process로 실행
   */
  private spawnWorker(item: BatchJobItem): Promise<void> {
    return new Promise((resolve) => {
      const runnerScript = path.join(this.baseDir, 'scripts', 'losRunner.ts');
      const args = [
        '--key', item.rapaKey,
        '--params', JSON.stringify(this.params),
        '--outputDir', this.resultsDir,
      ];

      // tsx 로더를 사용하여 TypeScript 스크립트 실행
      const child = fork(runnerScript, args, {
        execArgv: ['--import', 'tsx'],
        silent: true,
      });

      this.activeProcesses.set(item.rapaKey, child);

      let resultData: BatchResult | null = null;

      child.on('message', (msg: any) => {
        if (msg && (msg.status === 'OK' || msg.status === 'WARN' || msg.status === 'NOK')) {
          resultData = msg as BatchResult;
        }
      });

      let stderrBuf = '';
      child.stderr?.on('data', (d) => { stderrBuf += d.toString(); });

      child.on('exit', async (code, signal) => {
        item.endTime = new Date().toISOString();
        const startMs = item.startTime ? new Date(item.startTime).getTime() : Date.now();
        item.durationSec = Math.max(1, Math.round((Date.now() - startMs) / 1000));

        // IPC 메시지 유실 폴백: 정상 종료(code 0/2)인데 메시지를 못 받았으면
        // 러너가 저장한 결과 파일을 직접 읽는다. (send→exit 사이 race 이중 방어)
        if (!resultData && (code === 0 || code === 2) && signal === null) {
          try {
            const raw = await fs.readFile(safeFilePath(this.resultsDir, item.rapaKey), 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && (parsed.status === 'OK' || parsed.status === 'WARN' || parsed.status === 'NOK')) {
              resultData = parsed as BatchResult;
              console.warn(`[BatchManager] IPC 메시지 유실 감지 (${item.rapaKey}) — 결과 파일에서 복구함`);
            }
          } catch { }
        }

        if (signal === 'SIGTERM' || signal === 'SIGKILL' || this.status === 'cancelled') {
          item.status = 'failed';
          item.error = '작업 취소됨';
        } else if (code === 0 && (resultData?.status === 'OK' || resultData?.status === 'WARN')) {
          item.status = 'completed';
          item.coverageRatio = resultData.rank1?.coverageRatio ?? resultData.topRanks?.[0]?.coverageRatio ?? 0;
          item.siteCount = resultData.rank1?.sites?.length ?? 0;
          item.sectorCount = (resultData.rank1?.sites || []).reduce((acc, s) => acc + s.sectors.length, 0);
          item.steps = resultData.stepReport?.steps;

          await this.updateIndex(item.rapaKey, {
            status: resultData.status,
            coverageRatio: item.coverageRatio,
            siteCount: item.siteCount,
            sectorCount: item.sectorCount,
            analyzedAt: resultData.analyzedAt,
            durationSec: item.durationSec,
            buildingCount: resultData.scene?.buildingCount,
            errorMsg: null,
            warningMsg: resultData.warningMsg || null,
            source: 'batch',
          });
        } else {
          // NOK 또는 실패
          item.status = 'failed';
          item.error = resultData?.errorMsg || stderrBuf.trim() || `종료 코드 ${code}`;
          item.steps = resultData?.stepReport?.steps;

          await this.updateIndex(item.rapaKey, {
            status: 'NOK',
            analyzedAt: new Date().toISOString(),
            durationSec: item.durationSec,
            errorMsg: item.error,
            source: 'batch',
          });
        }

        resolve();
      });

      child.on('error', (err) => {
        console.error(`[BatchManager] 워커 프로세스 에러 (${item.rapaKey}):`, err.message);
      });
    });
  }

  /**
   * 실행 중인 배치 취소
   */
  public async cancelBatch(): Promise<{ cancelled: boolean; stoppedCount: number }> {
    await this.init();

    if (this.status !== 'running') {
      return { cancelled: false, stoppedCount: 0 };
    }

    this.status = 'cancelled';
    this.finishedAt = new Date().toISOString();

    const stoppedCount = this.activeProcesses.size;
    for (const [, child] of this.activeProcesses.entries()) {
      try {
        child.kill('SIGTERM');
      } catch { }
    }

    this.activeProcesses.clear();
    this.runningKeys.clear();

    // pending 항목 취소 처리
    this.items.forEach((item) => {
      if (item.status === 'pending') {
        item.status = 'skipped';
        item.error = '배치 취소로 건너뜀';
      } else if (item.status === 'running') {
        item.status = 'failed';
        item.error = '배치 취소로 중단됨';
      }
    });

    await this.persistQueue();
    return { cancelled: true, stoppedCount };
  }

  /**
   * 배치 상태 조회 (진행률, ETA, 워커 수 등)
   */
  public getStatus(): BatchJobStatus {
    const totalCount = this.items.length;
    const completedCount = this.items.filter((i) => i.status === 'completed').length;
    const failedCount = this.items.filter((i) => i.status === 'failed').length;
    const skippedCount = this.items.filter((i) => i.status === 'skipped').length;
    const pendingCount = this.items.filter((i) => i.status === 'pending').length;
    const activeWorkers = this.runningKeys.size;

    // 예상 잔여시간 (ETA) 계산
    let estimatedRemainingSec: number | undefined;
    if (this.status === 'running' && (pendingCount > 0 || activeWorkers > 0)) {
      const finishedDurations = this.items
        .filter((i) => (i.status === 'completed' || i.status === 'failed') && i.durationSec)
        .map((i) => i.durationSec!);

      const avgDuration = finishedDurations.length > 0
        ? finishedDurations.reduce((a, b) => a + b, 0) / finishedDurations.length
        : 240; // 기본 4분

      const remainingWorkItems = pendingCount + (activeWorkers * 0.5);
      estimatedRemainingSec = Math.round((remainingWorkItems * avgDuration) / Math.max(1, this.concurrency));
    }

    const now = Date.now();
    const enrichedItems: BatchJobItem[] = this.items.map((item) => {
      if (item.status === 'running' && item.startTime) {
        const elapsedSec = Math.max(0, Math.round((now - new Date(item.startTime).getTime()) / 1000));
        // 단지당 통상 6~12초 소요 기준, 10%부터 95%까지 부드럽게 상승하는 충전 게이지
        const progress = Math.min(95, Math.max(10, Math.round((elapsedSec / 10) * 90) + 10));
        return {
          ...item,
          elapsedSec,
          progress,
        };
      } else if (item.status === 'completed') {
        return {
          ...item,
          progress: 100,
        };
      }
      return item;
    });

    return {
      status: this.status,
      concurrency: this.concurrency,
      totalCount,
      completedCount,
      failedCount,
      skippedCount,
      activeWorkers,
      currentRapaKeys: Array.from(this.runningKeys),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      estimatedRemainingSec,
      items: enrichedItems,
    };
  }

  /**
   * 결과 목록 조회 (_index.json)
   */
  public async getResultsList(): Promise<ResultIndex> {
    await this.init();
    try {
      const raw = await fs.readFile(this.indexFile, 'utf8');
      return JSON.parse(raw);
    } catch {
      return { updatedAt: new Date().toISOString(), items: {} };
    }
  }

  /**
   * 개별 단지 결과 JSON 조회
   */
  public async getResult(rapaKey: string): Promise<BatchResult | null> {
    await this.init();
    try {
      const targetPath = safeFilePath(this.resultsDir, rapaKey);
      const raw = await fs.readFile(targetPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * 수동 분석 결과 저장 (지도 -> 전체 리스트)
   */
  public async saveManualResult(rapaKey: string, result: BatchResult): Promise<void> {
    await this.init();
    const validKey = validateRapaKey(rapaKey);
    const targetFile = safeFilePath(this.resultsDir, validKey);

    // rapaKey 및 source 정규화
    result.rapaKey = validKey;
    result.source = 'manual';

    // 원자적 파일 저장
    await atomicWriteJson(targetFile, result);

    // 인덱스 항목 갱신 (기존 updateIndex 재사용)
    const resultItem: ResultIndexItem = {
      status: result.status,
      coverageRatio: result.rank1?.coverageRatio ?? 0,
      siteCount: result.rank1?.sites?.length ?? 0,
      sectorCount: (result.rank1?.sites || []).reduce((acc, s) => acc + s.sectors.length, 0),
      analyzedAt: result.analyzedAt || new Date().toISOString(),
      durationSec: result.durationSec || 1,
      buildingCount: result.scene?.buildingCount,
      errorMsg: result.errorMsg,
      warningMsg: result.warningMsg,
      source: result.source || 'manual',
    };

    await this.updateIndex(validKey, resultItem);
  }

  /**
   * 개별 단지 결과 삭제
   */
  public async deleteResult(rapaKey: string): Promise<boolean> {
    await this.init();
    let deleted = false;
    let validKey = '';
    try {
      validKey = validateRapaKey(rapaKey);
      const targetPath = safeFilePath(this.resultsDir, validKey);
      await fs.unlink(targetPath);
      deleted = true;
    } catch { }

    // 인덱스에서도 삭제 (직렬화 락 획득)
    if (validKey) {
      await this.indexLock.acquire(async () => {
        try {
          const raw = await fs.readFile(this.indexFile, 'utf8');
          const index: ResultIndex = JSON.parse(raw);
          if (index.items[validKey]) {
            delete index.items[validKey];
            index.updatedAt = new Date().toISOString();
            await atomicWriteJson(this.indexFile, index);
          }
        } catch { }
      });
    }

    return deleted;
  }
}
