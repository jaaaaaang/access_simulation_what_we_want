# rapa_dxf_extract

RAPA 이동통신 구내중계설비 도면(DXF) → 단지/건물 폴리곤 + 층수 + 안테나/관로동 분류 + WGS84 지오레퍼런싱 → m-RAPA JSON.

> **v6 = v5(로직 정정) ∪ v4(auto 자동처리)** — v5의 관로동 정의 정정·인셋 심볼 15m 필터를
> 유지하면서, v5에서 빠져 있던 v4의 `auto.py`(유형 자동판정 + `--outdir` 배치처리),
> LWPOLYLINE 지원, 인코딩 자동판정, `\M+3XXXX` 다바이트 이스케이프 복원을 모두 되살렸습니다.
> v5의 `dxf_io.decode_dxf_unicode()`는 상위집합인 `decode_acad_text()`의 alias로 유지됩니다.

## 빠른 시작 — 유형은 코드가 판정한다

도면이 어떤 유형인지 사용자가 미리 알 필요 없다. 파일만 넘기면 코드가 판정하고
그에 맞는 처리를 자동으로 고른다.

```bash
# 0) 유형만 먼저 보고 싶을 때 (아무것도 안 만든다)
python -m rapa_dxf_extract.auto 도면.dxf --dry-run

# 1) 그냥 돌린다 — 유형에 맞춰 알아서 처리
python -m rapa_dxf_extract.auto 도면.dxf --vworld-key KEY

# 2) 폴더 전체 배치 처리
python -m rapa_dxf_extract.auto *.dxf --outdir out --vworld-key KEY --report report.json
```

부족한 게 있으면 **무엇을 주면 되는지 한 줄로 알려준다**:
```
■ m-RAPA-2405-1502.dxf  →  유형 B  (지번 없음, 배치도 있음 → 지적경계 형태매칭)
   엔티티 282,917 · 인코딩 utf-8 · 동 24개 · 지번 0개
   → 형태매칭에 --vworld-key 와 --parcel-address "시 구 동 000-0" 이(가) 필요합니다.
```

### 코드가 판정하는 유형

| 유형 | 판정 근거 (자동) | 처리 |
|---|---|---|
| **A** | 옥외배치도 + 동라벨 + 지번 라벨 >=3 | 점 GCP 지오코딩 — `--vworld-key`만 주면 끝 |
| **B** | 옥외배치도 + 동라벨, 지번 0 | 지적경계 형태매칭 — `--vworld-key` + `--parcel-address` |
| **XREF** | 배치도 없음 + 미해결 외부참조 | 처리 불가 → AutoCAD에서 XREF bind 후 재출력 |
| **C** | 옥외배치도 시트 자체가 없음 | 처리 불가 → 표준 도곽 확인 필요 |

`--allow-local`을 붙이면 지오레퍼런싱 없이 형상만 뽑는다(WGS84 아님, 지도 오버레이 금지).
`--dry-run`은 판정만 하고 아무 파일도 만들지 않는다.

## DXF 버전 / 엔티티 호환

같은 DWG라도 **어떤 프로그램으로 DXF를 뽑았느냐에 따라 엔티티 표현이 달라진다.**
파서는 두 계열을 모두 지원한다.

| | R12 (AC1003) | 2000~2018 (AC1015~AC1032) |
|---|---|---|
| 폴리라인 | `POLYLINE` + `VERTEX` (정점마다 별도 엔티티) | `LWPOLYLINE` (코드 10/20 반복) |
| 곡선 | 전부 폴리라인으로 분해 | `SPLINE` / `ELLIPSE` 유지 |
| 인코딩 | 보통 cp949 | 보통 utf-8 |

`dxf_io.parse()`가 `LWPOLYLINE`을 읽어 **기존 `POLYLINE`과 동일한 스키마(`verts`/`closed`)로
정규화**하므로 `footprints`/`georef` 등 하위 모듈은 수정 없이 그대로 동작한다.

실측(같은 DWG를 두 프로그램으로 변환):

| | `2202.dxf` (R12) | `2202-0846.dxf` (2018) |
|---|---|---|
| 크기 | 46MB | 27MB |
| 원본 엔티티 | POLYLINE 16,686 + VERTEX 338,281 | LWPOLYLINE 7,185 + SPLINE 8,924 |
| 단지경계 (수정 전) | 89꼭짓점 21,410㎡ | ✗ 57꼭짓점 11,294㎡ (오탐, 중심 134m 오차) |
| 단지경계 (수정 후) | 89꼭짓점 21,410㎡ | **89꼭짓점 21,410㎡ (동일)** |

