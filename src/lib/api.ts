/**
 * API 호출 시 Vite의 BASE_URL(/eng-apt-cover-windows/)을 자동으로 반영하는 헬퍼 함수
 */
export function getApiUrl(path: string): string {
  const base = (import.meta as any).env?.BASE_URL || '/';
  const cleanBase = base.replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}
