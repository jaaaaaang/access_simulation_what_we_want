import https from 'https';
const url = 'https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_BULD_INFO&key=CEB52025-E065-364C-9DBA-44880E3B02B8&format=json&crs=EPSG:4326&size=10&geomFilter=BOX(127.0,37.0,127.1,37.1)&domain=http://localhost:3000';
https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('LT_C_BULD_INFO:', data.substring(0, 300)));
});
const url2 = 'https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_SPBD_BULD&key=CEB52025-E065-364C-9DBA-44880E3B02B8&format=json&crs=EPSG:4326&size=10&geomFilter=BOX(127.0,37.0,127.1,37.1)&domain=http://localhost:3000';
https.get(url2, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('LT_C_SPBD_BULD:', data.substring(0, 300)));
});
