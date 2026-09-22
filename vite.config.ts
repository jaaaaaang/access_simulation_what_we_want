import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode, command}) => {
  const env = loadEnv(mode, '.', '');
  return {
    // ---------------------------------------------------------------------
    // 호스팅 기본 경로는 '/' (Google AI Studio / Cloud Run 루트 호스팅 호환)
    // 사내 nginx 배포 시에는 VITE_BASE_PATH=/eng-apt-cover-windows/ 환경변수 설정으로 오버라이드 가능
    base: env.VITE_BASE_PATH || '/',
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      outDir: 'build',
    },
    server: {
      allowedHosts: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // ---------------------------------------------------------------------
      // 로컬 개발용 프록시: Flask(python) API
      // ---------------------------------------------------------------------
      // 브라우저는 same-origin(localhost:3000)으로 요청하고, Vite가 이를
      // Flask(localhost:8080)로 대신 넘겨준다 -> 로컬에서도 CORS 문제 없음.
      // 사내 배포 시에는 이 프록시가 동작하지 않고, 대신 사내 ingress가
      // /daily-tmap-data-querying-l 경로를 Flask 앱으로 라우팅한다.
      proxy: {
        '/daily-tmap-data-querying-l': {
          target: env.PY_API_URL || 'http://localhost:8080',
          changeOrigin: true,
        },
      },
    },
  };
});
