# Flask VWorld 프록시 (사내 배포용) — 단지 위치 자동 보정

사내 배포는 React가 nginx 정적 서빙이라 `server.ts`의 `/api/vworld-proxy`가 없다.
시뮬레이터의 **'단지 위치 보정 → 자동 보정'**은 로컬(server.ts)을 먼저 찾고, 없으면
Flask(`/daily-tmap-data-querying-l/vworld/proxy`)를 쓴다 (`src/App.tsx` detectVworldProxy).

## 1. Flask 리포(playground-daily-tmap-data-querying-l)에 추가

```python
# vworld_proxy.py
import os
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

import requests
from flask import Blueprint, Response, jsonify, request

bp = Blueprint("vworld", __name__)
ALLOWED_HOST = "api.vworld.kr"


def _key():
    return (os.environ.get("VWORLD_API_KEY") or "").strip()


def _domain():
    return (os.environ.get("VWORLD_API_DOMAIN") or "").strip()


@bp.get("/vworld/status")
def vworld_status():
    # 키 값은 반환하지 않는다
    return jsonify(serverKey=bool(_key()), domain=_domain() or None)


@bp.get("/vworld/proxy")
def vworld_proxy():
    raw = (request.args.get("url") or "").strip()
    u = urlparse(raw)
    if u.scheme not in ("http", "https") or u.hostname != ALLOWED_HOST:
        return jsonify(error="Only api.vworld.kr is supported."), 400
    q = dict(parse_qsl(u.query, keep_blank_values=True))
    if _key() and q.get("key", "") in ("", "__SERVER__"):
        q["key"] = _key()                      # 서버 보관 키 주입
        if _domain():
            q["domain"] = _domain()            # 키의 등록 서비스 URL
    url = urlunparse(u._replace(scheme="https", query=urlencode(q)))
    ref = q.get("domain") or _domain()
    headers = {"User-Agent": "Mozilla/5.0", "Referer": ref, "Origin": ref} if ref else {}
    r = requests.get(url, headers=headers, timeout=15)   # 사내 프록시가 있으면 HTTPS_PROXY 환경변수 사용
    return Response(r.content, status=r.status_code,
                    content_type=r.headers.get("content-type", "application/json"))
```

```python
# app.py (기존 Flask 앱에 등록)
from vworld_proxy import bp as vworld_bp
app.register_blueprint(vworld_bp)   # 기존 라우트와 같은 prefix 규칙을 따를 것
```

## 2. 환경변수 (Flask 인스턴스)
```
VWORLD_API_KEY=발급키
VWORLD_API_DOMAIN=https://playground.idcube.sktelecom.com   # VWorld에 등록한 서비스 URL과 동일하게
```

## 3. 저장에 대해
사내 배포에서는 `public/temps/*.json`이 정적 파일이라 화면의 '보정 저장'(server.ts 저장 API)은 동작하지 않는다.
- 사내 화면: 자동/수동 보정 → 화면 적용 → 그 상태로 시뮬레이션 (세션 한정)
- 영구 반영: 로컬(npm run dev)에서 보정 저장 → temps JSON 커밋 → CI 배포
