/**
 * LOS 앱 전체 흐름 E2E 점검 — 앱의 실제 소스를 그대로 불러 재현한다.
 *   ① temps 캐시 로드 → ② 씬 구성(건물 65m 필터) → ③ 안테나 배치(단지 내부 제외)
 *   ④ Flask 연동 상태 → ⑤ 배치 산출물 API
 *
 * 사전 조건: npm run dev (3001) + ~/cinderella/bin/python app.py (8080)
 * 실행:      npx tsx scripts/testLosE2E.mjs
 */
/** LOS 앱의 실제 소스를 그대로 불러 전체 흐름을 재현한다 (RAPA 선택 → 씬 구성 → 안테나 배치) */
import { prepareSceneFromMoira } from '../src/lib/scenePrep.ts';
import { antennasToEquipments } from '../src/lib/antennaAssets.ts';
import { STANDARD_SIM_PARAMS } from '../src/lib/standardParams.ts';

const APP = 'http://localhost:3001';
const KEY = 'm-RAPA-1801-03-02-412';

console.log('=== ① 앱이 하는 것과 동일하게 temps 캐시 로드 ===');
const moira = await (await fetch(`${APP}/temps/${KEY}.json`)).json();
console.log(`  ${moira.rapaKey}: 단지폴리곤 ${moira.complex.polygon.length}점, 건물 ${moira.buildings.length}개`);
console.log(`  buildingSource=${moira.buildingSource} bufferDeg=${moira.bufferDeg}`);

console.log('\n=== ② 씬 구성 (건물 65m 필터 적용) ===');
const scene = prepareSceneFromMoira(moira, {
  generateVerandas: false,
  adjacentBuildingBuffer: STANDARD_SIM_PARAMS.adjacentBuildingBuffer,
});
console.log(`  캔버스 ${scene.mapping.cWidth}x${scene.mapping.cHeight}, 축척 ${scene.pixelsPerMeter} px/m`);
console.log(`  건물: 원본 ${moira.buildings.length}개 → 65m 필터 후 ${scene.buildings.length}개`);
console.log(`  단지 폴리곤(analysisArea): ${scene.analysisArea ? scene.analysisArea.length+'점' : '없음'}`);
if (scene.buildings.length === 0) throw new Error('건물이 하나도 안 남음');

console.log('\n=== ③ 자사 안테나 배치 (단지 내부 제외 + 65m) ===');
const cache = await (await fetch(`${APP}/antenna_assets.json`)).json();
const assets = cache.targets[KEY] || [];
console.log(`  캐시에 이 단지 안테나 ${assets.length}개`);
const eq = antennasToEquipments(assets, scene.mapping, scene.analysisArea, scene.pixelsPerMeter,
  { bufferMeters: STANDARD_SIM_PARAMS.adjacentBuildingBuffer, buildings: scene.buildings });
console.log(`  → 65m 이내 & 단지 외부인 것만: ${eq.length}개 배치`);
eq.slice(0,3).forEach(e => console.log(`     ${e.id} 방위각 ${e.angle}° ${e.bIdx!==undefined?`(건물#${e.bIdx})`:''}`));

console.log('\n=== ④ Flask 연동 상태 (앱 프록시 경유) ===');
const ping = await (await fetch(`${APP}/daily-tmap-data-querying-l/los/ping`)).json();
console.log(`  ${ping.service} · CAD 저장소 파일 ${ping.cadFiles}개`);
console.log(`  사내DB(idcube): ${ping.capabilities.idcube_hive_connector ? '연결됨' : '없음(사외망이라 정상)'}`);

console.log('\n=== ⑤ 배치 산출물 API ===');
const outs = await (await fetch(`${APP}/daily-tmap-data-querying-l/los/batch/outputs`)).json();
console.log(`  temps ${outs.tempsCount}개 / 10MB초과 ${outs.largeFiles.length}개`);

console.log('\n전체 흐름 정상 ✅');