수정 후 두 파일의 최종 JSON은 **동 중심좌표 차이 0.00m로 완전 일치**한다
(층수 10개동 전항목 일치, RMS 4.15m, confidence high).

아직 파서가 무시하는 엔티티: `SPLINE`, `HATCH`, `ELLIPSE`. 지금까지 확인된 도면에서는
단지경계·건물외곽이 전부 폴리라인이라 문제되지 않았으나, 곡선 외곽 도면이 들어오면
추가가 필요하다.

## DWG → DXF 변환은 이 파이프라인 밖이다 (그러나 버전 선택이 결과를 좌우한다)

`rapa_dxf_extract`의 범위는 **DXF 확보 이후**다. DWG→DXF 변환은 ODA File Converter로
수동 처리하고, 그 결과 DXF를 파이프라인에 넣는다. 변환기를 코드에 넣지 않는 이유:
파서가 외부 의존성 없는 순수 파이썬이어야 폐쇄망에 그대로 들어가고,
`ezdxf.addons.odafc`는 외부 바이너리에 의존하는 데다 **macOS에서는 ODA FC의 GUI를
억제하는 방법이 알려져 있지 않아** 배치 자동화가 깨진다(Linux는 xvfb 필요).

**대신 Output version을 반드시 `ACAD12`(R12)로 놓을 것.** R12 스펙에는 SPLINE/ELLIPSE/
LWPOLYLINE 엔티티가 아예 없어서 변환기가 곡선을 **전부 POLYLINE으로 테셀레이션**한다 —
즉 파서가 못 읽는 엔티티를 변환 단계가 미리 펴준다. 2018로 뽑으면 그 곡선이 그대로
SPLINE으로 들어오고 파서는 조용히 버린다.

같은 DWG(`2202-0846.dwg`, AC1024)를 두 버전으로 뽑은 실측:

| Output version | POLYLINE | 무시되는 곡선 |
|---|---|---|
| ACAD2018 (AC1032) | 143 + LWPOLYLINE 7,185 | **SPLINE 8,924 · ELLIPSE 412** (RAPA_ARCH 9,095) |
| ACAD12 (AC1009) | 16,686 | 없음 |

2202 도면은 건물 외곽이 전부 직선이라 두 버전 결과가 같았지만(89꼭짓점 21410㎡ 동일),
곡선 외곽 도면에서는 조용히 틀린다. `m-RAPA-2405-1502.dxf`(AC1032)도 4,061개를 버린다.

### 잘못된 버전이면 파이프라인이 알려준다

`dxf_io.parse(path, stats=...)`가 무시한 엔티티를 타입·레이어별로 집계하고,
`dxf_io.lossy_report()`가 경고 문장을 만든다. `run()`의 `[1/7]` 단계와 `auto --dry-run`이
이걸 출력한다:

```
[1/7] parse: model=3954 blocks=372 (AC1032/utf-8)
  ⚠ 외곽선 유실 위험 — 무시된 곡선 엔티티 9,347개: SPLINE 8,924, ELLIPSE 412, ...
     레이어: RAPA_ARCH(9,095), RAPA_SYM(194), 0(58)
     → ODA File Converter에서 Output version을 ACAD12(R12)로 놓고 다시 뽑으세요.
```

유실은 **두 등급**으로 나눈다. 섞으면 경고가 매번 떠서 아무도 안 본다:
- `SHAPE_LOSS` (SPLINE/ELLIPSE/REGION/BODY/3DSOLID/프록시) — 외곽선 자체가 사라진다.
  **이때만 ⚠ 경고와 재변환 권고를 낸다.** R12 변환본에서는 0개라 조용하다.
- `MINOR_LOSS` (HATCH/SOLID/3DFACE/MTEXT/LEADER 등) — 채움·보조 도형. 외곽선은 대개
  별도 폴리라인으로도 그려져 있어 결과를 안 바꾸고, R12 변환본에도 항상 남는다
  (HATCH가 SOLID로 바뀌어 들어옴). `lossy_report(stats, verbose=True)`로만 조회.

## 한글 인코딩 (중요)

DXF의 한글은 세 형태로 섞여 나온다:
- 파일 인코딩: **cp949 또는 utf-8** (도면마다 다름 → `dxf_io.detect_encoding()`이 자동 판정)
- AutoCAD 다바이트 이스케이프: `\M+3XXXX` (cp949 바이트쌍)
- 유니코드 이스케이프: `\U+XXXX`

복원하지 않으면 지번·동·시트타이틀 정규식이 **전부 빗나가면서 "라벨 0개"로 조용히
오판한다**(에러가 안 난다). 그래서 `dxf_io.parse()`가 파서 단계에서 전부 정규화한다 —
이후 모듈은 신경 쓸 필요 없다.

