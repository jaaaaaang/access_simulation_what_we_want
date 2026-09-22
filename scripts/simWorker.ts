/**
 * 단일 시뮬레이션 워커 — 플로팅 "분석실행" 버튼용 별도 프로세스
 * ---------------------------------------------------------------------------
 * server.ts 의 /api/sim/run-single 이 이 스크립트를 fork(--import tsx) 로 띄운다.
 * 배치(scripts/losRunner.ts)와 같은 구조: express 메인 프로세스는 요청만 받고,
 * 수 분이 걸리는 runSimulation() 은 이 자식 프로세스에서 돈다 → 이벤트 루프 블록 없음.
 *
 * 입력: --input <scene.json 경로>  ({ buildings, verandas, params, equipments, rapaKey })
 * 출력: 결과를 --output <경로> 에 JSON 저장 + IPC(process.send) 로도 전달
 *       (배치와 동일하게 "IPC 유실 시 파일 폴백" 이중 방어)
 *
 * 로컬 실행 예: npx tsx scripts/simWorker.ts --input data/sim-jobs/x.in.json --output data/sim-jobs/x.out.json
 */
import fs from 'fs/promises';
import { runSimulation } from '../src/lib/simulation';
import { SimulationParams, Polygon, Line, Equipment } from '../src/types';

type SceneInput = {
  buildings: Polygon[];
  verandas: Line[];
  params: SimulationParams;
  equipments?: Equipment[];
  rapaKey?: string | null;
};

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const pref = args.find(a => a.startsWith(`${name}=`));
  return pref ? pref.slice(name.length + 1) : undefined;
}

async function main() {
  const inputPath = getArg('--input');
  const outputPath = getArg('--output');
  if (!inputPath) {
    console.error('사용법: tsx scripts/simWorker.ts --input <scene.json> [--output <result.json>]');
    process.exit(1);
  }

  const startMs = Date.now();
  const raw = await fs.readFile(inputPath, 'utf8');
  const scene: SceneInput = JSON.parse(raw);

  if (!Array.isArray(scene.buildings) || !Array.isArray(scene.verandas)) {
    throw new Error('buildings / verandas 배열이 필요합니다.');
  }

  console.error(`[SimWorker] 시작 (key: ${scene.rapaKey || 'manual'}, 건물 ${scene.buildings.length}, 베란다 ${scene.verandas.length}, pid ${process.pid})`);

  const result = runSimulation(
    scene.buildings,
    scene.verandas,
    (scene.params || {}) as SimulationParams,
    scene.equipments || []
  );

  const durationMs = Date.now() - startMs;
  const payload = { ok: true, result, durationMs, rapaKey: scene.rapaKey || null };

  if (outputPath) {
    const tmp = `${outputPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, outputPath);
  }
  console.error(`[SimWorker] 완료 ${durationMs}ms — 커버리지 ${result.coverageRatio?.toFixed(1)}%, 장비 ${result.equipments.length}`);

  if (process.send) {
    // send 는 비동기 — 콜백 이후에 종료해야 부모가 메시지를 받는다 (losRunner.ts 와 동일 주의)
    process.send(payload, (err: Error | null) => {
      if (err) console.error('[SimWorker] IPC 전송 실패 (파일 결과는 저장됨):', err.message);
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[SimWorker] 실패:', err?.stack || err);
  if (process.send) {
    process.send({ ok: false, error: String(err?.message || err) }, () => process.exit(2));
  } else {
    process.exit(2);
  }
});
