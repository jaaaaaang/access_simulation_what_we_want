"""주소→위경도 지오코더 어댑터. pipeline.run(geocoder=...)에 콜러블로 주입.

인터페이스: geocoder(addr: str) -> (lat, lon) | None

⚠️ 이 모듈은 네트워크가 필요합니다(HTTP 호출). 코드가 있는 이 sandbox 컨테이너는
네트워크가 비활성화되어 있어 실제 호출 테스트를 못 했습니다 — 반드시 사내/개발
환경에서 실제 키로 1차 검증 후 사용하세요 (VWorldGeocoder(key).test() 제공).
"""
import json
import urllib.request
import urllib.parse
import time


class VWorldGeocoder:
    """국토교통부 VWorld 지오코딩 API (지번/도로명 주소 → 좌표).
    무료 키 발급: https://www.vworld.kr (Open API 신청) — 일 3만건.
    """
    URL = "https://api.vworld.kr/req/address"

    def __init__(self, api_key, addr_type="PARCEL", timeout=5, retries=2, sleep=0.2):
        self.api_key = api_key
        self.addr_type = addr_type  # PARCEL(지번) | ROAD(도로명)
        self.timeout = timeout
        self.retries = retries
        self.sleep = sleep

    def __call__(self, addr):
        params = {
            "service": "address", "request": "getcoord", "version": "2.0",
            "crs": "epsg:4326", "address": addr, "format": "json",
            "type": self.addr_type, "key": self.api_key,
        }
        url = self.URL + "?" + urllib.parse.urlencode(params)
        last_err = None
        for _ in range(self.retries + 1):
            try:
                with urllib.request.urlopen(url, timeout=self.timeout) as r:
                    data = json.loads(r.read().decode("utf-8"))
                res = data.get("response", {})
                if res.get("status") != "OK":
                    return None
                p = res["result"]["point"]
                return (float(p["y"]), float(p["x"]))  # (lat, lon)
            except Exception as e:
                last_err = e
                time.sleep(self.sleep)
        if last_err:
            raise RuntimeError(f"VWorld geocode 실패: {addr!r} ({last_err})")
        return None

    def test(self, sample_addr="서울특별시 종로구 세종로 1"):
        """실 네트워크 환경에서 키가 유효한지 1건으로 확인."""
        r = self(sample_addr)
        if r is None:
            raise RuntimeError("VWorld 응답 없음 — API 키/네트워크 확인 필요")
        print(f"OK: {sample_addr} -> {r}")
        return r


class NominatimGeocoder:
    """OSM Nominatim — 키 불필요, 개발/테스트용. 상용 대량 호출은 이용정책상 부적합
    (요청당 1초 이상 간격, User-Agent 필수). 국내 지번 정확도는 VWorld보다 낮음."""
    URL = "https://nominatim.openstreetmap.org/search"

    def __init__(self, user_agent="rapa-dxf-extract/0.1", country_codes="kr",
                 timeout=5, min_interval=1.1):
        self.ua = user_agent
        self.cc = country_codes
        self.timeout = timeout
        self.min_interval = min_interval
        self._last = 0.0

    def __call__(self, addr):
        wait = self.min_interval - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        params = {"q": addr, "format": "json", "limit": 1, "countrycodes": self.cc}
        url = self.URL + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": self.ua})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
        finally:
            self._last = time.time()
        if not data:
            return None
        return (float(data[0]["lat"]), float(data[0]["lon"]))


class StaticGeocoder:
    """오프라인/사전 확보 GCP용 명시적 어댑터. {주소문자열: (lat,lon)} 또는
    pipeline이 만드는 "{addr_prefix} {지번}" 키와 정확히 일치해야 함.
    이전 버전의 '--gcp-file 안 주면 조용히 미변환' 문제를 대체하는, 실패 시
    명확히 알 수 있는 명시적 오프라인 경로."""
    def __init__(self, mapping):
        self.mapping = mapping

    def __call__(self, addr):
        return self.mapping.get(addr.strip())

    @classmethod
    def from_gcp_file(cls, path, addr_prefix=""):
        """예전 gcp_file 포맷 [[x_mm,y_mm,lat,lon],...]은 주소가 없어 이 방식으론 못 씀.
        신규 포맷 {"지번or주소": [lat,lon], ...} 권장."""
        d = json.load(open(path, encoding="utf-8"))
        return cls({k: tuple(v) for k, v in d.items()})


