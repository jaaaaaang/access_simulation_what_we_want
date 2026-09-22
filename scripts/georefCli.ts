/**
 * 단지 위치 보정 CLI — src/lib/georef.ts 를 터미널에서 실행 (rapa_v3.py가 호출).
 *
 *   npx tsx scripts/georefCli.ts --file public/temps/m-RAPA-2206-3486.json \
 *        --lat 37.3157 --lng 127.9507 [--address "강원 원주시 단구동"] [--apply --out <path>]
 *
 * VWorld 인증키는 .env 의 VWORLD_API_KEY / VWORLD_API_DOMAIN(키의 등록 서비스URL)을 쓴다.
 * 결과(JSON 한 줄)를 stdout 마지막 줄에 출력한다: {confidence, iou, rotDeg, shiftM, source, label, reason}
 */
import fs from 'fs';
import path from 'path';
import { proposeGeoref, applyGeoref } from '../src/lib/georef';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name: string) => process.argv.includes('--' + name);

function loadEnv(root: string) {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  const root = path.resolve(__dirname, '..');
  loadEnv(root);
  const file = arg('file');
  if (!file) { console.error('--file <temps json> 필요'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = (process.env.VWORLD_API_KEY || '').trim();
  const domain = (process.env.VWORLD_API_DOMAIN || '').trim();
  if (!key) { console.error('.env VWORLD_API_KEY 없음 — 위치 보정 생략'); process.exit(3); }
  const base = arg('base');   // 테스트용 엔드포인트 교체

  const get = async (url: string) => {
    const u = base ? url.replace('https://api.vworld.kr/req', base) : url;
    const r = await fetch(u, { headers: domain ? { Referer: domain, Origin: domain, 'User-Agent': 'Mozilla/5.0' } : {} });
    return r.json();
  };

  const lat = Number(arg('lat')), lng = Number(arg('lng'));
  const apt = Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng, address: arg('address') || '', raw: { 주소: arg('address') || '', 공사명: arg('name') || '' } }
    : null;

  const p = await proposeGeoref({ data, apt, get, key, domain, log: (s) => console.error(s) });
  const b = p.best;
  if (b && has('apply') && (p.confidence === 'high' || p.confidence === 'medium')) {
    const next = applyGeoref(data, { rotDeg: b.rotDeg, center: b.center }, {
      method: `shape-match(${b.source}: ${b.label})`,
      confidence: p.confidence,
      anchor: `VWorld 형상 정합 IoU ${b.iou} → 도심 (${b.center[1].toFixed(7)},${b.center[0].toFixed(7)}), 이동 ${b.shiftM}m / 회전 ${b.rotDeg}°`,
      georef_fit: { iou: b.iou, source: b.source, label: b.label, areaRatio: b.areaRatio, margin: p.diagnostics.margin, center: b.center,
                    rotationCandidates: p.diagnostics.rotationCandidates || null, at: new Date().toISOString() },
    });
    fs.writeFileSync(arg('out') || file, JSON.stringify(next, null, 1), 'utf8');
  }
  const line = b
    ? `${p.confidence} · ${b.source} ${b.label} · IoU ${b.iou} · 이동 ${b.shiftM}m · 회전 ${b.rotDeg}° · ${p.reason}`
    : `실패 · ${p.reason}`;
  console.log(line);
  console.log(JSON.stringify({ confidence: p.confidence, applied: Boolean(b && has('apply') && (p.confidence === 'high' || p.confidence === 'medium')),
                               iou: b?.iou ?? null, rotDeg: b?.rotDeg ?? null, shiftM: b?.shiftM ?? null,
                               source: b?.source ?? null, label: b?.label ?? null, reason: p.reason }));
}
main().catch(e => { console.error('georefCli 오류:', e?.message || e); process.exit(1); });
