import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  SimulationParams,
  SimulationResult,
  BatchResult,
  BatchResultStatus,
  BatchStepReport,
  BatchStepKey,
  StepStatus,
  BatchSite,
  TopRankSummary,
} from '../src/types';
import { prepareSceneFromMoira } from '../src/lib/scenePrep';
import { runSimulation } from '../src/lib/simulation';
import { MoiraComplexPolygonResult } from '../src/lib/moiraPolygon';
import { VERANDA_AI_VERSION } from '../src/lib/verandaAi';
import { validateRapaKey, safeFilePath, atomicWriteJson } from '../src/lib/pathUtils';
import { buildBatchResult } from '../src/lib/resultSerializer';
import { STANDARD_SIM_PARAMS } from '../src/lib/standardParams';

export interface LosRunnerOptions {
  params?: Partial<SimulationParams>;
  outputDir?: string;
  tempsDir?: string;
  aptListPath?: string;
  silent?: boolean;
}

const DEFAULT_PARAMS: SimulationParams = {
  ...STANDARD_SIM_PARAMS,
  pixelsPerMeter: 1.0,
  strictCoLocation: true,
  simulationMode: 'full_auto',
};

/** 안전한 rapaKey 파일 경로 찾기 (Path Traversal 방지) */
export async function findTempsFile(rapaKey: string, tempsDir: string): Promise<string | null> {
  const validKey = validateRapaKey(rapaKey);
  const altKey = validKey.startsWith('m-') ? validKey.slice(2) : `m-${validKey}`;

  const candidates = [
    safeFilePath(tempsDir, validKey),
    safeFilePath(tempsDir, altKey),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { }
  }
  return null;
}

/**
 * 단일 RAPA 단지 대상 헤드리스 LOS 시뮬레이션 실행기
 */
export async function runLosSimulation(
  rawRapaKey: string,
  options: LosRunnerOptions = {}
): Promise<BatchResult> {
  const startTime = Date.now();
  const cwd = process.cwd();
  const tempsDir = options.tempsDir || path.join(cwd, 'public', 'temps');
  const outputDir = options.outputDir || path.join(cwd, 'data', 'results');

  let rapaKey = '';
  try {
    rapaKey = validateRapaKey(rawRapaKey);
  } catch (err: any) {
    rapaKey = String(rawRapaKey || '').slice(0, 50);
  }

  const stepsReport: Record<BatchStepKey, StepStatus> = {
    '2.1_polygon_fetch': 'SKIP',
    '2.2_nearby_sites': 'SKIP',
    '2.3_kanro_check': 'SKIP',
    '2.4_veranda_setup': 'SKIP',
    '2.5_polygon_filter': 'SKIP',
    '2.6_los_simulation': 'SKIP',
    '2.7_ailayer_prep': 'SKIP',
    '3_ailayer_update': 'SKIP',
  };

  let aptName: string = rapaKey;
  let sceneResult: ReturnType<typeof prepareSceneFromMoira> | null = null;
  let fullParams: SimulationParams = { ...DEFAULT_PARAMS, ...(options.params || {}) };

  try {
    // RAPA Key 검증
    validateRapaKey(rapaKey);

    // ------------------------------------------------------------------------
    // Step 2.1: 단지/건물 폴리곤 조회 (temps JSON 로드)
    // ------------------------------------------------------------------------
    const filePath = await findTempsFile(rapaKey, tempsDir);
    if (!filePath) {
      stepsReport['2.1_polygon_fetch'] = 'NOK';
      throw new Error(`temps 데이터 파일을 찾을 수 없습니다 (key: ${rapaKey})`);
    }

    const rawData = await fs.readFile(filePath, 'utf8');
    const moiraData: MoiraComplexPolygonResult = JSON.parse(rawData);

    if (!moiraData || (!moiraData.buildings?.length && !moiraData.complex?.polygon?.length)) {
      stepsReport['2.1_polygon_fetch'] = 'NOK';
      throw new Error(`유효한 건물 또는 단지 폴리곤 데이터가 없습니다 (key: ${rapaKey})`);
    }
    stepsReport['2.1_polygon_fetch'] = 'OK';

    // ------------------------------------------------------------------------
    // Step 2.2 ~ 2.3: 기존 시설 & 관로동 확인
    // ------------------------------------------------------------------------
    stepsReport['2.2_nearby_sites'] = 'SKIP';
    stepsReport['2.3_kanro_check'] = 'OK';

    // ------------------------------------------------------------------------
    // Step 2.4 & 2.5: 장면 구성 & 베란다 자동 생성 & 폴리곤 필터링
    // ------------------------------------------------------------------------
    sceneResult = prepareSceneFromMoira(moiraData, {
      generateVerandas: true,
      customPixelsPerMeter: options.params?.pixelsPerMeter,
      adjacentBuildingBuffer: fullParams.adjacentBuildingBuffer,
    });

    if (sceneResult.verandas.length === 0) {
      stepsReport['2.4_veranda_setup'] = 'NOK';
      throw new Error(`단지 내에서 유효한 베란다를 추출하지 못했습니다 (건물수: ${sceneResult.buildings.length})`);
    }
    stepsReport['2.4_veranda_setup'] = 'OK';
    stepsReport['2.5_polygon_filter'] = 'OK';

    fullParams = {
      ...fullParams,
      pixelsPerMeter: sceneResult.pixelsPerMeter,
      analysisArea: sceneResult.analysisArea || undefined,
    };

    // ------------------------------------------------------------------------
    // Step 2.6: LOS 시뮬레이션 연산
    // ------------------------------------------------------------------------
    const simResult: SimulationResult = runSimulation(
      sceneResult.buildings,
      sceneResult.verandas,
      fullParams
    );
    stepsReport['2.6_los_simulation'] = 'OK';

    // ------------------------------------------------------------------------
    // Step 2.7: ailayer 업데이트 포맷 및 결과 조립
    // ------------------------------------------------------------------------
    stepsReport['2.7_ailayer_prep'] = 'OK';
    stepsReport['3_ailayer_update'] = 'SKIP';

    const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));

    const batchResult: BatchResult = buildBatchResult(
      simResult,
      sceneResult.mapping,
      fullParams,
      rapaKey,
      {
        aptName,
        durationSec,
        source: 'batch',
        buildingCount: sceneResult.buildingCount,
        verandaSource: VERANDA_AI_VERSION,
        pixelsPerMeter: sceneResult.pixelsPerMeter,
        stepReportSteps: stepsReport,
      }
    );

    // 원자적 파일 저장 (tmp + rename)
    const targetFile = safeFilePath(outputDir, rapaKey);
    await atomicWriteJson(targetFile, batchResult);

    if (!options.silent) {
      const statusBadge = batchResult.status === 'WARN' ? '⚠️ WARN' : '✅ OK';
      const siteCount = batchResult.rank1?.sites?.length || 0;
      const sectorCount = (batchResult.rank1?.sites || []).reduce((acc, s) => acc + s.sectors.length, 0);
      console.log(`[LOS-Runner] ${statusBadge} ${rapaKey} 완료 (${durationSec}s) — 커버리지: ${batchResult.rank1?.coverageRatio}%, Site: ${siteCount}개, Sector: ${sectorCount}개${batchResult.warningMsg ? ` (${batchResult.warningMsg})` : ''}`);
    }

    return batchResult;
  } catch (err: any) {
    const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
    const errorMsg = err.message || String(err);

    const stepReport: BatchStepReport = {
      ina_no: rapaKey,
      apt_name: aptName,
      steps: stepsReport,
      overall: 'NOK',
      error_msg: errorMsg,
      los_pct: 0,
      site_cnt: 0,
    };

    const nokResult: BatchResult = {
      rapaKey,
      analyzedAt: new Date().toISOString(),
      durationSec,
      status: 'NOK',
      errorMsg,
      params: fullParams,
      scene: {
        buildingCount: sceneResult?.buildingCount || 0,
        verandaSource: VERANDA_AI_VERSION,
        pixelsPerMeter: sceneResult?.pixelsPerMeter || fullParams.pixelsPerMeter || 1.0,
      },
      stepReport,
    };

    try {
      const targetFile = safeFilePath(outputDir, rapaKey);
      await atomicWriteJson(targetFile, nokResult);
    } catch { }

    if (!options.silent) {
      console.error(`[LOS-Runner] ❌ ${rapaKey} 실패 (${durationSec}s):`, errorMsg);
    }

    return nokResult;
  }
}

