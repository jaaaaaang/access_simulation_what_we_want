import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { BatchManager } from '../server/batchManager';
import { findTempsFile } from './losRunner';

interface CliOptions {
  concurrency: number;
  filter: 'all' | 'valid-only';
  skipAnalyzed: boolean;
  force: boolean;
  limit?: number;
  keys?: string[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    concurrency: 2,
    filter: 'valid-only',
    skipAnalyzed: true,
    force: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--concurrency=')) {
      options.concurrency = parseInt(arg.slice(14), 10) || 2;
    } else if (arg.startsWith('--filter=')) {
      options.filter = arg.slice(9) as any;
    } else if (arg === '--force') {
      options.force = true;
      options.skipAnalyzed = false;
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.slice(8), 10);
    } else if (arg.startsWith('--keys=')) {
      options.keys = arg.slice(7).split(',').map((k) => k.trim()).filter(Boolean);
    }
  }

  return options;
}

async function main() {
  const cwd = process.cwd();
  const options = parseArgs(process.argv.slice(2));

  console.log('================================================================');
  console.log('🚀 LOS SIMULATOR — Headless Batch CLI Runner (Server Engine)');
  console.log('================================================================');
  console.log(`• 동시 실행 워커(Concurrency): ${options.concurrency}`);
  console.log(`• 필터 모드: ${options.filter}`);
  console.log(`• 기분석 건너뛰기: ${options.skipAnalyzed}`);
  console.log('----------------------------------------------------------------');

  const tempsDir = path.join(cwd, 'public', 'temps');
  let targetKeys: string[] = [];

  if (options.keys && options.keys.length > 0) {
    targetKeys = options.keys;
  } else {
    // public/temps 디렉토리 스캔
    try {
      const files = await fs.readdir(tempsDir);
      const keySet = new Set<string>();
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        let base = file.slice(0, -5);
        if (base.startsWith('m-')) base = base.slice(2);
        keySet.add(base);
      }
      targetKeys = Array.from(keySet);
    } catch (err: any) {
      console.error('❌ temps 디렉토리 조회 실패:', err.message);
      process.exit(1);
    }
  }

  if (options.filter === 'valid-only') {
    const validList: string[] = [];
    for (const key of targetKeys) {
      const f = await findTempsFile(key, tempsDir);
      if (f) {
        try {
          const raw = await fs.readFile(f, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.buildings?.length > 0 || parsed.complex?.polygon?.length >= 3) && !parsed.skipped) {
            validList.push(key);
          }
        } catch { }
      }
    }
    targetKeys = validList;
  }

  if (options.limit && options.limit > 0) {
    targetKeys = targetKeys.slice(0, options.limit);
  }

  console.log(`🎯 총 분석 대상 단지 수: ${targetKeys.length}개`);
  if (targetKeys.length === 0) {
    console.log('분석할 대상 단지가 없습니다. 종료합니다.');
    return;
  }

  const batchManager = new BatchManager({ baseDir: cwd });
  await batchManager.init();

  const startRes = await batchManager.startBatch({
    rapaKeys: targetKeys,
    concurrency: options.concurrency,
    skipAnalyzed: options.skipAnalyzed,
    forceRerun: options.force,
  });

  console.log(`📦 큐 등록 완료 (총 ${startRes.total}건 중 ${startRes.queued}건 실행 대기, ${startRes.skipped}건 스킵)`);
  console.log('----------------------------------------------------------------');

  // 실시간 모니터링 루프
  const startTime = Date.now();
  const pollInterval = setInterval(() => {
    const status = batchManager.getStatus();
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const progressPct = status.totalCount > 0 
      ? Math.round(((status.completedCount + status.failedCount + status.skippedCount) / status.totalCount) * 100) 
      : 0;

    process.stdout.write(
      `\r⏳ [${elapsedSec}s] 진행률: ${progressPct}% | 완료: ${status.completedCount}건, 실패: ${status.failedCount}건, 활성워커: ${status.activeWorkers}대, 잔여ETA: ${status.estimatedRemainingSec || 0}s `
    );

    if (status.status !== 'running') {
      clearInterval(pollInterval);
      console.log('\n================================================================');
      console.log(`🏁 배치 완료! 상태: ${status.status} (총 소요시간: ${elapsedSec}s)`);
      console.log(`• 성공: ${status.completedCount}건`);
      console.log(`• 실패/경고: ${status.failedCount}건`);
      console.log(`• 스킵: ${status.skippedCount}건`);
      console.log(`• 결과 저장 위치: ${path.join(cwd, 'data', 'results')}`);
      console.log('================================================================');
      process.exit(0);
    }
  }, 1000);
}

const isMainModule = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('batchCli.ts') ||
  process.argv[1].endsWith('batchCli.js')
);

if (isMainModule) {
  main().catch((err) => {
    console.error('\n❌ 배치 CLI 실행 중 치명적 오류 발생:', err);
    process.exit(1);
  });
}