class VWorldParcelFetcher:
    """VWorld 연속지적도(Data API 2.0, LP_PA_CBND_BUBUN)에서 필지 경계 폴리곤을 가져온다.
    georef.fit_by_shape()에 넣을 ref_ring_latlon 생성용.

    ⚠️ 이 클래스도 실제 HTTP 호출 테스트를 못 했습니다(sandbox 네트워크 차단).
    특히 다음 두 가지는 반드시 실 환경에서 확인 필요:
      1) 응답 좌표계 — crs=EPSG:4326을 요청 파라미터로 넣었지만, 실제로 위경도로
         오는지 도상거리(EPSG:5186, TM 좌표계, 6자리 큰 수)로 오는지 확인 필요.
         큰 수(10만~100만대)로 오면 좌표계 오인식이므로 응답을 신뢰하지 말 것
         (self.SANITY 범위 체크로 자동 감지, 벗어나면 RuntimeError).
      2) PNU 획득 — 아래 by_address()는 VWorld 주소검색 응답에 pnu 필드가
         포함된다는 가정으로 짰습니다. 실제로 없다면 by_pnu()에 직접 PNU를
         넣어 쓰거나, data.go.kr의 '주소기반 PNU 조회' API로 먼저 PNU를 구해야 합니다.
    """
    ADDR_URL = "https://api.vworld.kr/req/address"
    DATA_URL = "https://api.vworld.kr/req/data"

    def __init__(self, api_key, timeout=8):
        self.api_key = api_key
        self.timeout = timeout

    def _sanity_check(self, lat, lon):
        if not (33 <= lat <= 39 and 124 <= lon <= 132):
            raise RuntimeError(
                f"응답 좌표가 대한민국 위경도 범위를 벗어남 (lat={lat}, lon={lon}). "
                "EPSG:5186(TM) 좌표를 위경도로 잘못 해석했을 가능성 — crs 파라미터/"
                "응답 포맷을 실 API 문서와 대조하세요."
            )

    def by_address(self, addr, addr_type="PARCEL"):
        params = {"service": "address", "request": "getAddress", "version": "2.0",
                   "crs": "epsg:4326", "address": addr, "format": "json",
                   "type": addr_type, "key": self.api_key}
        url = self.ADDR_URL + "?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=self.timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        results = data.get("response", {}).get("result", [])
        if not results:
            return None
        pnu = results[0].get("structure", {}).get("level0") or results[0].get("pnu")
        if not pnu:
            raise RuntimeError(
                f"주소 검색 응답에 PNU 필드를 찾지 못함: {results[0]!r} — "
                "geocoders.py의 필드명을 실제 응답 구조에 맞게 수정 필요"
            )
        return self.by_pnu(pnu)

    def by_pnu(self, pnu):
        params = {"service": "data", "request": "GetFeature", "data": "LP_PA_CBND_BUBUN",
                   "key": self.api_key, "attrFilter": f"pnu:=:{pnu}",
                   "crs": "EPSG:4326", "format": "json", "size": 10}
        url = self.DATA_URL + "?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=self.timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        try:
            feats = data["response"]["result"]["featureCollection"]["features"]
        except (KeyError, TypeError):
            raise RuntimeError(f"연속지적도 응답 파싱 실패: {data!r}")
        if not feats:
            return None
        geom = feats[0]["geometry"]
        coords = geom["coordinates"][0]
        if geom["type"] == "MultiPolygon":
            coords = geom["coordinates"][0][0]
        ring = [(pt[1], pt[0]) for pt in coords]  # GeoJSON은 [lon,lat] -> (lat,lon)로 반전
        self._sanity_check(*ring[0])
        return ring