실측: `m-RAPA-2202-0827.dxf` 6,714개 / `m-RAPA-2405-1502.dxf` 5,788개의 `\M+` 이스케이프.
복원 전에는 2405가 "배치도 없음"으로 오판됐고, 복원 후 `이동통신 구내중계설비 옥외배치도`가
잡히며 동 24개가 정상 검출됐다. 참고로 `2202.dxf`(검증 기준선)는 cp949,
`m-RAPA-*.dxf`(신규 반입분)는 utf-8이라 인코딩 고정은 불가능하다.


## ⚠️ 정정 사항 (이 버전에서 수정됨)
이전 버전은 지오코딩 소스(geocoder/gcp_file)를 안 주면 **에러 없이** DXF 원본 mm 좌표를
위경도인 것처럼 그대로 반환하는 결함이 있었습니다 (회전·축척 변환 미적용).
이 버전은 **지오레퍼런싱 소스가 없으면 기본적으로 RuntimeError로 중단**합니다.
디버그 목적으로 원본 좌표라도 보고 싶다면 `allow_local_coords=True`를 명시적으로
지정해야 하며, 이 경우 결과 JSON의 `georeference.method`가 `"NONE — ungeoreferenced"`로
표시됩니다. **이 표시가 없는 결과만 지도에 올리세요.**

## 의존성
- Python 3.10+, numpy, opencv-python (`cv2`)
- ezdxf **불필요** (순수 파이썬 스트리밍 파서 내장, AC1003+ ASCII DXF)
- 실시간 지오코딩 사용 시 네트워크 필요 (VWorld/Nominatim HTTP 호출)
- DWG 입력 시: ODA File Converter로 사전 변환 (무료, CLI 배치 가능)

## 지오레퍼런싱 소스 (셋 중 하나 필수)

세 가지 방법이 있고, 도면에 뭐가 있느냐에 따라 고른다:

| 도면 상태 | 방법 |
|---|---|
| 지번(필지번호) 라벨이 도면에 있음 | `geocoder` — 지번 텍스트를 하나씩 지오코딩해 점(GCP) 여러 개로 맞춤 |
| 지번 라벨이 전혀 없음, 단지/구역경계선만 있음 | `parcel_fetcher` — **주소 하나**로 실제 지적경계 폴리곤을 가져와 도면 경계선과 "형태"를 통째로 대조 (점 대응 불필요) |
| 둘 다 없음 | `allow_local_coords=True` (디버그용, WGS84 아님) |


### (지번 라벨 없는 도면) 형태매칭 — parcel_fetcher + parcel_address
지번 텍스트가 도면에 하나도 없어도, RAPA 도면은 거의 항상 단지/구역 경계선을
그린다. 이 경계 폴리곤 '형태'를 실제 지적 폴리곤(VWorld 연속지적도)과
회전각을 스캔하며 대조해 회전+위치를 동시에 구한다. 필요한 건 주소 하나뿐.

```python
from rapa_dxf_extract import run
from rapa_dxf_extract.geocoders import VWorldParcelFetcher

fetcher = VWorldParcelFetcher(api_key="발급받은키")
result = run("3075.dxf", rapa_key="m-RAPA-3075", complex_name="신반포22차 재건축",
             parcel_fetcher=fetcher, parcel_address="서울 서초구 잠원동 65-33",
             floors_below=3)
```
`georeference.shape_coverage_ratio`(1에 가까울수록 좋음)와 `gcp_rms_m`(형태 잔차,
작을수록 좋음)으로 적합 품질을 확인할 수 있다. 알고리즘 자체는 합성 데이터와
2202.dxf 실제 단지경계(89 꼭짓점)로 기존 지번GCP 방식과 교차검증해 일치를
확인했다(오차 0.001°) — 단 `VWorldParcelFetcher`의 실제 HTTP 응답 파싱(특히
좌표계가 정말 EPSG:4326으로 오는지, PNU 필드명)은 네트워크 차단 환경이라
테스트 못 했다. 처음 사용 시 결과 좌표가 한국 범위(위도33-39, 경도124-132)를
벗어나면 즉시 RuntimeError로 멈추게 해뒀다(좌표계 오인식 방지).

단지가 여러 필지 합필인 경우(예: "225-4 외 136필지") 단일 PNU로는 전체 경계를
못 얻으므로 이 방법은 부정확하다 — 그런 경우 지번 GCP(위 geocoder 방식)를 쓴다.

