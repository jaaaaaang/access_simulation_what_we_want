import fetch from 'node-fetch';

async function getCapabilities() {
  const url = `http://api.vworld.kr/req/wfs?key=CEB52025-E065-364C-9DBA-44880E3B02B8&domain=http://localhost:3000&SERVICE=WFS&REQUEST=GetCapabilities&VERSION=1.1.0`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    const text = await res.text();
    console.log(text.substring(0, 500));
    // extract all Name tags
    const names = [...text.matchAll(/<Name>(.*?)<\/Name>/g)].map(m => m[1]);
    console.log(names.filter(n => n.includes('BULD') || n.includes('SPBD') || n.includes('AIS')).join(', '));
  } catch (e) {
    console.log(e.message);
  }
}

getCapabilities();
