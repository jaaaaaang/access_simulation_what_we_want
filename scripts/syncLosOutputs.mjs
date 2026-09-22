#!/usr/bin/env node
/**
 * Flask 서버가 만든 산출물을 public/ 로 가져와 git 커밋 준비까지 해주는 스크립트.
 *
 * 기존 수동 절차:
 *   주피터 실행 → JSON 생성 → 10MB 검사 → gitlab에 파일 하나씩 업로드
 * 이 스크립트:
 *   node scripts/syncLosOutputs.mjs
 *   → Flask에서 zip 다운로드 → public/temps/, public/antenna_assets.json 갱신
 *   → 10MB 초과 검사 → 변경 요약 출력 (git add/commit 은 사용자가 확인 후 실행)
 *
 * 사용법:
 *   node scripts/syncLosOutputs.mjs                     # 로컬 Flask(8080)에서
 *   PY_API_URL=https://playground.idcube.sktelecom.com \
 *     node scripts/syncLosOutputs.mjs                   # 사내 서버에서
 *   node scripts/syncLosOutputs.mjs --dry-run           # 받아만 보고 반영 안 함
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PY_API_URL = (process.env.PY_API_URL || 'http://localhost:8080').replace(/\/$/, '');
const PREFIX = '/daily-tmap-data-querying-l';
const DRY = process.argv.includes('--dry-run');
const LIMIT = 10 * 1024 * 1024;

const log = (...a) => console.log(...a);

async function main() {
  const url = `${PY_API_URL}${PREFIX}/los/batch/download`;
  log(`① Flask 산출물 다운로드: ${url}`);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  } catch (e) {
    console.error(`\n✗ Flask 서버(${PY_API_URL})에 연결할 수 없습니다: ${e.message}`);
    console.error('  로컬이면 playground-daily-tmap-data-querying-l 에서 python app.py 를 먼저 실행하세요.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\n✗ 다운로드 실패 (HTTP ${res.status})`);
    process.exit(1);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  log(`   받음: ${(buf.length / 1048576).toFixed(2)}MB`);

  // zip 풀기 — Node 기본 모듈엔 unzip이 없어 시스템 unzip 사용 (macOS/Linux 기본 제공)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'los-sync-'));
  const zipPath = path.join(tmp, 'outputs.zip');
  await fs.writeFile(zipPath, buf);
  try {
    execSync(`unzip -oq "${zipPath}" -d "${tmp}"`, { stdio: 'pipe' });
  } catch (e) {
    console.error(`\n✗ zip 해제 실패: ${e.message}`);
    process.exit(1);
  }

  // ② 10MB 초과 검사 (수동 절차 대체)
  log('\n② gitlab 10MB 제한 검사');
  const large = [];
  const tempsSrc = path.join(tmp, 'temps');
  const files = existsSync(tempsSrc) ? await fs.readdir(tempsSrc) : [];
  for (const f of files) {
    const st = await fs.stat(path.join(tempsSrc, f));
    if (st.size > LIMIT) large.push([f, st.size]);
  }
  const antSrc = path.join(tmp, 'antenna_assets.json');
  if (existsSync(antSrc)) {
    const st = await fs.stat(antSrc);
    if (st.size > LIMIT) large.push(['antenna_assets.json', st.size]);
  }
  if (large.length) {
    log(`   ⚠ ${large.length}개 파일이 10MB를 초과합니다:`);
    large.sort((a, b) => b[1] - a[1])
         .forEach(([f, s]) => log(`     ${f}: ${(s / 1048576).toFixed(2)}MB`));
    log('   → 이 파일들은 gitlab 업로드가 거부될 수 있습니다.');
  } else {
    log('   ✓ 초과 파일 없음');
  }

  if (DRY) {
    log(`\n--dry-run 이므로 반영하지 않았습니다. 받은 파일: ${tmp}`);
    return;
  }

  // ③ public/ 로 반영
  log('\n③ public/ 반영');
  let copied = 0;
  if (files.length) {
    const dest = path.join(PUBLIC, 'temps');
    await fs.mkdir(dest, { recursive: true });
    for (const f of files) {
      await fs.copyFile(path.join(tempsSrc, f), path.join(dest, f));
      copied++;
    }
    log(`   temps/: ${copied}개 파일`);
  }
  if (existsSync(antSrc)) {
    await fs.copyFile(antSrc, path.join(PUBLIC, 'antenna_assets.json'));
    log('   antenna_assets.json 갱신');
  }

  // ④ git 변경 요약
  log('\n④ git 변경 사항');
  try {
    const out = execSync('git status --porcelain public/temps public/antenna_assets.json',
                         { cwd: ROOT, encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(Boolean);
    if (!lines.length) {
      log('   변경 없음 (이미 최신)');
    } else {
      const mod = lines.filter(l => l.startsWith(' M')).length;
      const add = lines.filter(l => l.startsWith('??')).length;
      log(`   수정 ${mod}개 / 신규 ${add}개`);
      log('\n   커밋하려면:');
      log('     git add public/temps public/antenna_assets.json');
      log('     git commit -m "chore: LOS 폴리곤·안테나 데이터 갱신"');
      log('     git push');
    }
  } catch {
    log('   (git 저장소가 아니거나 git 명령 실패)');
  }

  await fs.rm(tmp, { recursive: true, force: true });
  log('\n완료 ✅');
}

main().catch(e => { console.error(e); process.exit(1); });
