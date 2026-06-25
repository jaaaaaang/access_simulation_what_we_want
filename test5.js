import https from 'https';

const url = 'https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=10&query=반포자이&type=place&format=json&key=CEB52025-E065-364C-9DBA-44880E3B02B8&domain=http://localhost:3000';

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Search:', data));
}).on('error', err => console.error(err));
