import express from "express";
import path from "path";
import http from "http";
import https from "https";
import { execFile, fork, ChildProcess } from "child_process";
import fs from "fs/promises";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { BatchManager } from "./server/batchManager";

dotenv.config();

// Helper to fetch using Node's native fetch first, falling back to stable HTTP/HTTPS agent.
async function robustGet(targetUrl: string): Promise<{ data: Buffer | string; isBuffer: boolean; contentType?: string }> {
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

  const REGISTERED_DOMAIN = "https://ais-dev-sm53qq4od7hwjydkbyh6gn-232203969309.asia-east1.run.app";
  // VWorld 인증키는 발급 시 등록한 '서비스 URL'과 domain 파라미터·Referer가 일치해야 한다.
  // .env VWORLD_API_DOMAIN 이 있으면 그것을 최우선으로 쓴다 (localhost 등록 키도 허용).
  const envDomain = (process.env.VWORLD_API_DOMAIN || "").trim();
  let domainRef = envDomain || new URL(normalizedUrl).searchParams.get("domain") || REGISTERED_DOMAIN;
  if (!envDomain && (!domainRef || domainRef.includes("localhost") || domainRef.includes("127.0.0.1"))) {
    domainRef = REGISTERED_DOMAIN;
  }
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "image/webp,image/apng,image/svg+xml,image/*,application/json,text/plain,*/*",
    "Referer": domainRef,
    "Origin": domainRef
  };

  // 1. Try Node's native fetch first
  try {
    const response = await fetch(normalizedUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000)
    });

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("image/")) {
      const arrayBuf = await response.arrayBuffer();
      return { data: Buffer.from(arrayBuf), isBuffer: true, contentType };
    } else {
      const text = await response.text();
      return { data: text, isBuffer: false, contentType };
    }
  } catch (nativeErr: any) {
    console.warn(`Native fetch failed for ${normalizedUrl}. Retrying with legacy agent...`, nativeErr.message);
  }

  // 2. Fallback to legacy HTTP/HTTPS agent
  const fetchWithProtocol = (urlStr: string, useHttps: boolean): Promise<{ data: Buffer | string; isBuffer: boolean; contentType?: string }> => {
    return new Promise((resolve, reject) => {
      let finished = false;
      const safeResolve = (val: { data: Buffer | string; isBuffer: boolean; contentType?: string }) => {
        if (!finished) { finished = true; resolve(val); }
      };
      const safeReject = (err: Error) => {
        if (!finished) { finished = true; reject(err); }
      };

      try {
        const parsedUrl = new URL(urlStr);
        const reqHeaders = { ...headers, "Connection": "close" };
        const options: https.RequestOptions = {
          hostname: parsedUrl.hostname,
          port: useHttps ? 443 : 80,
          path: parsedUrl.pathname + parsedUrl.search,
          method: "GET",
          headers: reqHeaders,
          timeout: 10000,
          rejectUnauthorized: false
        };

        const client = useHttps ? https : http;
        const req = client.request(options, (res) => {
          const contentType = res.headers["content-type"] || "";
          const isImg = contentType.includes("image/");
          const chunks: any[] = [];
          
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            if (isImg) {
              safeResolve({ data: buf, isBuffer: true, contentType });
            } else {
              safeResolve({ data: buf.toString("utf8"), isBuffer: false, contentType });
            }
          });
        });

        req.on("error", safeReject);
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
  const app = express();
  const httpServer = http.createServer(app);

  // Support -p or --port command-line arguments (e.g. npm run dev -- -p 3001)
  const args = process.argv.slice(2);
  let cliPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) {
      cliPort = Number(args[i + 1]);
      break;
    }
  }
  const PORT = cliPort || Number(process.env.PORT) || 3001;

  app.use(express.json({ limit: '6mb' }));

  // Subpath prefix rewrite middleware for company reverse proxies (e.g. /eng-apt-cover-windows/api/* -> /api/*)
  app.use((req, res, next) => {
    if (req.url.startsWith('/eng-apt-cover-windows/')) {
      req.url = req.url.replace('/eng-apt-cover-windows', '') || '/';
    }
    next();
  });

  // ==========================================================================
  // Flask(python) API 프록시 — playground-daily-tmap-data-querying-l
  // --------------------------------------------------------------------------
  // 이 React 앱은 python 실행/사내 DB 접속을 할 수 없으므로, DB 조회·CAD 추출은
  // 별도 Flask 앱이 담당한다. 로컬 개발에서는 포트가 달라(3001 vs 8080) 브라우저가
  // CORS로 막으므로, 이 서버가 대신 요청을 넘겨주고 응답을 그대로 돌려준다.
  //
  // 사내 배포 시에는 이 코드가 동작하지 않는다(nginx 정적 서빙). 대신 사내 ingress가
  // /daily-tmap-data-querying-l 경로를 Flask 앱으로 직접 라우팅한다.
  //
  // PY_API_URL 로 Flask 주소를 바꿀 수 있다 (기본 http://localhost:8080).
  // ==========================================================================
  const PY_API_URL = (process.env.PY_API_URL || "http://localhost:8080").replace(/\/$/, "");
  const PY_API_PREFIX = "/daily-tmap-data-querying-l";

  app.use(PY_API_PREFIX, async (req, res) => {
    // express는 app.use 마운트 시 req.url에서 prefix를 떼어낸다 → 다시 붙여서 전달
    const targetUrl = `${PY_API_URL}${PY_API_PREFIX}${req.url}`;
    try {
      const headers: Record<string, string> = {};
      // 업로드(multipart)는 body를 그대로 흘려보내야 하므로 content-type을 유지한다
      const ct = req.headers["content-type"];
      if (typeof ct === "string") headers["content-type"] = ct;

      const isBodyMethod = !["GET", "HEAD"].includes(req.method);
      let body: any = undefined;
      if (isBodyMethod) {
        if (typeof ct === "string" && ct.includes("application/json")) {
          // express.json()이 이미 파싱했으므로 다시 직렬화
          body = JSON.stringify(req.body ?? {});
        } else {
          // multipart 등은 원본 스트림을 그대로 전달
          body = req as any;
        }
      }

      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        // Node18+ 에서 스트림 body를 보낼 때 필요
        ...(body && typeof body !== "string" ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(10 * 60 * 1000), // CAD 추출 등 긴 작업 대비 10분
      } as any);

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.status(upstream.status);
      const upstreamCt = upstream.headers.get("content-type");
      if (upstreamCt) res.type(upstreamCt);
      res.send(buf);
    } catch (err: any) {
      console.error(`[py-api] ${req.method} ${targetUrl} 실패:`, err.message);
      res.status(502).json({
        result: "fail",
        error:
          `Flask API(${PY_API_URL})에 연결하지 못했습니다: ${err.message}. ` +
          `Flask 서버가 떠 있는지 확인하세요 (python app.py).`,
      });
    }
  });

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

      const uniqueSitesCount = new Set(
        (result.equipments || []).map((e: any) => `${Math.round(e.x)},${Math.round(e.y)}`)
      ).size;
      const sectorCount = (result.equipments || []).length;

      let buildingData = result.buildingCoverages?.map((bc: any) => `- 건물 ${bc.bIdx + 1}: ${bc.ratio.toFixed(0)}% (1차 ${bc.covered}/${bc.total}m, 2차 ${bc.secondCovered || 0}/${bc.secondTotal || 0}m)`).join('\n') || '없음';
      let equipmentData = result.logs.map((log: any) => `- 장비 ${log.id}: ${log.coveredCount}m 커버 (전파 Score: ${log.score.toFixed(1)})`).join('\n') || '없음';

      const prompt = `당신은 통신 RF 플래닝 전문가입니다. 건물 베란다(창문)를 커버하기 위한 국소 장비 위치 배치 알고리즘 시뮬레이션의 최신 결과를 분석해주세요.
          
- 전체 커버리지: ${result.coverageRatio.toFixed(1)}% (목표치: ${params.targetCoverage}%)
- 배치된 장비 수: ${uniqueSitesCount}개 Site (총 ${sectorCount}개 Sector)
- 건물별 커버리지 현황:
${buildingData}
- 개별 장비/사이트 배치 로그:
${equipmentData}

사용된 파라미터:
- 빔 폭(Beam Width): ${params.beamWidth}°
- 최대 도달 거리(Max Range): ${params.maxRange}m
- 엄격한 1건물 1폴대 제약(Strict 1 Pole / Building): ${params.strictCoLocation ? '적용됨' : '적용안됨'}

짧고 간결하면서 구조화된 분석을 제공하세요 (마크다운 불릿 포인트 사용).
1. 결과 요약 (목표 커버리지 달성 여부, 투입된 ${uniqueSitesCount}개 Site / ${sectorCount}개 Sector의 효율성).
2. 문제가 있는(커버가 저조한) 건물 분석 또는 커버가 우수한 건물에 대한 구조적 이유 분석.
3. 저효율 잉여 장비 식별 및 제거 제안 (중요!): 목록 중, 커버하는 절대적인 미터(m) 수 자체가 적거나 기여도가 낮은 섹터를 명확히 지목하세요. 이들을 제거했을 때 예상되는 전체 커버리지 하락폭이 미미함을 수치로 설명하며 제거를 권장하세요.`;

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

  // API Route: 서버에 VWorld 인증키(.env VWORLD_API_KEY)가 설정돼 있는지 (값은 반환하지 않음)
  app.get("/api/vworld-key-status", (_req, res) => {
    const k = (process.env.VWORLD_API_KEY || "").trim();
    // 키 값은 절대 반환하지 않고, 형식 점검 정보만 준다 (VWorld 키는 보통 UUID 형식 36자)
    res.json({
      serverKey: Boolean(k),
      length: k.length,
      uuidLike: /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(k),
      hasQuoteOrSpace: /["'\s]/.test(k),
      domain: (process.env.VWORLD_API_DOMAIN || "").trim() || "(미설정 → 기본 등록도메인 사용)",
    });
  });

  // API Route: VWorld 배경지도 타일 (WMTS) — 서버가 인증키를 붙여 이미지를 그대로 돌려준다.
  // 국내 지도/항공사진이라 Carto·Esri 보다 최신·정확하고, 워터마크("API key required")가 없다.
  //   /api/vworld-tile/<layer>/<z>/<y>/<x>   layer: Base | gray | midnight | Satellite | Hybrid
  const VWORLD_TILE_LAYERS = new Set(["Base", "gray", "midnight", "Satellite", "Hybrid"]);
  app.get("/api/vworld-tile/:layer/:z/:y/:x", async (req, res) => {
    const key = (process.env.VWORLD_API_KEY || "").trim();
    if (!key) return res.status(503).json({ error: "서버에 VWORLD_API_KEY가 없습니다." });
    const { layer, z, y, x } = req.params as Record<string, string>;
    if (!VWORLD_TILE_LAYERS.has(layer) || ![z, y, x].every(v => /^\d{1,3}$/.test(v) || /^\d+$/.test(v))) {
      return res.status(400).json({ error: "잘못된 타일 요청" });
    }
    const ext = layer === "Satellite" ? "jpeg" : "png";
    const url = `https://api.vworld.kr/req/wmts/1.0.0/${key}/${layer}/${z}/${y}/${x}.${ext}`;
    try {
      const r = await robustGet(url);
      if (!r.isBuffer) return res.status(502).json({ error: "타일 응답이 이미지가 아닙니다." });
      res.setHeader("Content-Type", r.contentType || `image/${ext}`);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(r.data);
    } catch (err: any) {
      res.status(502).json({ error: err.message || "타일 조회 실패" });
    }
  });

  // API Route: VWorld API proxy (to avoid CORS problems & fetch background map images)
  app.get("/api/vworld-proxy", async (req, res) => {
    try {
      const rawUrl = req.query.url as string;
      if (!rawUrl) {
        return res.status(400).json({ error: "Missing target url parameter." });
      }
      let targetUrl = rawUrl.trim();

      if (!targetUrl.startsWith("https://api.vworld.kr/") && !targetUrl.startsWith("http://api.vworld.kr/")) {
        return res.status(400).json({ error: "Invalid target domain. Only api.vworld.kr is supported." });
      }

      // 서버 보관 인증키 주입: 요청 URL에 key가 없거나 플레이스홀더(__SERVER__)면 .env의 VWORLD_API_KEY를 붙인다.
      // (브라우저 localStorage에 키가 없는 환경 — 배치/위치 자동보정 등 — 에서도 VWorld를 쓰기 위함. 키는 응답에 노출되지 않음)
      const serverKey = (process.env.VWORLD_API_KEY || "").trim();
      if (serverKey) {
        try {
          const u = new URL(targetUrl);
          const k = (u.searchParams.get("key") || "").trim();
          if (!k || k === "__SERVER__") {
            u.searchParams.set("key", serverKey);
            const envDomain = (process.env.VWORLD_API_DOMAIN || "").trim();
            if (envDomain) u.searchParams.set("domain", envDomain); // 서버 키는 서버 키의 등록 서비스URL로
            targetUrl = u.toString();
          }
        } catch { /* URL 파싱 실패 시 원본 그대로 */ }
      }

      const result = await robustGet(targetUrl);
      
      if (result.isBuffer) {
        res.setHeader("Content-Type", result.contentType || "image/png");
        res.send(result.data);
      } else {
        const text = result.data as string;

        // XML Error handling check
        if (text.includes("<error>") || text.includes("<text>")) {
          const match = text.match(/<text>([\s\S]*?)<\/text>/i);
          const errMsg = match ? match[1].trim() : text.substring(0, 200);
          return res.status(400).json({ error: `VWorld API Error: ${errMsg}` });
        }

        try {
          const json = JSON.parse(text);
          res.json(json);
        } catch {
          res.header("Content-Type", "text/plain; charset=utf-8");
          res.send(text);
        }
      }
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || "Failed to fetch VWorld API via server proxy" });
    }
  });

  // API Route: MOIRA Athena 단지/건물 폴리곤 조회 프록시
  // DB_structure.pdf §3-2/§3-4 공간조인을 athena/query_moira.py(idcube_hive_connector 사용)로 실행.
  // 사내망(idcube 접근 가능 환경)에서만 성공하며, 그 외 환경에서는 에러 JSON을 반환한다 —
  // 프론트엔드는 이 실패를 감지해 배치 캐시(public/complex_polygons.json) → VWorld 근사 순으로 폴백한다.
  app.get("/api/moira-polygon", async (req, res) => {
    const rapaKey = (req.query.rapaKey as string || "").trim();
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    if (!rapaKey || isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: "rapaKey, lat, lng 파라미터가 필요합니다." });
    }

    const pythonBin = process.env.MOIRA_PYTHON_BIN || "python3";
    const scriptPath = path.join(process.cwd(), "athena", "query_moira.py");

    execFile(
      pythonBin,
      [scriptPath, "single", "--rapa-key", rapaKey, "--lat", String(lat), "--lng", String(lng)],
      { timeout: 45000, maxBuffer: 1024 * 1024 * 20 },
      (err, stdout, stderr) => {
        if (stderr) {
          // athena/query_moira.py는 진행 로그를 stderr로 보냄 — 디버깅용으로만 서버 콘솔에 출력
          console.log(`[moira-polygon:${rapaKey}] ${stderr.trim()}`);
        }
        if (err) {
          console.error(`[moira-polygon:${rapaKey}] 실행 실패:`, err.message);
          return res.status(502).json({
            error: `Athena 조회 스크립트 실행 실패 (사내망/idcube_hive_connector 환경인지 확인 필요): ${err.message}`
          });
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.error) {
            return res.status(502).json({ error: parsed.error });
          }
          res.json(parsed);
        } catch (parseErr: any) {
          console.error(`[moira-polygon:${rapaKey}] stdout 파싱 실패:`, stdout);
          res.status(502).json({ error: `Athena 조회 스크립트 응답 파싱 실패: ${parseErr.message}` });
        }
      }
    );
  });

  // ==========================================================================
  // API Route: temps 캐시 JSON 교정 저장 ("DB 저장")
  // --------------------------------------------------------------------------
  // 프론트엔드(App.tsx handleSaveToDb)에서 화면상 건물 폴리곤을 교정한 뒤,
  // 원본 소스인 public/temps/<rapaKey>.json 을 덮어써서 다음 로드 및
  // LOS 배치 파이프라인에도 교정 결과가 반영되게 한다.
  // Save Topology(세션 export, 브라우저 다운로드)와는 역할이 다르다.
  // 최초 저장 시에만 원본을 public/temps/_backup/<rapaKey>.json 으로 1회 백업한다.
  // ==========================================================================
  const TEMPS_DIR = path.join(process.cwd(), "public", "temps");
  const TEMPS_BACKUP_DIR = path.join(TEMPS_DIR, "_backup");
  const BUILD_TEMPS_DIR = path.join(process.cwd(), "build", "temps");
  const BUILD_TEMPS_BACKUP_DIR = path.join(BUILD_TEMPS_DIR, "_backup");

  /** rapaKey -> public/temps/<key>.json 절대경로. 경로 탈출(../) 차단. */
  const safeTempsPath = (rapaKey: string): string | null => {
    const key = (rapaKey || "").trim();
    if (!key || key.length > 120) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(key)) return null;
    if (key.includes("..")) return null;
    const target = path.resolve(TEMPS_DIR, `${key}.json`);
    if (path.dirname(target) !== path.resolve(TEMPS_DIR)) return null;
    return target;
  };

  app.post("/api/moira-polygon/save", async (req, res) => {
    try {
      const { rapaKey, data } = req.body || {};
      const target = safeTempsPath(rapaKey);
      if (!target) {
        return res.status(400).json({ error: "유효하지 않은 rapaKey입니다." });
      }
      if (!data || !Array.isArray(data.buildings)) {
        return res.status(400).json({ error: "buildings 배열을 포함한 data가 필요합니다." });
      }

      await fs.mkdir(TEMPS_DIR, { recursive: true });

      // 최초 1회만 원본 백업 (이후 저장에서는 최초 원본 스냅샷을 계속 보존)
      let backedUp = false;
      const backupPath = path.join(TEMPS_BACKUP_DIR, `${rapaKey}.json`);
      let alreadyBackedUp = true;
      try {
        await fs.access(backupPath);
      } catch {
        alreadyBackedUp = false;
      }
      if (!alreadyBackedUp) {
        try {
          const original = await fs.readFile(target, "utf8");
          await fs.mkdir(TEMPS_BACKUP_DIR, { recursive: true });
          await fs.writeFile(backupPath, original, "utf8");
          backedUp = true;
        } catch {
          // 원본 파일이 없던 신규 키 — 백업 대상 없음
        }
      }

      const nowIso = new Date().toISOString();
      const payload = {
        ...data,
        _edit: {
          firstEditedAt: data?._edit?.firstEditedAt || nowIso,
          editedAt: nowIso,
          source: "rf-los-simulator/db-save",
          buildingCount: data.buildings.length,
        },
      };

      await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");

      // 프로덕션 빌드 폴더(build/temps)가 존재하는 경우 함께 동기화 기록
      try {
        await fs.mkdir(BUILD_TEMPS_DIR, { recursive: true });
        const buildTarget = path.join(BUILD_TEMPS_DIR, `${rapaKey}.json`);
        await fs.writeFile(buildTarget, JSON.stringify(payload, null, 2), "utf8");
        if (backedUp) {
          await fs.mkdir(BUILD_TEMPS_BACKUP_DIR, { recursive: true });
          const buildBackupPath = path.join(BUILD_TEMPS_BACKUP_DIR, `${rapaKey}.json`);
          const original = await fs.readFile(backupPath, "utf8");
          await fs.writeFile(buildBackupPath, original, "utf8");
        }
      } catch {
        // 빌드 폴더 동기화 실패 시 무시
      }

      console.log(`[temps:save] ${rapaKey} 저장 완료 (건물 ${data.buildings.length}동${backedUp ? ", 원본 백업 생성" : ""})`);
      res.json({
        ok: true,
        rapaKey,
        path: `public/temps/${rapaKey}.json`,
        backedUp,
        buildingCount: data.buildings.length,
        editedAt: nowIso,
      });
    } catch (err: any) {
      console.error("[temps:save] 실패:", err);
      res.status(500).json({ error: err.message || "temps JSON 저장 실패" });
    }
  });

  // 교정본을 최초 원본(_backup)으로 되돌리기
  app.post("/api/moira-polygon/restore", async (req, res) => {
    try {
      const { rapaKey } = req.body || {};
      const target = safeTempsPath(rapaKey);
      if (!target) {
        return res.status(400).json({ error: "유효하지 않은 rapaKey입니다." });
      }
      const backupPath = path.join(TEMPS_BACKUP_DIR, `${rapaKey}.json`);
      let original: string;
      try {
        original = await fs.readFile(backupPath, "utf8");
      } catch {
        return res.status(404).json({ error: "백업본이 없습니다 (아직 DB 저장을 한 적이 없는 대상)." });
      }
      await fs.writeFile(target, original, "utf8");
      // 프로덕션 빌드 폴더(build/temps)에도 복원 동기화
      try {
        const buildTarget = path.join(BUILD_TEMPS_DIR, `${rapaKey}.json`);
        await fs.writeFile(buildTarget, original, "utf8");
      } catch {}
      console.log(`[temps:restore] ${rapaKey} 원본 복원 완료`);
      res.json({ ok: true, rapaKey, restored: true });
    } catch (err: any) {
      console.error("[temps:restore] 실패:", err);
      res.status(500).json({ error: err.message || "복원 실패" });
    }
  });

  // RAPA Key 부분 문자열로 temps 캐시 목록 조회 (상단바 RAPA Key 검색창 배지용)
  // ==========================================================================
  // 폴리곤/도면 확보 현황 — 전체 temps 스캔 (RAPA 리스트 마킹·필터용)
  //   hasComplex: 단지 폴리곤 확보 여부 / buildingCount: 건물 폴리곤 수
  //   source: buildingSource (complex_polygon / bbox_fallback / pdf_extraction ...)
  //   hasPlan: public/plans/<rapaKey>.(png|jpg|...) 도면 이미지 확보 여부
  // ==========================================================================
  const PLANS_DIR = path.join(process.cwd(), "public", "plans");
  app.get("/api/polygon-status", async (_req, res) => {
    try {
      let names: string[] = [];
      try {
        names = (await fs.readdir(TEMPS_DIR)).filter((n) => n.endsWith(".json"));
      } catch {
        return res.json({ total: 0, status: {} });
      }
      const planKeys = new Set<string>();
      try {
        (await fs.readdir(PLANS_DIR)).forEach((n) => {
          const m = n.match(/^(.+)\.(png|jpe?g|webp|pdf)$/i);
          if (m) planKeys.add(m[1]);
        });
      } catch { /* plans 디렉토리 없으면 전부 미확보 */ }
      const status: Record<string, any> = {};
      for (const n of names) {
        const key = n.replace(/\.json$/, "");
        let hasComplex = false, buildingCount = 0, source: string | null = null;
        try {
          const parsed = JSON.parse(await fs.readFile(path.join(TEMPS_DIR, n), "utf8"));
          hasComplex = Array.isArray(parsed?.complex?.polygon) && parsed.complex.polygon.length >= 3;
          buildingCount = Array.isArray(parsed?.buildings) ? parsed.buildings.length : 0;
          source = parsed?.buildingSource ?? null;
        } catch { /* 파싱 실패 → 미확보 취급 */ }
        status[key] = { hasComplex, buildingCount, source, hasPlan: planKeys.has(key) };
      }
      res.json({ total: names.length, status });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "polygon-status 조회 실패" });
    }
  });

  app.get("/api/temps/list", async (req, res) => {
    try {
      const q = ((req.query.q as string) || "").trim().toLowerCase();
      let names: string[] = [];
      try {
        names = (await fs.readdir(TEMPS_DIR)).filter((n) => n.endsWith(".json"));
      } catch {
        return res.json({ total: 0, items: [] });
      }
      const keys = names.map((n) => n.replace(/\.json$/, ""));
      const matched = q ? keys.filter((k) => k.toLowerCase().includes(q)) : keys;
      const items = await Promise.all(
        matched.slice(0, 30).map(async (key) => {
          const item: any = { rapaKey: key, complexName: null, buildingCount: 0, editedAt: null };
          try {
            const raw = await fs.readFile(path.join(TEMPS_DIR, `${key}.json`), "utf8");
            const parsed = JSON.parse(raw);
            item.complexName = parsed?.complex?.cplx_scl_nm ?? null;
            item.buildingCount = Array.isArray(parsed?.buildings) ? parsed.buildings.length : 0;
            item.editedAt = parsed?._edit?.editedAt ?? null;
          } catch {
            // 파싱 실패 파일은 키만 반환
          }
          return item;
        })
      );
      res.json({ total: matched.length, items });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "temps 목록 조회 실패" });
    }
  });

  // ==========================================================================
  // API Routes: 단일 시뮬레이션 서버 오프로딩 연산
  // ==========================================================================
  // ==========================================================================
  // 단일 시뮬레이션 — 별도 프로세스(scripts/simWorker.ts) + jobId 폴링
  // --------------------------------------------------------------------------
  // (구) 이 자리에서 runSimulation() 을 동기 호출했음 → 수 분간 express 이벤트 루프가
  //      통째로 막혀 배치 status 폴링·VWorld 프록시 등 모든 API 가 정지했다.
  // (신) 배치(batchManager.spawnWorker)와 같은 구조로 fork 한 자식 프로세스가 연산하고,
  //      클라이언트는 jobId 로 /api/sim/job/:id 를 폴링한다. 10분짜리 HTTP 를 붙잡지 않는다.
  // ==========================================================================
  type SimJob = {
    id: string;
    rapaKey: string | null;
    status: 'running' | 'done' | 'error' | 'cancelled';
    startedAt: number;
    finishedAt?: number;
    durationMs?: number;
    result?: any;
    error?: string;
    child?: ChildProcess;
    inputPath: string;
    outputPath: string;
  };
  const simJobs = new Map<string, SimJob>();
  const SIM_JOBS_DIR = path.join(process.cwd(), "data", "sim-jobs");
  const SIM_JOB_TTL_MS = 30 * 60 * 1000; // 결과는 30분 뒤 메모리에서 제거

  const cleanupSimJobFiles = async (job: SimJob) => {
    for (const f of [job.inputPath, job.outputPath]) {
      try { await fs.unlink(f); } catch { }
    }
  };

  app.post("/api/sim/run-single", async (req, res) => {
    try {
      const { buildings, verandas, params, equipments, rapaKey } = req.body || {};

      if (!Array.isArray(buildings) || !Array.isArray(verandas)) {
        return res.status(400).json({ error: "buildings 및 verandas 배열 데이터가 필요합니다." });
      }
      if (buildings.length === 0 || verandas.length === 0) {
        return res.status(400).json({ error: "건물 또는 베란다 데이터가 비어 있습니다." });
      }

      await fs.mkdir(SIM_JOBS_DIR, { recursive: true });
      const id = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const inputPath = path.join(SIM_JOBS_DIR, `${id}.in.json`);
      const outputPath = path.join(SIM_JOBS_DIR, `${id}.out.json`);
      await fs.writeFile(inputPath, JSON.stringify({ buildings, verandas, params: params || {}, equipments: equipments || [], rapaKey: rapaKey || null }), "utf8");

      const job: SimJob = { id, rapaKey: rapaKey || null, status: 'running', startedAt: Date.now(), inputPath, outputPath };
      simJobs.set(id, job);

      const workerScript = path.join(process.cwd(), "scripts", "simWorker.ts");
      const child = fork(workerScript, ["--input", inputPath, "--output", outputPath], {
        execArgv: ["--import", "tsx"],
        silent: true,
      });
      job.child = child;
      console.log(`[Server-Sim] 🚀 워커 시작 job=${id} pid=${child.pid} (key: ${rapaKey || 'manual'}, 건물: ${buildings.length}, 베란다: ${verandas.length})`);

      let ipcPayload: any = null;
      child.on("message", (msg: any) => { if (msg && typeof msg === "object") ipcPayload = msg; });
      child.stderr?.on("data", (d) => { const t = d.toString().trim(); if (t) console.log(`[Server-Sim:${id}] ${t}`); });

      child.on("exit", async (code, signal) => {
        if (job.status === 'cancelled') { await cleanupSimJobFiles(job); return; }
        job.finishedAt = Date.now();
        job.durationMs = job.finishedAt - job.startedAt;
        let payload = ipcPayload;
        // IPC 유실 폴백: 정상 종료인데 메시지가 없으면 워커가 저장한 결과 파일을 읽는다
        if (!payload && code === 0 && signal === null) {
          try { payload = JSON.parse(await fs.readFile(outputPath, "utf8")); } catch { }
        }
        if (payload && payload.ok && payload.result) {
          job.status = 'done';
          job.result = payload.result;
          job.durationMs = payload.durationMs ?? job.durationMs;
          console.log(`[Server-Sim] ✅ job=${id} 완료 (${job.durationMs}ms, Rank 1 커버리지: ${payload.result.coverageRatio?.toFixed(1)}%)`);
        } else {
          job.status = 'error';
          job.error = payload?.error || `워커 비정상 종료 (code=${code}, signal=${signal})`;
          console.error(`[Server-Sim] ❌ job=${id} 실패: ${job.error}`);
        }
        job.child = undefined;
        await cleanupSimJobFiles(job);
        setTimeout(() => simJobs.delete(id), SIM_JOB_TTL_MS).unref?.();
      });

      res.json({ ok: true, jobId: id, rapaKey: rapaKey || null });
    } catch (err: any) {
      console.error("[Server-Sim] ❌ 워커 기동 실패:", err);
      res.status(500).json({ error: err.message || "시뮬레이션 워커를 시작하지 못했습니다." });
    }
  });

  // 상태 폴링: running 이면 경과 시간만, done 이면 결과 포함
  app.get("/api/sim/job/:id", (req, res) => {
    const job = simJobs.get(String(req.params.id));
    if (!job) return res.status(404).json({ error: "존재하지 않거나 만료된 jobId 입니다." });
    const base = { ok: true, jobId: job.id, status: job.status, rapaKey: job.rapaKey, elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt };
    if (job.status === 'done') return res.json({ ...base, durationMs: job.durationMs, result: job.result });
    if (job.status === 'error') return res.status(500).json({ ...base, error: job.error });
    res.json(base);
  });

  // 취소: 워커 프로세스 kill (사용자가 화면을 떠나거나 취소 버튼)
  app.post("/api/sim/job/:id/cancel", (req, res) => {
    const job = simJobs.get(String(req.params.id));
    if (!job) return res.status(404).json({ error: "존재하지 않는 jobId 입니다." });
    if (job.status === 'running' && job.child) {
      job.status = 'cancelled';
      try { job.child.kill("SIGTERM"); } catch { }
      console.log(`[Server-Sim] ⛔ job=${job.id} 취소`);
    }
    res.json({ ok: true, jobId: job.id, status: job.status });
  });

  // ==========================================================================
  // API Routes: LOS 대량 배치 분석 & 결과 저장 (TODOLIST Phase 2)
  // ==========================================================================
  const batchManager = new BatchManager();
  await batchManager.init();

  // 배치 분석 시작
  app.post("/api/batch/start", async (req, res) => {
    try {
      const { rapaKeys, params, concurrency, skipAnalyzed, forceRerun } = req.body || {};
      if (!Array.isArray(rapaKeys) || rapaKeys.length === 0) {
        return res.status(400).json({ error: "rapaKeys 배열이 필요합니다." });
      }
      const result = await batchManager.startBatch({
        rapaKeys,
        params,
        concurrency,
        skipAnalyzed,
        forceRerun,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || "배치 시작 실패" });
    }
  });

  // 배치 진행 상태 폴링
  app.get("/api/batch/status", (req, res) => {
    try {
      res.json(batchManager.getStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message || "배치 상태 조회 실패" });
    }
  });

  // 배치 분석 취소
  app.post("/api/batch/cancel", async (req, res) => {
    try {
      const result = await batchManager.cancelBatch();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "배치 취소 실패" });
    }
  });

  // 결과 목록 조회 (_index.json 기반)
  app.get("/api/results/list", async (req, res) => {
    try {
      const index = await batchManager.getResultsList();
      res.json(index);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "결과 목록 조회 실패" });
    }
  });

  // 수동 분석 결과 저장
  app.post("/api/results/save", async (req, res) => {
    try {
      const { rapaKey, result } = req.body || {};
      if (!rapaKey || !result) {
        return res.status(400).json({ error: "rapaKey와 result 데이터가 필요합니다." });
      }

      const safeKey = String(rapaKey).trim();
      result.rapaKey = safeKey;
      result.source = 'manual';

      // Payload 크기 검증 (5MB 상한)
      const payloadSize = JSON.stringify(result).length;
      if (payloadSize > 5 * 1024 * 1024) {
        return res.status(413).json({ error: "결과 데이터 크기가 5MB 상한을 초과했습니다." });
      }

      await batchManager.saveManualResult(safeKey, result);
      res.json({ ok: true, rapaKey: safeKey });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "수동 결과 저장 실패" });
    }
  });

  // 특정 단지 상세 결과 JSON 조회
  app.get("/api/results/:rapaKey", async (req, res) => {
    try {
      const rapaKey = req.params.rapaKey;
      const result = await batchManager.getResult(rapaKey);
      if (!result) {
        return res.status(404).json({ error: `분석 결과를 찾을 수 없습니다: ${rapaKey}` });
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "결과 조회 실패" });
    }
  });

  // 특정 단지 결과 삭제
  app.delete("/api/results/:rapaKey", async (req, res) => {
    try {
      const rapaKey = req.params.rapaKey;
      const deleted = await batchManager.deleteResult(rapaKey);
      res.json({ ok: true, rapaKey, deleted });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "결과 삭제 실패" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: {
          server: httpServer,
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    let staticDir = path.join(process.cwd(), 'build');
    try {
      await fs.access(staticDir);
    } catch {
      staticDir = path.join(process.cwd(), 'dist');
    }
    app.use(express.static(staticDir));
    app.get('*', (req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  httpServer.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n❌ Error: Port ${PORT} is already in use.`);
      console.error(`👉 Try running on another port: npm run dev -- -p ${PORT + 1}`);
      console.error(`👉 Or kill the process using port ${PORT}: npx kill-port ${PORT}\n`);
      process.exit(1);
    } else {
      console.error("Server error:", err);
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
