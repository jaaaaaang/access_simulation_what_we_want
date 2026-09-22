import argparse, json, sys
from .pipeline import run
from .output import leaflet_html

def main():
    ap = argparse.ArgumentParser(description='RAPA DXF -> m-RAPA JSON')
    ap.add_argument('dxf')
    ap.add_argument('--key', default='')
    ap.add_argument('--name', default='')
    ap.add_argument('--addr-prefix', default='', help='지오코딩용 주소 접두 (예: "대구 동구 신암동")')
    ap.add_argument('--geocoder', choices=['vworld', 'nominatim'], default=None,
                     help='실시간 지오코딩 사용 (네트워크 필요)')
    ap.add_argument('--vworld-key', default=None, help='--geocoder vworld 사용 시 필수')
    ap.add_argument('--gcp-file', default=None,
                     help='사전 확보 GCP. {"주소":[lat,lon],...} 또는 구포맷 [[x_mm,y_mm,lat,lon],...]')
    ap.add_argument('--parcel-shape-match', action='store_true',
                     help='지번 라벨이 도면에 없을 때: 단지경계 폴리곤을 VWorld 연속지적도와 형태 대조')
    ap.add_argument('--parcel-address', default=None,
                     help='--parcel-shape-match 사용 시 필지 주소 (예: "서울 서초구 잠원동 65-33")')
    ap.add_argument('--allow-local-coords', action='store_true',
                     help='지오레퍼런싱 없이도 강제 실행(디버그용, WGS84 아님을 결과에 명시)')
    ap.add_argument('--floors-below', type=int, default=None)
    ap.add_argument('-o', '--out', default='out.json')
    ap.add_argument('--html', default=None)
    a = ap.parse_args()

    geocoder = None
    if a.geocoder == 'vworld':
        if not a.vworld_key:
            sys.exit('--geocoder vworld 사용 시 --vworld-key 필수')
        from .geocoders import VWorldGeocoder
        geocoder = VWorldGeocoder(a.vworld_key)
    elif a.geocoder == 'nominatim':
        from .geocoders import NominatimGeocoder
        geocoder = NominatimGeocoder()

    parcel_fetcher = None
    if a.parcel_shape_match:
        if not (a.vworld_key and a.parcel_address):
            sys.exit('--parcel-shape-match 사용 시 --vworld-key와 --parcel-address 모두 필요')
        from .geocoders import VWorldParcelFetcher
        parcel_fetcher = VWorldParcelFetcher(a.vworld_key)

    if not (geocoder or a.gcp_file or parcel_fetcher or a.allow_local_coords):
        sys.exit('지오레퍼런싱 소스가 없습니다: --geocoder vworld/nominatim, --gcp-file, '
                 '--parcel-shape-match(+--parcel-address), 또는 (디버그용) --allow-local-coords 중 하나 필요')

    res = run(a.dxf, rapa_key=a.key, complex_name=a.name, geocoder=geocoder,
              gcp_file=a.gcp_file, parcel_fetcher=parcel_fetcher, parcel_address=a.parcel_address,
              addr_prefix=a.addr_prefix,
              floors_below=a.floors_below, allow_local_coords=a.allow_local_coords)
    json.dump(res, open(a.out, 'w'), ensure_ascii=False, indent=1)
    print('saved', a.out)
    if a.html:
        open(a.html, 'w').write(leaflet_html(res, a.key or a.name or 'overlay'))
        print('saved', a.html)

if __name__ == '__main__':
    main()
