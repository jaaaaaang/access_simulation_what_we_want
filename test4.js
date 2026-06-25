import http from 'http';

const url = 'http://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_BULD_INFO&key=CEB52025-E065-364C-9DBA-44880E3B02B8&format=json&crs=EPSG:4326&size=10&geomFilter=BOX(127.05,37.50,127.06,37.51)&domain=http://localhost:3000';

http.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('HTTP:', data));
}).on('error', err => console.error(err));
