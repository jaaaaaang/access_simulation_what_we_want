#!/bin/bash
# -------------------------------------------------------------
# LOS Simulator (playground-eng-apt-cover-windows) + Cloudflare Tunnel
# -------------------------------------------------------------

# 1. cinderella 가상환경 활성화 및 환경변수 설정
if [ -f "/Users/1109425/cinderella/bin/activate" ]; then
    source /Users/1109425/cinderella/bin/activate
    echo "✅ cinderella 가상환경 활성화 완료"
fi

export MOIRA_PYTHON_BIN="/Users/1109425/cinderella/bin/python"
export PORT=3000

# 2. 종료 트랩 설정 (Ctrl+C 누를 시 dev 서버와 cloudflared 모두 종료)
cleanup() {
    echo "
🛑 종료 중... 프로세스를 정리합니다."
    kill $(jobs -p) 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# 3. 개발 서버 백그라운드 실행
echo "🚀 로컬 서버 (port $PORT) 구동 시작..."
npm run dev &
DEV_PID=$!

# 서버 뜰 때까지 대기
sleep 2

# 4. Cloudflare Tunnel 실행
echo "🌐 Cloudflare Tunnel 연결 중... (외부 접속 URL 생성)"
cloudflared tunnel --url http://localhost:$PORT
