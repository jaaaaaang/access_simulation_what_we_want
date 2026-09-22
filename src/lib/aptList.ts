// apt_list.csv 로더/파서
// 배경: RAPA(ATOM) 원천 데이터의 로컬 목업. 실제 운영 환경에서는 DB_structure.pdf에 정의된
// p_common.ailayer_apt_5g (Athena) 테이블에서 동일한 컬럼(hdofc_nm/mcp_nm/emd_nm/lat/lng 등)을
// 직접 조회하게 될 예정이며, 이 파일의 파싱 로직은 그 전환 시 fetch 소스만 교체하면 되도록
// "RAPA Key 목록 + 필터용 필드" 형태의 얇은 인터페이스로 감싸둔다.

export type AptListRow = {
  /** RAPA식별코드 (unique key) — ailayer_apt_5g.ina_no 에 해당 */
  rapaKey: string;
  /** 본부 — ailayer_apt_5g.hdofc_nm */
  hq: string;
  /** 시도 — ailayer_apt_5g.mcp_nm */
  sido: string;
  /** 시군구 — ailayer_apt_5g.sgg_nm */
  sigungu: string;
  /** 읍면동(행정동) — ailayer_apt_5g.emd_nm */
  emd: string;
  /** 공사명 */
  projectName: string;
  /** 건물명/도로명 (없으면 공사명으로 대체) */
  buildingName: string;
  /** 주소 */
  address: string;
  /** 관로동 정보 (원문 그대로. "해당없음"/"해당사항없음"이면 관로동 미지정으로 취급) */
  conduitBuilding: string;
  /** 위도 */
  lat: number;
  /** 경도 */
  lng: number;
  /** 세대수 (참고용) */
  households: string;
  /** 그 외 전체 원본 컬럼 (필요 시 확장 참조) */
  raw: Record<string, string>;
};

/** 관로동 컬럼이 "관로 미지정"을 뜻하는 값인지 판정 (apt_list.csv 관측값 기준) */
export function hasConduitBuilding(row: AptListRow): boolean {
  const v = (row.conduitBuilding || '').trim();
  if (!v || v === '-') return false;
  if (v === '해당없음' || v === '해당사항없음') return false;
  return true;
}

/**
 * RFC4180에 가까운 최소 CSV 파서.
 * apt_list.csv는 관로동 컬럼 등에 콤마가 포함된 값을 큰따옴표로 감싸서 저장하므로
 * (예: "101,102,103,105,106,000"), 단순 split(',')로는 컬럼이 밀린다.
 */
function parseCsv(text: string): string[][] {
  // BOM 제거
  const clean = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && clean[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
  }
  // 마지막 줄 처리 (개행 없이 끝나는 경우)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseAptListCsv(text: string): AptListRow[] {
  const table = parseCsv(text);
  if (table.length < 2) return [];
  const header = table[0].map(h => h.trim());
  const idx = (name: string) => header.indexOf(name);

  const iHq = idx('본부');
  const iSido = idx('시도');
  const iSigungu = idx('시군구');
  const iEmd = idx('읍면동');
  const iRapaKey = idx('RAPA식별코드');
  const iProjectName = idx('공사명');
  const iBuildingName = idx('건물명/도로명');
  const iAddress = idx('주소');
  const iConduit = idx('관로동');
  const iLat = idx('위도');
  const iLng = idx('경도');
  const iHouseholds = idx('세대수');

  const rows: AptListRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const cols = table[r];
    if (!cols || cols.length < 2) continue;
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { raw[h] = (cols[i] ?? '').trim(); });

    const rapaKey = (cols[iRapaKey] ?? '').trim();
    const latStr = (cols[iLat] ?? '').trim();
    const lngStr = (cols[iLng] ?? '').trim();
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (!rapaKey || isNaN(lat) || isNaN(lng)) continue; // 위경도/키 없는 행은 시뮬레이션 대상에서 제외

    const buildingNameRaw = (cols[iBuildingName] ?? '').trim();
    const projectName = (cols[iProjectName] ?? '').trim();

    rows.push({
      rapaKey,
      hq: (cols[iHq] ?? '').trim(),
      sido: (cols[iSido] ?? '').trim(),
      sigungu: (cols[iSigungu] ?? '').trim(),
      emd: (cols[iEmd] ?? '').trim(),
      projectName,
      buildingName: (buildingNameRaw && buildingNameRaw !== '-') ? buildingNameRaw : projectName,
      address: (cols[iAddress] ?? '').trim(),
      conduitBuilding: (cols[iConduit] ?? '').trim(),
      lat,
      lng,
      households: (cols[iHouseholds] ?? '').trim(),
      raw,
    });
  }
  return rows;
}

/** public/apt_list.csv 를 fetch하여 파싱 (Vite base path 대응) */
export async function loadAptList(): Promise<AptListRow[]> {
  const base = (import.meta as any).env?.BASE_URL || '/';
  const res = await fetch(`${base}apt_list.csv`);
  if (!res.ok) throw new Error(`apt_list.csv 로드 실패: HTTP ${res.status}`);
  const text = await res.text();
  return parseAptListCsv(text);
}
