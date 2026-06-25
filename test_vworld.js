import https from 'https';

const key = 'CEB52025-E065-364C-9DBA-44880E3B02B8';
const layers = ['LT_C_BULD_INFO', 'LT_C_SPBD_BULD', 'LT_C_AIS0401', 'LT_C_UPISBULD'];
const bbox = '127.05,37.50,127.06,37.51';

for (const layer of layers) {
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=${layer}&key=${key}&format=json&crs=EPSG:4326&size=10&geomFilter=BOX(${bbox})&domain=http://localhost:3000`;
  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => console.log(layer, ':', data.substring(0, 300)));
  }).on('error', err => console.error(layer, err.message));
}