### (권장) 실시간 지오코딩 — geocoder 콜백
```python
from rapa_dxf_extract import run
from rapa_dxf_extract.geocoders import VWorldGeocoder  # 국토부 VWorld, 무료키, 일 3만건

geocoder = VWorldGeocoder(api_key="발급받은키")
geocoder.test()  # 실 네트워크 환경에서 1건으로 키 유효성 먼저 확인 권장

result = run("2202.dxf", rapa_key="m-RAPA-2202-0846",
             complex_name="대구 신암동 삼정그린코아 더베스트",
             geocoder=geocoder, addr_prefix="대구 동구 신암동", floors_below=4)
```
도면 내 지적 라벨(지번)을 자동 추출해 `{addr_prefix} {지번}` 형태로 geocoder를 호출합니다.
**사내 배포 시 VWorld 대신 Kakao/자체 지오코딩 API를 쓰려면 geocoders.py의
`VWorldGeocoder`와 동일한 시그니처(`__call__(addr)->(lat,lon)|None`)로 어댑터만 새로 작성**하면 됩니다.

Nominatim(OSM, 키 불필요)은 개발/테스트용으로만 사용:
```python
from rapa_dxf_extract.geocoders import NominatimGeocoder
result = run(..., geocoder=NominatimGeocoder(), addr_prefix="대구 동구 신암동")
```

### 사전 확보 GCP — gcp_file
지오코딩을 미리 해뒀거나 오프라인 환경이면:
```python
result = run("2202.dxf", gcp_file="gcp.json", addr_prefix="대구 동구 신암동", floors_below=4)
```
`gcp.json` 포맷 (권장, `example_gcp_addr_2202.json` 참고):
```json
{"대구 동구 신암동 226-17": [35.8806018, 128.6223678], ...}
```
구 포맷(좌표쌍 직접 지정, `example_gcp_2202.json` 참고)도 하위호환:
```json
[[3115311, 62846, 35.8806018, 128.6223678], ...]
```

### (디버그 전용) allow_local_coords=True
지오레퍼런싱 없이 폴리곤 형상만 빠르게 보고 싶을 때. **결과는 WGS84가 아니며
지도에 올리면 안 됩니다.** 결과 JSON에 경고가 명시됩니다.

## CLI
```bash
# VWorld 실시간 지오코딩
python -m rapa_dxf_extract.cli 2202.dxf --key m-RAPA-2202-0846 \
  --geocoder vworld --vworld-key YOUR_KEY --addr-prefix "대구 동구 신암동" \
  --floors-below 4 -o out.json --html qa.html

# 사전 확보 GCP
python -m rapa_dxf_extract.cli 2202.dxf --gcp-file example_gcp_addr_2202.json \
  --addr-prefix "대구 동구 신암동" --floors-below 4 -o out.json
```

## v3: 지오레퍼런싱은 상호검증(앙상블), 우선순위 폴백 아님

geocoder/gcp_file(점GCP), parcel_fetcher(형태매칭), north_anchor_latlon(방위표)을
"먼저 있는 거 하나 골라 쓰기"가 아니라 **가용한 걸 전부 계산해서 회전각이
서로 맞는지 대조**한다(georef.resolve_georeference). 방위표는 위치를 못 주지만
회전은 항상 계산해서 다른 방법의 회전과 5° 이내로 맞는지 검증용으로 쓴다.

- 2개 이상 방법이 계산되고 서로 5° 이내로 일치 → `confidence: high`
- 1개 방법만 계산됨 → `confidence: medium` (교차검증 불가, 검수 권장)
- 방법들이 서로 5° 넘게 어긋남 → 로그에 경고 출력, `confidence: low`,
  `georeference.rotation_agreement`에 어느 쌍이 얼마나 다른지 기록

출력 JSON의 `georeference.confidence`/`n_methods_agreeing`/`rotation_agreement`로
확인 가능. 여러 신호를 동시에 넘기려면:
```python
run(..., geocoder=my_geocoder, addr_prefix="...",     # 점GCP도 계산
         parcel_fetcher=fetcher, parcel_address="...", # 형태매칭도 계산
         north_anchor_latlon=(lat,lon))                # 방위표 교차검증용 앵커
```

## 파이프라인 (7단계)
parse → flatten(INSERT 전개) → 옥외배치도 시트 탐지 → footprint 추출(소스블록 자동 스코어링+래스터) → 층수/심볼 매핑 → 지적 GCP Helmert 적합(축척 1e-3 고정, 방위표 교차검증, 5° 이상 벗어나면 경고) → m-RAPA JSON.

