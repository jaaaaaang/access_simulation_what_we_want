import https from 'https';

const url = 'https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_BULD_INFO&key=CEB52025-E065-364C-9DBA-44880E3B02B8&format=json&crs=EPSG:4326&size=10&geomFilter=BOX(127.0,37.0,127.1,37.1)&domain=http://localhost:3000&callback=myCallback';

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Body:', data.substring(0, 500));
  });
}).on('error', err => console.error(err));
