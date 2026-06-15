import express from "express";
import path from "path";
import http from "http";
import https from "https";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

// Helper to fetch using Node's standard stable legacy agent with HTTP/HTTPS fallback, bypassing TLS issues and keepalive drops.
function robustGet(targetUrl: string): Promise<string> {
  // Let's parse and normalize the URL first to remove raw leading/trailing whitespaces from parameters (critical to avoid socket hang ups!)
  let normalizedUrl = targetUrl.trim();
  try {
    const parsed = new URL(normalizedUrl);
    const cleanedParams = new URLSearchParams();
    parsed.searchParams.forEach((value, name) => {
      cleanedParams.set(name.trim(), value.trim());
    });
    parsed.search = cleanedParams.toString();
    normalizedUrl = parsed.toString();
  } catch (err: any) {
    console.error("Failed to normalize URL:", err.message);
  }

  const fetchWithProtocol = (urlStr: string, useHttps: boolean): Promise<string> => {
    return new Promise((resolve, reject) => {
      let finished = false;
      const safeResolve = (val: string) => {
        if (!finished) {
          finished = true;
          resolve(val);
        }
      };
      const safeReject = (err: Error) => {
        if (!finished) {
          finished = true;
          reject(err);
        }
      };

      try {
        const parsedUrl = new URL(urlStr);
        const options: https.RequestOptions = {
          hostname: parsedUrl.hostname,
          port: useHttps ? 443 : 80,
          path: parsedUrl.pathname + parsedUrl.search,
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Connection": "close"
          },
          timeout: 10000,
          rejectUnauthorized: false // Bypasses TLS/SSL handshake validation issues
        };

        const client = useHttps ? https : http;
        const req = client.request(options, (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            safeResolve(data);
          });
        });

        req.on("error", (err) => {
          safeReject(err);
        });

        req.on("timeout", () => {
          req.destroy();
          safeReject(new Error(`Timeout fetching ${urlStr}`));
        });

        req.end();
      } catch (err: any) {
        safeReject(err);
      }
    });
  };

  return fetchWithProtocol(normalizedUrl, normalizedUrl.startsWith("https:"))
    .catch((err) => {
      console.warn(`Request to ${normalizedUrl} failed on default protocol. Retrying with alternative protocol... Error:`, err.message);
      let fallbackUrl = normalizedUrl;
      let useHttps = normalizedUrl.startsWith("https:");
      if (useHttps) {
        fallbackUrl = normalizedUrl.replace(/^https:/i, "http:");
        useHttps = false;
      } else {
        fallbackUrl = normalizedUrl.replace(/^http:/i, "https:");
        useHttps = true;
      }
      return fetchWithProtocol(fallbackUrl, useHttps);
    });
}

async function startServer() {
  const app = reportAppErrors(express());
  const PORT = 3000;

  app.use(express.json());

  // Helper with basic request error reporting
  function reportAppErrors(expressApp: express.Express) {
    return expressApp;
  }

  // API Route: Gemini Insights proxy
  app.post("/api/ai-insights", async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not defined on the server side." });
      }

      const { result, params } = req.body;
      if (!result) {
        return res.status(400).json({ error: "Missing simulation result." });
      }

      const ai = new GoogleGenAI({ apiKey });

      let buildingData = result.buildingCoverages?.map((bc: any) => `- 건물 ${bc.bIdx + 1}: ${bc.ratio.toFixed(0)}% (커버됨 ${bc.covered}m / 총 ${bc.total}m)`).join('\n') || '없음';
      let equipmentData = result.logs.map((log: any) => `- 장비 ${log.id}: ${log.coveredCount}m 커버 (전파 Score: ${log.score.toFixed(1)}, 평균 품질 효율: ${((log.score / log.coveredCount) * 100 || 0).toFixed(1)}%)`).join('\n') || '없음';

      const prompt = `당신은 통신 RF 플래닝 전문가입니다. 건물 베란다(창문)를 커버하기 위한 국소 장비 위치 배치 알고리즘 시뮬레이션의 최신 결과를 분석해주세요.
          
- 전체 커버리지: ${result.coverageRatio.toFixed(1)}% (목표치: ${params.targetCoverage}%)
- 배치된 장비 수: ${result.equipments.length} 개
- 건물별 커버리지 현황:
${buildingData}
- 개별 장비 스펙 및 효율 수치 (Score/Meters = 평균 품질 효율%):
${equipmentData}

사용된 파라미터:
- 빔 폭(Beam Width): ${params.beamWidth}°
- 최대 도달 거리(Max Range): ${params.maxRange}m
- 엄격한 1건물 1폴대 제약(Strict 1 Pole / Building): ${params.strictCoLocation ? '적용됨' : '적용안됨'}

짧고 간결하면서 구조화된 분석을 제공하세요 (마크다운 불릿 포인트 사용).
1. 결과 요약 (목표 커버리지 달성 여부, 투입된 장비 총 개수의 효율성).
2. 문제가 있는(커버가 저조한) 건물 분석 또는 커버가 우수한 건물에 대한 구조적 이유 분석.
3. 저효율 잉여 장비 식별 및 제거 제안 (중요!): 장비 목록 중, 평균 품질 효율(%)이 지나치게 낮거나, 커버하는 절대적인 미터(m) 수 자체가 너무 적은 장비들을 명확히 지목하세요. 이들을 제거했을 때 예상되는 전체 커버리지 하락폭이 미미함을 수치로 설명하며 제거를 강하게 권장하세요.`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt
      });

      res.json({ text: response.text });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || "Gemini API Error" });
    }
  });

  // API Route: VWorld API proxy (to avoid CORS problems)
  app.get("/api/vworld-proxy", async (req, res) => {
    try {
      const rawUrl = req.query.url as string;
      if (!rawUrl) {
        return res.status(400).json({ error: "Missing target url parameter." });
      }
      const targetUrl = rawUrl.trim();

      // Ensure the URL is requesting vworld domains for safety
      if (!targetUrl.startsWith("https://api.vworld.kr/") && !targetUrl.startsWith("http://api.vworld.kr/")) {
        return res.status(400).json({ error: "Invalid target domain. Only api.vworld.kr is supported." });
      }

      const text = await robustGet(targetUrl);
      
      try {
        const json = JSON.parse(text);
        res.json(json);
      } catch {
        // If not JSON, send it as plain text/xml/html
        res.header("Content-Type", "text/plain; charset=utf-8");
        res.send(text);
      }
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || "Failed to fetch VWorld API via server proxy" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
