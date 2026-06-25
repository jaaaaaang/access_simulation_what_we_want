import fetch from 'node-fetch';

async function testLayer(layer) {
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=${layer}&key=CEB52025-E065-364C-9DBA-44880E3B02B8&format=json&crs=EPSG:4326&size=1&geomFilter=BOX(127.00,37.50,127.01,37.51)&domain=http://localhost:3000`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Referer': 'http://localhost:3000/',
        'Origin': 'http://localhost:3000'
      }
    });
    const text = await res.text();
    console.log(layer, res.status, text.substring(0, 300));
  } catch (e) {
    console.log(layer, e.message);
  }
}

testLayer('LT_C_BULD_INFO');
testLayer('LT_C_SPBD_BULD');
testLayer('LT_C_AIS0401');
testLayer('LT_C_UPISBULD');
testLayer('LT_C_BUILDING_INFO');