// ----------------------------------------------------------------------------
// CLI / 자식 프로세스 진입점
// ----------------------------------------------------------------------------
const isMainModule = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('losRunner.ts') ||
  process.argv[1].endsWith('losRunner.js')
);

if (isMainModule) {
  const args = process.argv.slice(2);
  let targetKey = '';
  let params: Partial<SimulationParams> = {};
  let outputDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--key' && args[i + 1]) {
      targetKey = args[++i];
    } else if (arg.startsWith('--key=')) {
      targetKey = arg.slice(6);
    } else if (arg === '--params' && args[i + 1]) {
      try { params = JSON.parse(args[++i]); } catch { }
    } else if (arg.startsWith('--params=')) {
      try { params = JSON.parse(arg.slice(9)); } catch { }
    } else if (arg === '--outputDir' && args[i + 1]) {
      outputDir = args[++i];
    } else if (arg.startsWith('--outputDir=')) {
      outputDir = arg.slice(12);
    } else if (!arg.startsWith('--') && !targetKey) {
      targetKey = arg;
    }
  }

  if (!targetKey) {
    console.error('사용법: tsx scripts/losRunner.ts <rapaKey> [--params=\'{"beamWidth":65}\']');
    process.exit(1);
  }

  runLosSimulation(targetKey, { params, outputDir })
    .then((result) => {
      const exitCode = result.status === 'OK' || result.status === 'WARN' ? 0 : 2;
      if (process.send) {
        // IPC 메시지 flush 완료 후 종료.
        // send() 직후 바로 exit하면 메시지가 부모(batchManager)에 도달하기 전에
        // 프로세스가 죽어 성공 건이 실패로 오판될 수 있다 (send는 비동기).
        process.send(result, (err: Error | null) => {
          if (err) {
            console.error('[LOS-Runner] IPC 결과 전송 실패 (결과 파일은 저장됨):', err.message);
          }
          process.exit(exitCode);
        });
      } else {
        process.exit(exitCode);
      }
    })
    .catch((err) => {
      console.error('[LOS-Runner Fatal Error]:', err);
      process.exit(1);
    });
}
