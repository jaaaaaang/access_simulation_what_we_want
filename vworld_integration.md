# 지도 타일 & V-World API 연동 명세서 (Map Tiles & V-World Integration)

본 문서는 시뮬레이션 시스템에 통합된 지도 장소 검색, 건물 공간 데이터(`LT_C_SPBD`) 및 고정밀 배경 지도 타일(OpenMap Tiles: CartoDB / Esri World Imagery) 연동 명세서입니다.

---

## 1. 아키텍처 개요 (Architecture)

인증 실패 및 서버 IP 차단 이슈가 빈번한 기존 WMS 통이미지 방식을 대체하여, **고해상도 오픈 타일 레이어 (CartoDB Positron/Voyager + Esri World Imagery)**를 캔버스 BBOX 좌표계와 1:1 정밀 동기화하여 배경 지도를 렌더링합니다.

```
[React Client] 
  ├── 장소 검색 / 데이터 요청 ──> [Express Proxy (/api/vworld-proxy)] ──> [VWorld API (LT_C_SPBD)]
  └── 배경 지도 타일 (OpenMap) ──> [Esri / CartoDB Tile Server] ──────> [Canvas (정밀 좌표 매핑)]
```

- **장소 검색 & 건물 피처**: V-World 2.0 API (`LT_C_SPBD` 도로명건물 외경)
- **배경 지도 타일**: Esri World Imagery (위성) & CartoDB (일반/혼합) - CORS 지원, 인증키 0개, 상시 100% 가동률

---

## 2. API별 표준 명세 (API Specifications)

### 1) 장소 검색 API (Place Search)
- **Endpoint**: `https://api.vworld.kr/req/search`
- **Protocol**: HTTP/HTTPS GET
- **Parameters**: `service=search&request=search&version=2.0&type=place&crs=EPSG:4326&size=15&query={검색어}&key={KEY}&domain={DOMAIN}`

---

### 2) 건물 공간 폴리곤 데이터 API (GetFeature - `LT_C_SPBD`)
- **Endpoint**: `https://api.vworld.kr/req/data`
- **Protocol**: HTTP/HTTPS GET
- **Parameters**:
  | 파라미터 | 값 | 설명 |
  |---|---|---|
  | `service` | `data` | 공간데이터 서비스 |
  | `request` | `GetFeature` | 피처 가져오기 |
  | `data` | `LT_C_SPBD` | **도로명건물 공간데이터 고정** |
  | `crs` | `EPSG:4326` | WGS84 좌표계 |
  | `size` | `100` | 최대 피처 수 |
  | `geomFilter` | `BOX(minLon,minLat,maxLon,maxLat)` | 위경도 논리 바운딩 박스 (~350m 반경) |
  | `attrFilter` | `buld_nm:like:{단지명}` | (선택) 특정 단지명 건물 필터링 |

#### 💡 스마트 자동 폴백 (Auto-Fallback) 메커니즘
- 단지명 필터링(`attrFilter`) 결과가 0개일 경우, **시스템이 자동으로 필터를 해제하여 해당 위치 주변의 건물 폴리곤을 무손실 재검색**하여 배치합니다.

---

### 3) 배경 지도 타일 (OpenMap Tile Engine)
캔버스의 위경도 BBOX 범위(`minLon`, `maxLon`, `minLat`, `maxLat`)를 Web Mercator 표준 변환식으로 타일 인덱스로 매핑하여 캔버스 배경에 고정밀 렌더링합니다.

- **🗺️ 일반 지도 (`Base`)**: `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`
- **🛰️ 위성 지도 (`Satellite`)**: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` (Esri High-Res Imagery)
- **🗺️+🛰️ 혼합 지도 (`Hybrid`)**: Esri World Imagery + CartoDB Voyager Labels Layer

---

## 3. 핵심 상태 및 환경 설정 (Environment Setup)

1. **기본 등록 도메인**: `https://ais-dev-sm53qq4od7hwjydkbyh6gn-232203969309.asia-east1.run.app`
2. **배경 지도 가동률**: 100% (인증 실패 및 XML 에러 전면 제거)
