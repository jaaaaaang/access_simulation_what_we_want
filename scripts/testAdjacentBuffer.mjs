/**
 * 인접 반경(adjacentBuildingBuffer) 동작 검증
 * ---------------------------------------------------------------------------
 * Ground Rule 확인 사항:
 *   · 건물   : 단지 내부 OR 외곽 N미터 이내 → 포함
 *   · 안테나 : 단지 내부는 제외 AND 외곽 N미터 이내 → 포함
 *              (단지 내부 장비는 아파트 준공 시 철거되므로 커버리지에서 뺀다)
 *   · N은 WG 검증 중인 잠정값(기본 65m)이며, 바꾸면 건물·안테나에 동일 적용된다.
 *
 * 실행: npx tsx scripts/testAdjacentBuffer.mjs
 */
import { antennasToEquipments } from '../src/lib/antennaAssets.ts';
import { lonLatToCanvas } from '../src/lib/moiraPolygon.ts';
import { distToPolygon, pointInPolygon } from '../src/lib/simulation.ts';
import { STANDARD_SIM_PARAMS } from '../src/lib/standardParams.ts';

const B = STANDARD_SIM_PARAMS.adjacentBuildingBuffer;
console.log('기본 반경 =', B, 'm\n');

const mapping = { minLon:128.6220, minLat:35.8810, lonRange:0.0020, latRange:0.0015, cWidth:1000, cHeight:750 };
const complex = [{x:250,y:200},{x:750,y:200},{x:750,y:550},{x:250,y:550}];
const ppm = 1000 / (0.0020*111320*Math.cos(35.88*Math.PI/180));
console.log('축척:', ppm.toFixed(3), 'px/m  → 65m =', (65*ppm).toFixed(1), 'px\n');

// 캔버스 좌표를 직접 정해두고, 거기서 역으로 위경도를 만든다 (의도한 거리를 정확히 재현)
const toLonLat = (x,y) => [ mapping.minLon + (x/mapping.cWidth)*mapping.lonRange,
                            mapping.minLat + ((mapping.cHeight-y)/mapping.cHeight)*mapping.latRange ];
const mk = (x,y,label) => { const [lon,lat]=toLonLat(x,y);
  return {lat, lon, azimuth:180, enbId:label, sector:'1', txAnt:'AAU20-3.5G-32T(SS)',
          hBeamwidth:65, txTilt:5, txETilt:3, towerHeight:20, dupCnt:1}; };

const cases = [
  ['INSIDE', 500, 375],                       // 단지 한가운데
  ['NEAR',   500, 200 - 30*ppm],              // 경계 위 30m
  ['FAR',    500, 200 - 200*ppm],             // 경계 위 200m
];
for (const [label,x,y] of cases) {
  const p = {x,y};
  const inside = pointInPolygon(p, complex);
  const d = distToPolygon(p, complex)/ppm;
  console.log(`  ${label.padEnd(7)} 내부=${inside?'예':'아니오'}  외곽거리=${inside?'-':d.toFixed(0)+'m'}`);
}

const assets = cases.map(([l,x,y]) => mk(x,y,l));
const kept = antennasToEquipments(assets, mapping, complex, ppm, {}).map(e=>e.enbId);
console.log('\n[65m 적용] 통과:', kept.join(', ') || '(없음)');
const ok1 = !kept.includes('INSIDE');
const ok2 = kept.includes('NEAR');
const ok3 = !kept.includes('FAR');
console.log(`  ① 단지 내부(INSIDE) 제거        : ${ok1?'✓':'✗'}   ← 준공 시 철거될 장비`);
console.log(`  ② 외곽 30m(NEAR) 포함           : ${ok2?'✓':'✗'}`);
console.log(`  ③ 외곽 200m(FAR) 제외           : ${ok3?'✓':'✗'}`);

const wide = antennasToEquipments(assets, mapping, complex, ppm, {bufferMeters:250}).map(e=>e.enbId);
console.log(`\n[250m로 변경] 통과: ${wide.join(', ')}`);
const ok4 = wide.includes('FAR') && !wide.includes('INSIDE');
console.log(`  ④ 반경 바꾸면 FAR 포함, INSIDE는 계속 제외 : ${ok4?'✓':'✗'}  ← WG 값 변경 대응`);

const noPoly = antennasToEquipments(assets, mapping, null, ppm, {}).length;
console.log(`\n[폴리곤 없음] ${noPoly}/3 통과 — 기준이 없으므로 전부 통과가 정상`);

console.log('\n' + ((ok1&&ok2&&ok3&&ok4&&noPoly===3) ? '전체 통과 ✅' : '실패 ❌'));
