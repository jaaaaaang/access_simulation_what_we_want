import path from 'path';
import fs from 'fs/promises';

/**
 * RAPA Key 문자열 검증 (Path Traversal 및 특수문자 차단)
 */
export function validateRapaKey(rapaKey: string): string {
  const key = (rapaKey || '').trim();
  if (!key || key.length > 120) {
    throw new Error(`유효하지 않은 rapaKey입니다: 길이 초과 또는 빈 문자열 (길이: ${key.length})`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(key) || key.includes('..')) {
    throw new Error(`유효하지 않은 rapaKey 문자열입니다 (허용: 영숫자, '.', '_', '-'): ${key}`);
  }
  return key;
}

/**
 * 안전한 파일 경로 계산 (디렉토리 탈출 방지)
 */
export function safeFilePath(baseDir: string, rapaKey: string, ext = '.json'): string {
  const validKey = validateRapaKey(rapaKey);
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, `${validKey}${ext}`);
  if (path.dirname(target) !== resolvedBase) {
    throw new Error(`경로 탐색(Path Traversal) 공격이 감지되었습니다: ${rapaKey}`);
  }
  return target;
}

/**
 * 원자적 JSON 파일 쓰기 (tmp 파일 생성 후 rename)
 * - 쓰기 도중 프로세스가 강제 종료(SIGTERM 등)되어도 corrupt된 JSON이 남지 않음.
 */
export async function atomicWriteJson(filePath: string, data: any): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomSuffix}`;

  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // 실패 시 tmp 파일 청소 시도
    try { await fs.unlink(tmpPath); } catch { }
    throw err;
  }
}