## 검증 기준선
m-RAPA-2202-0846 (10개동), example_gcp_addr_2202.json 사용:
층수/안테나/관로동 전 항목 일치, GCP RMS 4.2m(7점)/4.0m(8점), 회전각 방위표와 0.12~0.34° 이내 일치, 처리시간 ~20초.
회귀 테스트 재현:
```bash
python -m rapa_dxf_extract.cli /path/to/2202.dxf \
  --gcp-file example_gcp_addr_2202.json --addr-prefix "대구 동구 신암동" \
  --floors-below 4 -o /tmp/test.json
# 기대값: 101:19F 102:21F 103:22F 104:23F 105:23F 106:23F 107:21F 108:20F 109:10F 201:13F
```

## 관로동(is_duct_building) 정의 정정 — 중요

**이전 버전은 틀렸습니다.** "화단형(파란점) 심볼이 있는 동"만 관로동으로 판정했는데,
관로동의 실제 의미는 "장비가 설치될 수 있도록 관로가 깔린 동"입니다. 옥상형이든
화단형이든 실제 설치 마커가 확인된 동은 급전선/광케이블이 관로를 통해 인입되므로
**전부 관로동**입니다. 지금은 `duct_marker_count + rooftop_repeater_count > 0`이면
`is_duct_building=True`로 판정하고, `equipment_install_method`(rooftop/flowerbed/
rooftop+flowerbed)로 어떤 방식인지는 별도로 남깁니다.
검증 케이스(m-RAPA-2202-0846, 2202.dxf/2202-0846.dxf 둘 다 동일): 관로동 6개
(101,102,103,105,106,107동), 옥상형 방식 6개 동/화단형 방식 0개 동.

## 이번에 고친 버그 (2202-0846.dxf 검증 중 발견)

1. **구버전 DXF(R12/AC1009 등)의 `\U+XXXX` 유니코드 이스케이프 미해독** — 일부
   내보내기 도구는 한글을 `232-17\U+B300`(="232-17대") 형태로 저장한다. 이걸
   못 읽으면 지번/동라벨/시트타이틀 텍스트 정규식이 전부 조용히 실패한다
   (에러 없이 그냥 0건). `dxf_io.decode_dxf_unicode()`로 해결, 최신 cp949
   직접 인코딩 파일에는 영향 없음(패턴 없으면 그대로 통과).
2. **인셋(설치예시도 등) 심볼이 가장 가까운 실제 동에 잘못 배정됨** — 심볼→동
   배정 시 "포함하는 동이 없으면 최근접 동에 무조건 배정"하던 로직이, 상단
   "[이동통신인입 예시]"/"...설치예시도_FO TYPE" 같은 축척 없는(SCALE:NONE)
   설명용 도해 안의 아이콘까지 실배치로 오인해 엉뚱한 동에 붙이는 문제가 있었다.
   실배치 심볼은 대상 동에서 2~6m 이내인 반면 인셋 아이콘은 28~49m 이상 떨어져
   있어(m-RAPA-2202-0846 실측), 15m 임계값으로 명확히 분리 — 넘으면 배정하지
   않고 로그로 알린다.

## 알려진 미해결 이슈
- **3075.dxf 유형(동별로 블록이 나뉘고 날개별 조각 폴리곤으로 구성된 도면)의 footprint 자동추출은 아직 일반화 안 됨** — 지금 자동탐지는 조경 블록을 잘못 고른다(101동 183㎡·102동 7278㎡로 틀림). 수동 조사로는 동딱지-101/102 블록의 전체 선분을 팽창+floodfill해서 바로잡음(101동 767㎡·102동 516㎡, 안정 수렴 확인). 이 로직을 extract_polygons()의 자동 폴백으로 넣는 작업이 남음.

## 검증되지 않은 부분 (사용 전 확인 필요)
- **VWorldGeocoder/NominatimGeocoder는 실제 HTTP 호출 테스트를 못 했습니다** — 이 코드가 만들어진
  환경이 네트워크 차단 sandbox라서 인터페이스/파싱 로직만 작성했고 라이브 검증은 안 됨.
  **처음 사용 시 `geocoder.test()`로 반드시 1건 확인**하고, 실패하면 VWorld API 문서
  (https://www.vworld.kr) 의 getcoord 응답 포맷과 `geocoders.py`를 대조하세요.
- 관로동(파란 점) 분류 로직: 파란 점이 실제 배치된 도면으로 양성 테스트 안 됨(이번 도면은 0건)
- RAPA 표준 도면 규약(레이어명, 도곽 타이틀, 심볼 블록명) 의존 — 타 도면 회귀 테스트 없음
- height는 층수×2.9m 추정치
