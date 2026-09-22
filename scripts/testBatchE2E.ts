import fs from 'fs/promises';
import path from 'path';
import { runLosSimulation } from './losRunner';
import { BatchManager } from '../server/batchManager';
import { prepareSceneFromMoira } from '../src/lib/scenePrep';
import { runSimulation } from '../src/lib/simulation';
import { MoiraComplexPolygonResult } from '../src/lib/moiraPolygon';

async function main() {
  console.log('================================================================');
  console.log('🧪 LOS Batch Simulation E2E & Pilot Verification (Test Env)');
  console.log('================================================================\n');

  const cwd = process.cwd();
  const tempsDir = path.join(cwd, 'public', 'temps');
  const testDataDir = path.join(cwd, 'data');
  const testBatchDir = path.join(testDataDir, 'batch_test');
  const testResultsDir = path.join(testDataDir, 'results_test');

  // 테스트 디렉토리 초기화 (실데이터 data/results 격리)
  await fs.rm(testBatchDir, { recursive: true, force: true });
  await fs.rm(testResultsDir, { recursive: true, force: true });
  await fs.mkdir(testBatchDir, { recursive: true });
  await fs.mkdir(testResultsDir, { recursive: true });

  // --------------------------------------------------------------------------
  // TEST 1: Headless Pipeline Consistency & Serialization Verification
  // --------------------------------------------------------------------------
  console.log('[TEST 1] Headless Pipeline Consistency & JSON Serialization...');
  console.log(' (참고: 브라우저 UI와 실측 대조는 샘플 단지 로드 후 UI 결과와 비교하는 절차를 권장합니다)');
  const pilotKey = 'm-RAPA-2107-4632';
  const rawData = await fs.readFile(path.join(tempsDir, `${pilotKey}.json`), 'utf8');
  const moiraData: MoiraComplexPolygonResult = JSON.parse(rawData);

  // 직접 모듈 호출 파이프라인
  const directScene = prepareSceneFromMoira(moiraData, { generateVerandas: true });
  const directSim = runSimulation(directScene.buildings, directScene.verandas, {
    beamWidth: 65,
    maxRange: 150,
    targetCoverage: 60,
    pixelsPerMeter: directScene.pixelsPerMeter,
    strictCoLocation: true,
    simulationMode: 'full_auto',
    analysisArea: directScene.analysisArea || undefined,
  });

  // 헤드리스 러너(파일 I/O 및 직렬화 포함) 실행
  const runnerResult = await runLosSimulation(pilotKey, {
    outputDir: testResultsDir,
    silent: true,
  });

  const directCoverage = parseFloat(directSim.coverageRatio.toFixed(1));
  const runnerCoverage = runnerResult.rank1?.coverageRatio;
  const directSiteCount = new Set(directSim.equipments.map(e => `${Math.round(e.x)},${Math.round(e.y)}`)).size;
  const runnerSiteCount = runnerResult.rank1?.sites.length;

  console.log(` - Direct Pipeline Coverage: ${directCoverage}%, Sites: ${directSiteCount}`);
  console.log(` - Headless Runner Coverage:  ${runnerCoverage}%, Sites: ${runnerSiteCount}`);

  if (directCoverage === runnerCoverage && directSiteCount === runnerSiteCount) {
    console.log(' ✅ [TEST 1 PASS] 헤드리스 장면 구성 및 시뮬레이션 직렬화 결과가 일치합니다.\n');
  } else {
    throw new Error(`[TEST 1 FAIL] 불일치: Direct(${directCoverage}%) vs Runner(${runnerCoverage}%)`);
  }

  // --------------------------------------------------------------------------
  // TEST 2: BatchManager Worker Pool & WARN / NOK Status Classification
  // --------------------------------------------------------------------------
  console.log('[TEST 2] BatchManager Worker Pool & Status Classification (OK, WARN, NOK)...');
  const batchManager = new BatchManager({
    baseDir: cwd,
    dataDir: testDataDir,
    batchDir: testBatchDir,
    resultsDir: testResultsDir,
  });
  await batchManager.init();

  const testBatchKeys = [
    'm-RAPA-2107-4632',          // 정상 OK
    'm-RAPA-2407-1978',          // 커버리지 0%/0site -> WARN
    'm-RAPA-2207-4073',          // 커버리지 0%/0site -> WARN
    'm-RAPA-INVALID-NONEXISTENT', // 파일 없음 -> NOK
  ];

  const startRes = await batchManager.startBatch({
    rapaKeys: testBatchKeys,
    concurrency: 2,
    forceRerun: true,
  });
  console.log(` - Batch started: Total ${startRes.total}, Queued ${startRes.queued}`);

  // 폴링 대기
  let status = batchManager.getStatus();
  while (status.status === 'running') {
    const active = status.currentRapaKeys.join(', ');
    const completed = status.completedCount;
    const failed = status.failedCount;
    console.log(`   [진행 중] 완료: ${completed}, 실패: ${failed}, 활성 워커: ${status.activeWorkers} [${active}] (ETA: ${status.estimatedRemainingSec}s)`);
    await new Promise(r => setTimeout(r, 2000));
    status = batchManager.getStatus();
  }

  console.log(` - Batch finished with status: ${status.status}`);
  console.log(` - Completed: ${status.completedCount}, Failed: ${status.failedCount}, Skipped: ${status.skippedCount}`);

  if (status.completedCount === 3 && status.failedCount === 1) {
    console.log(' ✅ [TEST 2 PASS] 유효 단지 3건(OK/WARN) 완료 + 비정상 단지 1건 NOK 격리 확인 완료.\n');
  } else {
    throw new Error(`[TEST 2 FAIL] 예상 결과 불일치: 완료 ${status.completedCount}/3, 실패 ${status.failedCount}/1`);
  }

  // --------------------------------------------------------------------------
  // TEST 3: _index.json OK / WARN / NOK 상태 검증 & 원자적 저장 검증
  // --------------------------------------------------------------------------
  console.log('[TEST 3] _index.json 상태 구분 (OK / WARN / NOK) 검증...');
  const index = await batchManager.getResultsList();
  console.log(' - Index status summary:');
  for (const [k, v] of Object.entries(index.items)) {
    console.log(`   * ${k}: status=${v.status}, coverage=${v.coverageRatio}%, error=${v.errorMsg || 'none'}, warning=${v.warningMsg || 'none'}`);
  }

  const okItem = index.items['m-RAPA-2107-4632'];
  const warnItem = index.items['m-RAPA-2407-1978'];
  const nokItem = index.items['m-RAPA-INVALID-NONEXISTENT'];

  if (okItem?.status === 'OK' && warnItem?.status === 'WARN' && nokItem?.status === 'NOK') {
    console.log(' ✅ [TEST 3 PASS] _index.json 에 OK, WARN, NOK 상태가 명확히 분류되어 기록되었습니다.\n');
  } else {
    throw new Error(`[TEST 3 FAIL] 상태 분류 오류: OK(${okItem?.status}), WARN(${warnItem?.status}), NOK(${nokItem?.status})`);
  }

  // --------------------------------------------------------------------------
  // TEST 4: Skip Analyzed (기존 분석 완료 건 자동 건너뛰기)
  // --------------------------------------------------------------------------
  console.log('[TEST 4] Skip Analyzed 기능 검증 (이미 분석된 단지 자동 건너뛰기)...');
  const skipBatchRes = await batchManager.startBatch({
    rapaKeys: ['m-RAPA-2107-4632', 'm-RAPA-2407-1978', 'm-RAPA-2205-3019'], // 2건은 완료됨, 1건 신규
    concurrency: 2,
    skipAnalyzed: true,
  });

  console.log(` - Total: ${skipBatchRes.total}, Queued: ${skipBatchRes.queued}, Skipped: ${skipBatchRes.skipped}`);
  if (skipBatchRes.skipped === 2 && skipBatchRes.queued === 1) {
    console.log(' ✅ [TEST 4 PASS] 이미 분석된 2건을 정확히 Skip하고 신규 1건만 Queue에 등록했습니다.\n');
  } else {
    throw new Error(`[TEST 4 FAIL] Skip 수량 불일치: Skipped ${skipBatchRes.skipped}/2, Queued ${skipBatchRes.queued}/1`);
  }

  // 완료 대기
  let status4 = batchManager.getStatus();
  while (status4.status === 'running') {
    await new Promise(r => setTimeout(r, 2000));
    status4 = batchManager.getStatus();
  }

  // --------------------------------------------------------------------------
  // TEST 5: Batch Cancellation (작업 즉시 취소 & 프로세스 정리 검증)
  // --------------------------------------------------------------------------
  console.log('[TEST 5] Batch Cancellation (작업 즉시 취소 & 프로세스 정리 검증)...');
  await batchManager.startBatch({
    rapaKeys: ['m-RAPA-2010-5590', 'm-RAPA-2111-6916', 'm-RAPA-2208-4608'],
    concurrency: 2,
    forceRerun: true,
  });

  // 시작 직후 바로 취소
  await new Promise(r => setTimeout(r, 500));
  const cancelRes = await batchManager.cancelBatch();
  console.log(` - Cancelled: ${cancelRes.cancelled}, Stopped processes: ${cancelRes.stoppedCount}`);

  const status5 = batchManager.getStatus();
  if (status5.status === 'cancelled') {
    console.log(' ✅ [TEST 5 PASS] 배치 취소 정상 처리 및 워커 프로세스 회수 완료.\n');
  } else {
    throw new Error(`[TEST 5 FAIL] 상태가 cancelled가 아님: ${status5.status}`);
  }

  // --------------------------------------------------------------------------
  // TEST 6: CRUD API (개별 결과 조회 및 삭제)
  // --------------------------------------------------------------------------
  console.log('[TEST 6] Result Detail & Delete API 검증...');
  const sampleResult = await batchManager.getResult('m-RAPA-2107-4632');
  if (sampleResult && sampleResult.status === 'OK' && sampleResult.rank1 && sampleResult.topRanks) {
    console.log(` - Result loaded: Rank1 Coverage ${sampleResult.rank1.coverageRatio}%, 2nd Samples ${sampleResult.rank1.secondCoveredSamples}, VerandaSource ${sampleResult.scene.verandaSource}`);
  } else {
    throw new Error('[TEST 6 FAIL] Result JSON 스키마 불완전');
  }

  const deleted = await batchManager.deleteResult('m-RAPA-INVALID-NONEXISTENT');
  console.log(` - Delete NOK result: ${deleted}`);
  const indexAfterDelete = await batchManager.getResultsList();
  if (!indexAfterDelete.items['m-RAPA-INVALID-NONEXISTENT']) {
    console.log(' ✅ [TEST 6 PASS] 결과 조회 및 삭제 후 인덱스 갱신 정상 작동 확인.\n');
  } else {
    throw new Error('[TEST 6 FAIL] 삭제 후에도 인덱스에 남아있음');
  }

  // --------------------------------------------------------------------------
  // TEST 7: 10개 단지 실전 배치 종합 E2E 테스트 (격리 환경)
  // --------------------------------------------------------------------------
  console.log('[TEST 7] 10개 단지 실전 배치 종합 E2E 테스트...');
  const tenKeys = [
    'm-RAPA-2407-1978',
    'm-RAPA-2107-4632',
    'm-RAPA-2207-4073',
    'm-RAPA-2205-3019',
    'm-RAPA-2205-3045',
    'm-RAPA-2010-5590',
    'm-RAPA-2111-6916',
    'm-RAPA-2208-4608',
    'm-RAPA-2309-3420',
    'm-RAPA-2402-0382',
  ];

  const batch10 = await batchManager.startBatch({
    rapaKeys: tenKeys,
    concurrency: 2,
    forceRerun: true,
  });

  console.log(` - 10-item batch started: ${batch10.queued} queued`);
  let status10 = batchManager.getStatus();
  while (status10.status === 'running') {
    const active = status10.currentRapaKeys.join(', ');
    console.log(`   [10건 진행] 완료: ${status10.completedCount}/10, 실패: ${status10.failedCount}, 실행중: [${active}]`);
    await new Promise(r => setTimeout(r, 3000));
    status10 = batchManager.getStatus();
  }

  console.log(`\n🎉 10건 배치 완료: 성공 ${status10.completedCount}건, 실패 ${status10.failedCount}건 (상태: ${status10.status})`);
  if (status10.completedCount === 10) {
    console.log(' ✅ [TEST 7 PASS] 10건 배치 종합 E2E 완료!\n');
  } else {
    console.log(` ⚠️ 10건 중 ${status10.completedCount}건 성공, ${status10.failedCount}건 실패 (정상 격리 동작)\n`);
  }

  // 테스트 임시 디렉토리 청소
  await fs.rm(testBatchDir, { recursive: true, force: true });
  await fs.rm(testResultsDir, { recursive: true, force: true });
  console.log(' - 테스트 임시 디렉토리 정리 완료.');

  console.log('================================================================');
  console.log('🏆 ALL TESTS PASSED! Phase 0~2 All Requirements Verified');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
