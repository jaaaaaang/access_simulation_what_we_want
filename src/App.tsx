import React, { useState, useRef, useEffect } from 'react';
import { Upload, Square, Minus, Play, RotateCcw, Image as ImageIcon, Terminal, Database, Search, ZoomIn, ZoomOut, RadioTower, Check, Sparkles, Download, Eraser, Save, FolderOpen, X, AlertTriangle, Info, Ruler } from 'lucide-react';
import { Point, Line, Polygon, SimulationParams, SimulationResult, Equipment } from './types';
import { runSimulation, pointInPolygon, snapToPolygonEdge, getSecondVerandas } from './lib/simulation';
import { sampleBuildings, sampleVerandas } from './lib/sampleData';
// @ts-ignore
import * as shp from 'shpjs';
import Markdown from 'react-markdown';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { motion, AnimatePresence } from 'motion/react';

// Helper for JSONP calls on the client side to bypass both browser CORS policies and cloud provider IP (WAF) blocks natively
const fetchJSONP = (url: string): Promise<any> => {
  return new Promise((resolve, reject) => {
    const callbackName = `vworld_jsonp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement("script");
    
    const hasQuestionMark = url.includes("?");
    const separator = hasQuestionMark ? "&" : "?";
    const jsonpUrl = `${url}${separator}callback=${callbackName}`;
    
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("VWorld OpenAPI 요청 시간 초과 (12초). 입력하신 브이월드 API Key 또는 등록 도메인 설정을 확인해 주세요."));
    }, 12000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (document.body.contains(script)) {
        document.body.removeChild(script);
      }
      delete (window as any)[callbackName];
    };

    (window as any)[callbackName] = (data: any) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("네트워크 보안 로드 실패 (브라우저가 브이월드 서버에 연결을 완료하지 못했거나, 키 발급 시 등록한 도메인과 현재 접속 도메인이 불일치합니다.)"));
    };

    script.src = jsonpUrl;
    script.async = true;
    document.body.appendChild(script);
  });
};

const extractVworldErrorMessage = (errorObj: any): string => {
  if (!errorObj) return '';
  if (typeof errorObj === 'object') {
    return errorObj.text || errorObj.message || JSON.stringify(errorObj);
  }
  return String(errorObj);
};

// Help extract physical building name from VWorld properties dynamically (adaptable to different schema keys)
const getBuildingNameFromProperties = (properties: any): string => {
  if (!properties) return '';
  const searchKeys = [
    'buld_nm', 'bld_nm', 'bldg_nm', 'buld_nm_dc', 'bldgbld_nm', 
    'BLD_NM', 'BULD_NM', 'BLDG_NM', 'facil_nm', 'FACIL_NM'
  ];
  for (const key of searchKeys) {
    if (properties[key] !== undefined && properties[key] !== null) {
      return String(properties[key]).trim();
    }
  }
  for (const [_, val] of Object.entries(properties)) {
    if (typeof val === 'string' && val.length > 1) {
      if (val.includes('동') || val.includes('아파트') || val.includes('타워') || val.includes('빌라') || val.includes('맨션') || val.includes('단지')) {
        return val.trim();
      }
    }
  }
  return '';
};

// Intelligently extract core proprietary noun from query or title to match only target apartments on client-side
const extractCoreApartmentName = (title: string, query: string): string => {
  const cleanHtml = (txt: string) => txt.replace(/<\/?[^>]+(>|$)/g, "");
  let clean = cleanHtml(title || '').trim();
  
  const trashWords = [
    '아파트', '오피스텔', '빌라', '타워', '맨션', '상가', '단지', '주택', '공동주택',
    '대구광역시', '서울특별시', '부산광역시', '인천광역시', '대전광역시', '광주광역시', '울산광역시', '경기도', '경상북도', '경상남도', '전라북도', '전라남도', '충청북도', '충청남도', '강원도', '제주도',
    '대구', '서울', '부산', '인천', '대전', '광주', '울산', '세종',
    '특별시', '광역시', '특별자치시', '특별자치도',
    '시', '군', '구', '동', '읍', '면', '리', '대로', '로', '길'
  ];

  const queryTokens = query.split(/\s+/).filter(t => t.length > 1);
  const cleanQueryTokens = queryTokens.filter(t => !trashWords.includes(t));
  if (cleanQueryTokens.length > 0) {
    cleanQueryTokens.sort((a, b) => b.length - a.length);
    return cleanQueryTokens[0];
  }

  const tokens = clean.split(/\s+/).filter(t => t.length > 1);
  const cleanTokens = tokens.filter(t => !trashWords.includes(t));
  if (cleanTokens.length > 0) {
    cleanTokens.sort((a, b) => b.length - a.length);
    return cleanTokens[0];
  }

  let core = clean;
  trashWords.forEach(word => {
    core = core.replace(new RegExp(word, 'g'), '');
  });
  
  return core.trim() || clean.substring(0, 5);
};

export default function App() {
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'warning' | 'info' } | null>(null);

  const showAppNotification = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(prev => prev?.message === message ? null : prev);
    }, 8500);
  };

  const stripHtml = (htmlStr: string): string => {
    return htmlStr.replace(/<[^>]*>/g, '').trim();
  };

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [buildings, setBuildings] = useState<Polygon[]>([]);
  const [verandas, setVerandas] = useState<Line[]>([]);
  const [manualEquipments, setManualEquipments] = useState<Equipment[]>([]);
  const [mode, setMode] = useState<'idle' | 'building' | 'veranda' | 'second_veranda' | 'equipment' | 'eraser' | 'ruler'>('idle');
  
  const [currentPolygon, setCurrentPolygon] = useState<Point[]>([]);
  const [currentLineStart, setCurrentLineStart] = useState<Point | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  
  const [rulerLine, setRulerLine] = useState<{ start: Point; end: Point } | null>(null);
  const [rulerInputMeters, setRulerInputMeters] = useState<string>('50');
  
  const [params, setParams] = useState<SimulationParams>({
    beamWidth: 60,
    maxRange: 150,
    targetCoverage: 65,
    pixelsPerMeter: 2,
    strictCoLocation: true
  });
  
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState({width: 1000, height: 1000});
  
  const [aiInsights, setAiInsights] = useState<string | null>(null);
  const [isGeneratingInsights, setIsGeneratingInsights] = useState(false);
  const [showAiPanel, setShowAiPanel] = useState(false);

  // VWorld API and mapping state definitions
  const [geoMapping, setGeoMapping] = useState<{
    minLon: number;
    minLat: number;
    lonRange: number;
    latRange: number;
    cWidth: number;
    cHeight: number;
  } | null>(null);

  const [vworldKey, setVworldKey] = useState<string>(() => {
    return localStorage.getItem('vworld_api_key') || ((import.meta as any).env?.VITE_VWORLD_API_KEY as string) || '';
  });
  const [vworldDomain, setVworldDomain] = useState<string>(() => {
    return localStorage.getItem('vworld_api_domain') || window.location.origin;
  });
  const [vworldRequestMode, setVworldRequestMode] = useState<'direct' | 'proxy'>(() => {
    return (localStorage.getItem('vworld_request_mode') as 'direct' | 'proxy') || 'proxy';
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isFetchingPolygons, setIsFetchingPolygons] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const url = event.target?.result as string;
      const img = new Image();
      img.onload = () => {
        imageRef.current = img;
        setImageSrc(url);
        setCanvasSize({width: img.width, height: img.height});
        if (canvasRef.current) {
          canvasRef.current.width = img.width;
          canvasRef.current.height = img.height;
        }
        setBuildings([]);
        setVerandas([]);
        setResult(null);
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  };

  const handleShpUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const geojson = await shp.parseZip(arrayBuffer);
      let features: any[] = [];
      if (Array.isArray(geojson)) {
           features = geojson.flatMap(g => g.features);
      } else {
           features = geojson.features;
      }
      
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
      features.forEach(f => {
          if (f.geometry && f.geometry.type === 'Polygon') {
              f.geometry.coordinates[0].forEach((coord: number[]) => {
                 minLon = Math.min(minLon, coord[0]);
                 minLat = Math.min(minLat, coord[1]);
                 maxLon = Math.max(maxLon, coord[0]);
                 maxLat = Math.max(maxLat, coord[1]);
              });
          } else if (f.geometry && f.geometry.type === 'MultiPolygon') {
              f.geometry.coordinates.forEach((poly: number[][][]) => {
                 poly[0].forEach((coord: number[]) => {
                     minLon = Math.min(minLon, coord[0]);
                     minLat = Math.min(minLat, coord[1]);
                     maxLon = Math.max(maxLon, coord[0]);
                     maxLat = Math.max(maxLat, coord[1]);
                 });
              });
          }
      });
      
      const lonRange = (maxLon - minLon) || 1;
      const latRange = (maxLat - minLat) || 1;
      const cWidth = 1200; 
      const cHeight = 800;
      
      const parsedBuildings: Polygon[] = [];
      features.forEach(f => {
           if (f.geometry && f.geometry.type === 'Polygon') {
                const poly = f.geometry.coordinates[0].map((coord: number[]) => {
                     const x = ((coord[0] - minLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
                     const y = cHeight - (((coord[1] - minLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1)); 
                     return {x, y};
                });
                parsedBuildings.push(poly);
           } else if (f.geometry && f.geometry.type === 'MultiPolygon') {
                f.geometry.coordinates.forEach((multiPoly: number[][][]) => {
                    const poly = multiPoly[0].map((coord: number[]) => {
                         const x = ((coord[0] - minLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
                         const y = cHeight - (((coord[1] - minLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1)); 
                         return {x, y};
                    });
                    parsedBuildings.push(poly);
                });
           }
      });
      
      setCanvasSize({width: cWidth, height: cHeight});
      setImageSrc(null); 
      imageRef.current = null;
      setBuildings(parsedBuildings);
      setVerandas([]); 
      setManualEquipments([]);
      setResult(null);
      setMode('idle');
      setGeoMapping({
        minLon,
        minLat,
        lonRange,
        latRange,
        cWidth,
        cHeight
      });
      if (canvasRef.current) {
        canvasRef.current.width = cWidth;
        canvasRef.current.height = cHeight;
      }
    } catch (err) {
       console.error("SHP Parse Error:", err);
       showAppNotification("SHP 파일 파싱에 실패했습니다. 올바른 형태의 zip 데이터인지 확인해 주세요.", "error");
    }
  };

  const loadSampleData = () => {
     setCanvasSize({width: 1000, height: 1000});
     setImageSrc(null);
     imageRef.current = null;
     setBuildings(sampleBuildings);
     setVerandas(sampleVerandas);
     setManualEquipments([]);
     setResult(null);
     setMode('idle');
     if (canvasRef.current) {
        canvasRef.current.width = 1000;
        canvasRef.current.height = 1000;
     }
  };

  const distSq = (v: Point, w: Point) => (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
  const distToSegmentSquared = (p: Point, v: Point, w: Point) => {
    let l2 = distSq(v, w);
    if (l2 === 0) return distSq(p, v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return distSq(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
  };
  const distToSegment = (p: Point, v: Point, w: Point) => Math.sqrt(distToSegmentSquared(p, v, w));

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / zoom;
    const y = (e.clientY - rect.top) / zoom;
    const p = { x, y };

    if (mode === 'building') {
      setCurrentPolygon([...currentPolygon, p]);
    } else if (mode === 'ruler') {
      if (!currentLineStart) {
        setCurrentLineStart(p);
      } else {
        setRulerLine({ start: currentLineStart, end: p });
        setCurrentLineStart(null);
      }
    } else if (mode === 'veranda') {
      if (!currentLineStart) {
        setCurrentLineStart(p);
      } else {
        setVerandas([...verandas, { start: currentLineStart, end: p }]);
        setCurrentLineStart(null);
      }
    } else if (mode === 'second_veranda') {
      if (!currentLineStart) {
        setCurrentLineStart(p);
      } else {
        setVerandas([...verandas, { start: currentLineStart, end: p, isSecond: true }]);
        setCurrentLineStart(null);
      }
    } else if (mode === 'equipment') {
       let bIdx = buildings.findIndex(b => pointInPolygon(p, b));
       let finalP = p;
       if (bIdx >= 0) {
           finalP = snapToPolygonEdge(p, buildings[bIdx]);
       }
       
       let maxIdx = 0;
       manualEquipments.forEach(e => {
         if (e.id.startsWith('M-')) {
           const parts = e.id.split('-');
           if (parts.length >= 2) {
             const idx = parseInt(parts[1], 10);
             if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
           }
         }
       });
       const nextSiteIdx = maxIdx + 1;

       const s1 = { id: `M-${nextSiteIdx}-A`, x: finalP.x, y: finalP.y, angle: 0, bIdx: bIdx >= 0 ? bIdx : undefined, isManual: true };
       const s2 = { id: `M-${nextSiteIdx}-B`, x: finalP.x, y: finalP.y, angle: 120, bIdx: bIdx >= 0 ? bIdx : undefined, isManual: true };
       const s3 = { id: `M-${nextSiteIdx}-C`, x: finalP.x, y: finalP.y, angle: 240, bIdx: bIdx >= 0 ? bIdx : undefined, isManual: true };

       setManualEquipments([...manualEquipments, s1, s2, s3]);
       setResult(null);
    } else if (mode === 'eraser') {
      // Priority 1: Eraser Manual Equipment (remove entire co-located site)
      const eqIdx = manualEquipments.findIndex(eq => Math.sqrt((eq.x - p.x)**2 + (eq.y - p.y)**2) < 10);
      if (eqIdx >= 0) {
        setManualEquipments(manualEquipments.filter((_, idx) => idx !== eqIdx));
        setResult(null);
        return;
      }
      
      // Priority 2: Eraser Verandas
      const vIdx = verandas.findIndex(v => distToSegment(p, v.start, v.end) < 10);
      if (vIdx >= 0) {
        setVerandas(verandas.filter((_, i) => i !== vIdx));
        setResult(null);
        return;
      }

      // Priority 3: Eraser Buildings
      const bIdx = buildings.findIndex(b => pointInPolygon(p, b));
      if (bIdx >= 0) {
        setBuildings(buildings.filter((_, i) => i !== bIdx));
        // Also remove any Manual Equipments strictly attached to this building index
        setManualEquipments(manualEquipments.filter(eq => eq.bIdx !== bIdx));
        setResult(null);
      }
    }
  };

  const handleCanvasRightClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (mode === 'building' && currentPolygon.length > 2) {
      setBuildings([...buildings, currentPolygon]);
      setCurrentPolygon([]);
    } else if (mode === 'building') {
      setCurrentPolygon([]);
    } else if (mode === 'veranda' || mode === 'second_veranda' || mode === 'ruler') {
      setCurrentLineStart(null);
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMousePos({
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom
    });
  };

  const handleApplyRulerCalibration = () => {
    if (!rulerLine) return;
    const dx = rulerLine.end.x - rulerLine.start.x;
    const dy = rulerLine.end.y - rulerLine.start.y;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const meters = parseFloat(rulerInputMeters);
    if (isNaN(meters) || meters <= 0) {
      showAppNotification('유효한 거리 값을 입력해 주세요 (0보다 큰 숫자)', 'error');
      return;
    }
    const newPPM = distPx / meters;
    setParams(prev => ({ ...prev, pixelsPerMeter: parseFloat(newPPM.toFixed(3)) }));
    setRulerLine(null);
    setMode('idle');
    showAppNotification(`보정 완료: 스케일이 ${newPPM.toFixed(3)} Pixels/Meter 로 업데이트 되었습니다. (그려진 선: ${Math.round(distPx)}px = ${meters}m)`, 'success');
  };

  const clearDrawing = () => {
    setBuildings([]);
    setVerandas([]);
    setManualEquipments([]);
    setCurrentPolygon([]);
    setCurrentLineStart(null);
    setResult(null);
    setAiInsights(null);
  };

  const handleSaveTopology = () => {
    const topologyData = {
      buildings,
      verandas,
      manualEquipments,
      imageSrc,
      canvasSize: canvasSize,
      geoMapping
    };
    const blob = new Blob([JSON.stringify(topologyData, null, 2)], { type: "application/json" });
    saveAs(blob, "rf_topology_project.json");
  };

  const handleLoadTopology = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        if (json.buildings) setBuildings(json.buildings);
        if (json.verandas) setVerandas(json.verandas);
        if (json.manualEquipments) setManualEquipments(json.manualEquipments);
        if (json.geoMapping) setGeoMapping(json.geoMapping);
        else setGeoMapping(null);
        
        let targetWidth = 1000;
        let targetHeight = 1000;
        if (json.canvasSize) {
           targetWidth = json.canvasSize.width;
           targetHeight = json.canvasSize.height;
        } else {
           // Fallback to finding max bounds if no canvas size was saved
           let maxX = 1000; let maxY = 1000;
           (json.buildings || []).forEach((poly: any) => poly.forEach((p: any) => {
               if (p.x > maxX) maxX = p.x;
               if (p.y > maxY) maxY = p.y;
           }));
           (json.verandas || []).forEach((v: any) => {
               if (v.start.x > maxX) maxX = v.start.x;
               if (v.start.y > maxY) maxY = v.start.y;
               if (v.end.x > maxX) maxX = v.end.x;
               if (v.end.y > maxY) maxY = v.end.y;
           });
           targetWidth = Math.max(1000, maxX + 50);
           targetHeight = Math.max(1000, maxY + 50);
        }

        if (json.imageSrc) {
          const img = new Image();
          img.onload = () => {
            imageRef.current = img;
            setImageSrc(json.imageSrc);
            
            // Prioritize image size over saved canvas size to prevent mismatch
            const finalWidth = Math.max(targetWidth, img.width);
            const finalHeight = Math.max(targetHeight, img.height);
            setCanvasSize({width: finalWidth, height: finalHeight});
            if (canvasRef.current) {
              canvasRef.current.width = finalWidth;
              canvasRef.current.height = finalHeight;
            }
          };
          img.onerror = () => {
            console.warn("Failed to load image from saved topology (likely an expired blob URL). Continuing without image.");
            setImageSrc(null);
            imageRef.current = null;
            // Proceed with just the coordinates
            setCanvasSize({width: targetWidth, height: targetHeight});
            if (canvasRef.current) {
              canvasRef.current.width = targetWidth;
              canvasRef.current.height = targetHeight;
            }
          };
          img.src = json.imageSrc;
        } else {
          setImageSrc(null);
          setCanvasSize({width: targetWidth, height: targetHeight});
          if (canvasRef.current) {
            canvasRef.current.width = targetWidth;
            canvasRef.current.height = targetHeight;
          }
        }
        
        setResult(null);
        e.target.value = ''; // Reset input
      } catch (err) {
        console.error("Failed to parse topology JSON", err);
        showAppNotification("올바르지 않은 토폴로지 JSON 파일 구조입니다.", "error");
      }
    };
    reader.readAsText(file);
  };

  const handleVWorldSearch = async () => {
    if (!vworldKey.trim()) {
      showAppNotification("브이월드 인증키를 입력해주세요.", "warning");
      return;
    }
    if (!searchQuery.trim()) {
      showAppNotification("검색어를 입력해주세요. (예: 은마아파트, 반포자이)", "warning");
      return;
    }

    setIsSearching(true);
    setErrorMessage('');

    try {
      localStorage.setItem('vworld_api_key', vworldKey.trim());
      localStorage.setItem('vworld_api_domain', vworldDomain.trim());
      localStorage.setItem('vworld_request_mode', vworldRequestMode);
      const encodeQuery = encodeURIComponent(searchQuery);
      // VWorld Search API 2.0 (place type search)
      const url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=15&query=${encodeQuery}&type=place&format=json&key=${vworldKey.trim()}&domain=${encodeURIComponent(vworldDomain.trim())}`;
      
      let data: any;
      let usedMode = vworldRequestMode;

      try {
        if (usedMode === 'direct') {
          data = await fetchJSONP(url);
        } else {
          const targetFetchUrl = `/api/vworld-proxy?url=${encodeURIComponent(url)}`;
          const res = await fetch(targetFetchUrl);
          if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Server Proxy returned status ${res.status}: ${errorText.substring(0, 100)}`);
          }
          const text = await res.text();
          data = JSON.parse(text);
        }
      } catch (firstErr: any) {
        console.warn("Primary fetch option failed, trying fallback mode...", firstErr);
        const fallbackMode = usedMode === 'direct' ? 'proxy' : 'direct';
        try {
          if (fallbackMode === 'direct') {
            data = await fetchJSONP(url);
          } else {
            const targetFetchUrl = `/api/vworld-proxy?url=${encodeURIComponent(url)}`;
            const res = await fetch(targetFetchUrl);
            if (!res.ok) {
              const errorText = await res.text();
              throw new Error(`Server Proxy returned status ${res.status}: ${errorText.substring(0, 100)}`);
            }
            const text = await res.text();
            data = JSON.parse(text);
          }
        } catch (secondErr: any) {
          console.warn("Alternative fallback failed, attempting public CORS proxy as final resort...", secondErr);
          try {
            // Bypass both local CORS restrictions and Cloud Run sandbox IP bans via public CORS proxy
            const publicProxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
            const res = await fetch(publicProxyUrl);
            if (!res.ok) {
              throw new Error(`Public proxy returned status ${res.status}`);
            }
            const text = await res.text();
            data = JSON.parse(text);
          } catch (thirdErr: any) {
            throw new Error(
              `검색 호출이 완전히 실패했습니다.\n\n` +
              `1. 기본 호출(${usedMode}) 제한: ${firstErr.message}\n` +
              `2. 대체 호출(${fallbackMode}) 제한: ${secondErr.message}\n` +
              `3. 외부 CORS 우회 프록시 제한: ${thirdErr.message}\n\n` +
              `[해결방법] 브이월드 개발자 센터(vworld.kr) 내 인증키 설정에서 '등록도메인'에 현재 도메인 '${window.location.hostname}' 또는 '${window.location.origin}'이 올바르게 추가되어 있는지 확인하고 사용해 주세요.`
            );
          }
        }
      }

      if (data.response && data.response.status === 'OK' && data.response.result) {
        let items = data.response.result.items || [];
        if (!Array.isArray(items)) {
          items = [items];
        }
        if (items.length > 0) {
          handleSelectCandidate(items[0]);
        } else {
          setErrorMessage('검색 결과가 없습니다.');
        }
      } else {
        const rawError = data.response?.error;
        const errorMsg = rawError ? extractVworldErrorMessage(rawError) : '검색 결과가 없습니다.';
        setErrorMessage(errorMsg);
      }
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || String(err));
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectCandidate = async (candidate: any) => {
    if (!candidate.point || !candidate.point.x || !candidate.point.y) {
      showAppNotification("검색된 객체에 좌표 정보가 없습니다.", "warning");
      return;
    }

    setIsFetchingPolygons(true);
    const lon = Number(candidate.point.x);
    const lat = Number(candidate.point.y);

    // Fixed bbox calculation (approx 800 meters radius)
    const fixedRadius = 800;
    const deltaLon = fixedRadius / 88000;
    const deltaLat = fixedRadius / 111000;

    const minLon = lon - deltaLon;
    const maxLon = lon + deltaLon;
    const minLat = lat - deltaLat;
    const maxLat = lat + deltaLat;

    const geomFilter = `BOX(${minLon},${minLat},${maxLon},${maxLat})`;
    const cleanTitle = stripHtml(candidate.title || '');
    const coreName = extractCoreApartmentName(candidate.title, searchQuery);

    try {
      const fetchVWorldData = async (url: string) => {
        let usedMode = vworldRequestMode;
        try {
          if (usedMode === 'direct') {
            return await fetchJSONP(url);
          } else {
            const targetFetchUrl = `/api/vworld-proxy?url=${encodeURIComponent(url)}`;
            const res = await fetch(targetFetchUrl);
            if (!res.ok) throw new Error(`Proxy error ${res.status}`);
            return JSON.parse(await res.text());
          }
        } catch (firstErr: any) {
          const fallbackMode = usedMode === 'direct' ? 'proxy' : 'direct';
          try {
            if (fallbackMode === 'direct') {
              return await fetchJSONP(url);
            } else {
              const targetFetchUrl = `/api/vworld-proxy?url=${encodeURIComponent(url)}`;
              const res = await fetch(targetFetchUrl);
              if (!res.ok) throw new Error(`Proxy error ${res.status}`);
              return JSON.parse(await res.text());
            }
          } catch (secondErr: any) {
            try {
              const publicProxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
              const res = await fetch(publicProxyUrl);
              if (!res.ok) throw new Error(`Public proxy error ${res.status}`);
              return JSON.parse(await res.text());
            } catch (thirdErr: any) {
              throw new Error(
                `건물 폴리곤 정보 로드가 완전히 실패했습니다.\n\n` +
                `1. 기본 호출(${usedMode}) 제한: ${firstErr.message}\n` +
                `2. 대체 호출(${fallbackMode}) 제한: ${secondErr.message}\n` +
                `3. 외부 CORS 우회 프록시 제한: ${thirdErr.message}\n\n` +
                `[해결방법] 브이월드 개발자 센터(vworld.kr) 내 인증키 설정에서 '등록도메인'에 현재 도메인 '${window.location.origin}'이 올바르게 추가되어 있는지 확인하고 사용해 주세요.`
              );
            }
          }
        }
      };

      let rawFeatures: any[] = [];
      let currentPage = 1;
      let hasMore = true;
      let apiStatus = '';
      let apiError: any = null;

      while (hasMore) {
        const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_SPBD&key=${vworldKey.trim()}&format=json&crs=EPSG:4326&size=1000&page=${currentPage}&geomFilter=${geomFilter}&domain=${encodeURIComponent(vworldDomain.trim())}`;
        const data = await fetchVWorldData(url);
        
        if (data.response && data.response.status === 'OK' && data.response.result) {
          apiStatus = 'OK';
          const featureCollection = data.response.result.featureCollection;
          if (featureCollection && featureCollection.features && featureCollection.features.length > 0) {
            rawFeatures = rawFeatures.concat(featureCollection.features);
            if (featureCollection.features.length < 1000 || currentPage >= 4) { // Max 4000 buildings
              hasMore = false;
            } else {
              currentPage++;
            }
          } else {
            hasMore = false;
          }
        } else if (data.response && data.response.status === 'NOT_FOUND') {
          apiStatus = 'NOT_FOUND';
          hasMore = false;
        } else {
          apiStatus = data.response?.status || 'ERROR';
          apiError = data.response?.error;
          hasMore = false;
        }
      }

      if (rawFeatures.length > 0) {
        // Helper function to calculate distance from clicked center in meters
        const getFeatureDistance = (f: any) => {
          let samplePoint: number[] | null = null;
          if (f.geometry && f.geometry.type === 'Polygon' && f.geometry.coordinates[0]) {
              samplePoint = f.geometry.coordinates[0][0];
            } else if (f.geometry && f.geometry.type === 'MultiPolygon' && f.geometry.coordinates[0] && f.geometry.coordinates[0][0]) {
              samplePoint = f.geometry.coordinates[0][0][0];
            }
            if (!samplePoint) return Infinity;
            const dx = (samplePoint[0] - lon) * 88000;
            const dy = (samplePoint[1] - lat) * 111000;
            return Math.sqrt(dx * dx + dy * dy);
          };

          // Attach distance
          const featuresWithDist = rawFeatures.map((f: any) => ({
            feature: f,
            dist: getFeatureDistance(f)
          }));

          let filteredFeatures: any[] = [];
          let filterAppliedMessage = '';

          // 1. Try to find features that match the name first (if coreName is valid)
          let nameMatchedFeatures: any[] = [];
          if (coreName && coreName.length >= 2) {
            nameMatchedFeatures = featuresWithDist.filter((item: any) => {
              const bName = getBuildingNameFromProperties(item.feature.properties);
              if (!bName) return false;
              const cleanBName = bName.replace(/\s+/g, '');
              const cleanCore = coreName.replace(/\s+/g, '');
              return cleanBName.includes(cleanCore) || cleanCore.includes(cleanBName);
            });
          }

          if (nameMatchedFeatures.length > 0) {
            filteredFeatures = nameMatchedFeatures.map(x => x.feature);
            filterAppliedMessage = `(검색어 단지명 매칭: 일치 건물 ${filteredFeatures.length}개 로드)`;
          } else {
             // 2. Heuristic: find the most common building name among the closest buildings (< 200m)
             const veryCloseFeatures = featuresWithDist.filter((item: any) => item.dist <= 200);
             if (veryCloseFeatures.length > 0) {
                 const nameCounts: Record<string, number> = {};
                 veryCloseFeatures.forEach((item: any) => {
                     const bName = getBuildingNameFromProperties(item.feature.properties);
                     if (bName && bName.length > 1) { // ignore empty or 1-char names
                         nameCounts[bName] = (nameCounts[bName] || 0) + 1;
                     }
                 });
                 
                 let bestName = '';
                 let bestCount = 0;
                 for (const [name, count] of Object.entries(nameCounts)) {
                     if (count > bestCount) {
                         bestCount = count;
                         bestName = name;
                     }
                 }

                 if (bestName && bestCount >= 1) {
                     // Found a dominant building name near the center! Select ALL buildings in the 800m radius with this name!
                     const matchingNameFeatures = featuresWithDist.filter((item: any) => {
                         const bName = getBuildingNameFromProperties(item.feature.properties);
                         return bName === bestName;
                     });
                     
                     // Also include very close buildings that might lack a name, just in case they are part of the core complex.
                     const coreRadiusFeatures = featuresWithDist.filter((item: any) => item.dist <= 100);
                     const combined = new Set([...matchingNameFeatures, ...coreRadiusFeatures]);
                     
                     filteredFeatures = Array.from(combined).map((x: any) => x.feature);
                     filterAppliedMessage = `(자동 추론 매칭 [${bestName}]: 건물 ${filteredFeatures.length}개 로드)`;
                 }
             }

             // 3. Fallback if still empty
             if (filteredFeatures.length === 0) {
                const maxAllowedDistance = 250; // Capture more of the complex if we really have no name
                const closeFeatures = featuresWithDist.filter((item: any) => item.dist <= maxAllowedDistance);
                if (closeFeatures.length > 0) {
                  filteredFeatures = closeFeatures.map(x => x.feature);
                  filterAppliedMessage = `(근접 매칭: 반경 ${maxAllowedDistance}m 이내 건물 ${filteredFeatures.length}개 로드)`;
                } else {
                  const sortedByDist = [...featuresWithDist].sort((a: any, b: any) => a.dist - b.dist);
                  filteredFeatures = sortedByDist.slice(0, 15).map(x => x.feature);
                  filterAppliedMessage = `(최근접 매칭: 건물 ${filteredFeatures.length}개 로드)`;
                }
             }
          }

          let localMinLon = Infinity, localMinLat = Infinity, localMaxLon = -Infinity, localMaxLat = -Infinity;
          
          filteredFeatures.forEach((f: any) => {
            if (f.geometry && f.geometry.type === 'Polygon') {
              f.geometry.coordinates[0].forEach((coord: number[]) => {
                localMinLon = Math.min(localMinLon, coord[0]);
                localMinLat = Math.min(localMinLat, coord[1]);
                localMaxLon = Math.max(localMaxLon, coord[0]);
                localMaxLat = Math.max(localMaxLat, coord[1]);
              });
            } else if (f.geometry && f.geometry.type === 'MultiPolygon') {
              f.geometry.coordinates.forEach((poly: number[][][]) => {
                poly[0].forEach((coord: number[]) => {
                  localMinLon = Math.min(localMinLon, coord[0]);
                  localMinLat = Math.min(localMinLat, coord[1]);
                  localMaxLon = Math.max(localMaxLon, coord[0]);
                  localMaxLat = Math.max(localMaxLat, coord[1]);
                });
              });
            }
          });

          if (localMinLon === Infinity) {
             throw new Error("가져온 건물 폴리곤에 올바른 공간 좌표 데이터가 포함되어 있지 않습니다.");
          }

          const lonRange = (localMaxLon - localMinLon) || 0.0001;
          const latRange = (localMaxLat - localMinLat) || 0.0001;
          const cWidth = 1200; 
          const cHeight = 800;

          const parsedBuildings: Polygon[] = [];
          filteredFeatures.forEach((f: any) => {
               if (f.geometry && f.geometry.type === 'Polygon') {
                    const poly = f.geometry.coordinates[0].map((coord: number[]) => {
                         const x = ((coord[0] - localMinLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
                         const y = cHeight - (((coord[1] - localMinLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1)); 
                         return {x, y};
                    });
                    parsedBuildings.push(poly);
               } else if (f.geometry && f.geometry.type === 'MultiPolygon') {
                    f.geometry.coordinates.forEach((multiPoly: number[][][]) => {
                         const poly = multiPoly[0].map((coord: number[]) => {
                              const x = ((coord[0] - localMinLon) / lonRange) * (cWidth * 0.8) + (cWidth * 0.1);
                              const y = cHeight - (((coord[1] - localMinLat) / latRange) * (cHeight * 0.8) + (cHeight * 0.1)); 
                              return {x, y};
                         });
                         parsedBuildings.push(poly);
                    });
               }
          });

          setCanvasSize({width: cWidth, height: cHeight});
          setImageSrc(null); 
          imageRef.current = null;
          setBuildings(parsedBuildings);
          setVerandas([]); 
          setManualEquipments([]);
          setResult(null);
          setMode('idle');
          setGeoMapping({
            minLon: localMinLon,
            minLat: localMinLat,
            lonRange,
            latRange,
            cWidth,
            cHeight
          });

          // Calculate precise physical scale
          const spanMeters = lonRange * 88000;
          const mapWidthPx = cWidth * 0.8;
          const calculatedPPM = Number((mapWidthPx / spanMeters).toFixed(3));
          setParams(prev => ({ ...prev, pixelsPerMeter: calculatedPPM }));

          if (canvasRef.current) {
            canvasRef.current.width = cWidth;
            canvasRef.current.height = cHeight;
          }

          showAppNotification(`성공적으로 ${parsedBuildings.length}개의 건물 폴리곤을 가져와 시뮬레이션 보드에 배치했습니다! ${filterAppliedMessage}`, "success");
        } else if (apiStatus === 'NOT_FOUND') {
          showAppNotification(`해당 검색 영역 내에 로드할 수 있는 건물 데이터가 존재하지 않습니다. 다른 레이어를 선택하거나 검색어를 변경해보세요.`, "warning");
        } else if (apiStatus === 'ERROR' || apiError) {
          const errorMsg = apiError ? extractVworldErrorMessage(apiError) : '건물 데이터를 가져오지 못했습니다. API 제한량 또는 인증키 설정을 확인하세요.';
          showAppNotification(`인식 에러: ${errorMsg}`, "error");
        } else {
          showAppNotification(`해당 영역 또는 단지 조건(${coreName || cleanTitle})으로 가져온 건물 데이터가 레이어에 없습니다. 레이어를 변경하거나 필터를 끄고 다시 로드해 보세요.`, "warning");
        }
    } catch (err: any) {
      console.error(err);
      showAppNotification(`폴리곤 로드에 실패했습니다: ${err.message}`, "error");
    } finally {
      setIsFetchingPolygons(false);
    }
  };

  const handleExportGeoJSON = () => {
    if (buildings.length === 0 && verandas.length === 0) {
      showAppNotification("내보낼 데이터(건물 또는 베란다)가 없습니다.", "warning");
      return;
    }

    const features: any[] = [];

    // Fallback if no geoMapping coordinates are set
    const mapping = geoMapping || {
      minLon: 127.0276,
      minLat: 37.4979,
      lonRange: 0.005,
      latRange: 0.004,
      cWidth: canvasSize.width,
      cHeight: canvasSize.height
    };

    const canvasToLonLat = (p: Point) => {
      const lon = mapping.minLon + mapping.lonRange * ((p.x - mapping.cWidth * 0.1) / (mapping.cWidth * 0.8));
      const lat = mapping.minLat + mapping.latRange * ((mapping.cHeight - p.y - mapping.cHeight * 0.1) / (mapping.cHeight * 0.8));
      return [lon, lat];
    };

    // 1. Export Buildings as GeoJSON Polygon Features
    buildings.forEach((poly, idx) => {
      if (poly.length === 0) return;
      const coords = poly.map(canvasToLonLat);
      // Close coordinates polygon loop
      if (coords.length > 0 && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
        coords.push([coords[0][0], coords[0][1]]);
      }
      features.push({
        type: "Feature",
        properties: {
          id: `building-${idx + 1}`,
          type: "building",
          name: `건물_${idx + 1}동`
        },
        geometry: {
          type: "Polygon",
          coordinates: [coords]
        }
      });
    });

    // 2. Export Verandas as a single MultiLineString feature
    if (verandas.length > 0) {
      const lineStrings = verandas.map(line => [
        canvasToLonLat(line.start),
        canvasToLonLat(line.end)
      ]);
      features.push({
        type: "Feature",
        properties: {
          type: "veranda",
          name: "베란다 MultiLine"
        },
        geometry: {
          type: "MultiLineString",
          coordinates: lineStrings
        }
      });
    }

    const geoJsonData = {
      type: "FeatureCollection",
      features: features
    };

    const blob = new Blob([JSON.stringify(geoJsonData, null, 2)], { type: "application/json" });
    saveAs(blob, "rf_topology_geojson.json");
  };

  const handleEvaluateCurrent = () => {
    setIsSimulating(true);
    setResult(null);
    setAiInsights(null);
    setTimeout(() => {
      // Set targetCoverage to 0 to skip automatic generation and just evaluate manually placed ones
      const res = runSimulation(buildings, verandas, {...params, targetCoverage: 0}, manualEquipments);
      setResult(res);
      setIsSimulating(false);
    }, 50);
  };

  const handleRunSimulation = () => {
    setIsSimulating(true);
    setResult(null);
    setAiInsights(null);
    setTimeout(() => {
      const res = runSimulation(buildings, verandas, params, manualEquipments);
      setResult(res);
      setIsSimulating(false);
    }, 50);
  };

  const handleDownloadReport = async () => {
    if (!result || !canvasRef.current) return;
    
    const zip = new JSZip();
    
    // 1. Add Canvas Image
    const canvas = canvasRef.current;
    const imgDataUrl = canvas.toDataURL("image/png");
    const imgData = imgDataUrl.split(',')[1];
    zip.file("simulation_result.png", imgData, { base64: true });

    // 2. Add Logs
    const logText = result.logs.map(l => `[${new Date().toLocaleTimeString()}] ${l.message}`).join('\n');
    const finalReport = `Simulation Configuration:\n` +
                        `Beam Width: ${params.beamWidth}°\n` + 
                        `Max Range: ${params.maxRange}m\n` +
                        `Target Coverage: ${params.targetCoverage}%\n` +
                        `Strict Co-Location: ${params.strictCoLocation}\n\n` +
                        `--- LOGS ---\n${logText}\n\n` +
                        `--- AI INSIGHTS ---\n${aiInsights || 'No insights generated.'}`;
    
    zip.file("simulation_report.txt", finalReport);
    
    // 3. Generate and Download ZIP
    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, "rf_simulation_results.zip");
  };

  const updateEqAngle = (id: string, newAngle: number) => {
      const target = manualEquipments.find(eq => eq.id === id);
      if (!target) return;
      
      const coLocated = manualEquipments.filter(eq => eq.id !== id && Math.sqrt((eq.x - target.x)**2 + (eq.y - target.y)**2) < 2);
      
      let isValidChange = true;
      for (const other of coLocated) {
          let diff = Math.abs(other.angle - newAngle);
          diff = diff > 180 ? 360 - diff : diff;
          if (diff < 80) {
              isValidChange = false;
              break;
          }
      }
      
      if (!isValidChange) {
          showAppNotification("동일 위치 장비 간의 각도 이격 거리는 최소 80도 이상이어야 합니다. (중복/간섭 방지)", "warning");
          return;
      }
      
      setManualEquipments(manualEquipments.map(eq => eq.id === id ? { ...eq, angle: newAngle } : eq));
      setResult(null);
      setAiInsights(null);
  };

  const deleteEq = (id: string) => {
      setManualEquipments(manualEquipments.filter(eq => eq.id !== id));
      setResult(null);
      setAiInsights(null);
  };
  
  const handleGenerateAIInsights = async () => {
      if (!result) return;
      setIsGeneratingInsights(true);
      setAiInsights("");
      try {
          const res = await fetch("/api/ai-insights", {
              method: "POST",
              headers: {
                  "Content-Type": "application/json"
              },
              body: JSON.stringify({ result, params })
          });
          const data = await res.json();
          if (data.error) {
              setAiInsights(`Failed to generate AI insights: ${data.error}`);
          } else {
              setAiInsights(data.text || "Insights loaded.");
          }
      } catch (e: any) {
          console.error(e);
          setAiInsights("Failed to generate AI insights: " + e.message + "\nPlease check your network or server configuration.");
      } finally {
          setIsGeneratingInsights(false);
      }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (imageRef.current) {
      ctx.drawImage(imageRef.current, 0, 0, canvas.width, canvas.height);
    }

    buildings.forEach((poly, bIdx) => {
      ctx.beginPath();
      poly.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(0, 150, 255, 0.4)';
      ctx.fill();
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Render per-building coverage logic
      if (result && result.buildingCoverages) {
          const bCov = result.buildingCoverages.find((bc: any) => bc.bIdx === bIdx);
          if (bCov) {
              let cx = 0, cy = 0;
              poly.forEach(p => { cx += p.x; cy += p.y; });
              cx /= poly.length;
              cy /= poly.length;

              ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
              ctx.beginPath();
              
              const hasBonus = bCov.secondCovered && bCov.secondCovered > 0;
              const boxWidth = hasBonus ? 84 : 48;
              const boxHeight = hasBonus ? 32 : 22;
              
              ctx.roundRect(cx - (boxWidth / 2), cy - (boxHeight / 2), boxWidth, boxHeight, 5);
              ctx.fill();

              ctx.fillStyle = bCov.ratio >= 90 ? '#00e676' : bCov.ratio >= 50 ? '#ffb300' : '#ff5252';
              ctx.font = 'bold 11px Inter';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              
              if (hasBonus) {
                  ctx.fillText(`${Math.round(bCov.ratio)}%`, cx, cy - 6);
                  ctx.fillStyle = '#29b6f6';
                  ctx.font = 'bold 9px Inter';
                  ctx.fillText(`+${bCov.secondCovered}m 보너스`, cx, cy + 7);
              } else {
                  ctx.fillText(`${Math.round(bCov.ratio)}%`, cx, cy);
              }
          }
      }
    });

    if (currentPolygon.length > 0) {
      ctx.beginPath();
      currentPolygon.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (mousePos) {
        ctx.lineTo(mousePos.x, mousePos.y);
      }
      ctx.strokeStyle = '#00ff00';
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Second Verandas (long building walls, dashed blue-cyan)
    const secondVerandas = getSecondVerandas(buildings);
    secondVerandas.forEach(line => {
      ctx.beginPath();
      ctx.moveTo(line.start.x, line.start.y);
      ctx.lineTo(line.end.x, line.end.y);
      ctx.strokeStyle = '#29b6f6'; 
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    verandas.forEach(line => {
      ctx.beginPath();
      ctx.moveTo(line.start.x, line.start.y);
      ctx.lineTo(line.end.x, line.end.y);
      if (line.isSecond) {
        ctx.strokeStyle = '#29b6f6';
        ctx.lineWidth = 3.5;
        ctx.lineCap = 'round';
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = '#ffb300';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    });

    if (currentLineStart && mousePos) {
      ctx.beginPath();
      ctx.moveTo(currentLineStart.x, currentLineStart.y);
      ctx.lineTo(mousePos.x, mousePos.y);
      if (mode === 'second_veranda') {
        ctx.strokeStyle = '#29b6f6';
        ctx.lineWidth = 3.5;
        ctx.lineCap = 'round';
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (mode === 'ruler') {
        ctx.strokeStyle = '#ff3d00';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(currentLineStart.x, currentLineStart.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3d00';
        ctx.fill();

        const dx = mousePos.x - currentLineStart.x;
        const dy = mousePos.y - currentLineStart.y;
        const distPx = Math.sqrt(dx * dx + dy * dy);
        
        ctx.save();
        ctx.fillStyle = 'rgba(15, 15, 20, 0.9)';
        ctx.strokeStyle = 'rgba(255, 61, 0, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(mousePos.x + 14, mousePos.y + 14, 110, 26, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`길이: ${Math.round(distPx)} px`, mousePos.x + 69, mousePos.y + 27);
        ctx.restore();
      } else {
        ctx.strokeStyle = '#ffb300';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.setLineDash([8, 8]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    const activeEquipments = result ? result.equipments : manualEquipments;
    const isSimulated = !!result;

    const pciColors = [
      { fill: 'rgba(0, 229, 255, 0.14)', stroke: 'rgba(0, 229, 255, 0.4)', base: '#0288d1', stream: 'rgba(0, 229, 255, 0.28)' },   // Cyan
      { fill: 'rgba(255, 64, 129, 0.14)', stroke: 'rgba(255, 64, 129, 0.4)', base: '#f50057', stream: 'rgba(255, 64, 129, 0.28)' }, // Pink
      { fill: 'rgba(0, 230, 118, 0.14)', stroke: 'rgba(0, 230, 118, 0.4)', base: '#00c853', stream: 'rgba(0, 230, 118, 0.28)' }, // Green
      { fill: 'rgba(255, 152, 0, 0.14)', stroke: 'rgba(255, 152, 0, 0.4)', base: '#ff9100', stream: 'rgba(255, 152, 0, 0.28)' }, // Orange
      { fill: 'rgba(213, 0, 249, 0.14)', stroke: 'rgba(213, 0, 249, 0.4)', base: '#d500f9', stream: 'rgba(213, 0, 249, 0.28)' }, // Purple
      { fill: 'rgba(255, 234, 0, 0.14)', stroke: 'rgba(255, 234, 0, 0.4)', base: '#fbc02d', stream: 'rgba(255, 234, 0, 0.28)' }, // Yellow
    ];

    const getPciColor = (eqId: string, isSim: boolean) => {
      const match = eqId.match(/\d+/);
      let num = match ? parseInt(match[0], 10) : 1;
      const theme = pciColors[(num - 1) % pciColors.length];
      if (!isSim) {
        return {
          fill: theme.fill.replace('0.14', '0.2'), 
          stroke: theme.stroke.replace('0.4', '0.6'),
          base: theme.base,
          stream: theme.stream
        };
      }
      return theme;
    };

    // 1. Draw Sector Beams first
    activeEquipments.forEach((eq) => {
      const pciColor = getPciColor(eq.id, isSimulated);
      const angleRad = (eq.angle - 90) * Math.PI / 180;
      const beamHalfConf = (params.beamWidth / 2) * Math.PI / 180;
      const mainStart = angleRad - beamHalfConf;
      const mainEnd = angleRad + beamHalfConf;
      const radius = params.maxRange * params.pixelsPerMeter * 0.4; // 40% size visual beam

      ctx.beginPath();
      ctx.moveTo(eq.x, eq.y);
      ctx.arc(eq.x, eq.y, radius, mainStart, mainEnd);
      ctx.closePath();
      ctx.fillStyle = pciColor.fill;
      ctx.fill();
      ctx.strokeStyle = pciColor.stroke;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });

    if (result) {
      // 2. Draw Connection Lines (faint beam stream lines)
      result.equipments.forEach((eq) => {
        const pciColor = getPciColor(eq.id, true);
        if (eq.coveredPoints && eq.coveredPoints.length > 0) {
          ctx.beginPath();
          eq.coveredPoints.forEach(p => {
             ctx.moveTo(eq.x, eq.y);
             ctx.lineTo(p.x, p.y);
          });
          ctx.strokeStyle = pciColor.stream; // visible faint stream line
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      });

      // 3. Draw standard (1st) veranda covered points (Green)
      ctx.fillStyle = '#00e676';
      result.coveredSamples.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // 4. Draw Second veranda covered points (Cyan / Skyblue - 표시만)
      if (result.secondCoveredSamples) {
        ctx.fillStyle = '#29b6f6';
        result.secondCoveredSamples.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }

    // 5. Draw Bracket Arms & Sector Icons
    activeEquipments.forEach((eq) => {
      const angleRad = (eq.angle - 90) * Math.PI / 180;
      const offsetDist = 18; // Offset 18px towards steering angle
      const iconX = eq.x + Math.cos(angleRad) * offsetDist;
      const iconY = eq.y + Math.sin(angleRad) * offsetDist;

      // Draw sturdy bracket arm
      ctx.beginPath();
      ctx.moveTo(eq.x, eq.y);
      ctx.lineTo(iconX, iconY);
      ctx.strokeStyle = '#27272a'; // dark zinc sturdy line
      ctx.lineWidth = 2.2;
      ctx.stroke();

      const pciColor = getPciColor(eq.id, isSimulated);

      // Draw sector circle
      ctx.beginPath();
      ctx.arc(iconX, iconY, 11, 0, Math.PI * 2); // 11px radius (highly legible)
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = pciColor.base;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Sector Shortened Label (such as 1-A, 2-C, etc.)
      ctx.fillStyle = '#09090b';
      ctx.font = 'bold 9px Inter';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelText = eq.id.replace('AUTO-', '').replace('M-', '');
      ctx.fillText(labelText, iconX, iconY);
    });

    // 6. Draw central masts/holding poles (Tower base dots)
    const uniquePoles = new Map<string, Point>();
    activeEquipments.forEach((eq) => {
      const key = `${Math.round(eq.x)},${Math.round(eq.y)}`;
      if (!uniquePoles.has(key)) {
        uniquePoles.set(key, { x: eq.x, y: eq.y });
      }
    });

    uniquePoles.forEach((pos) => {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#18181b';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // 7. Draw dynamic Scale Bar Overlay
    if (params.pixelsPerMeter && canvas.width > 200 && canvas.height > 150) {
      const getNiceScaleDistance = (ppm: number): number => {
        const targetPx = 120;
        const targetMeters = targetPx / ppm;
        const niceDistances = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
        let bestDist = 100;
        let minDiff = Infinity;
        for (const d of niceDistances) {
          const diff = Math.abs(d - targetMeters);
          if (diff < minDiff) {
            minDiff = diff;
            bestDist = d;
          }
        }
        return bestDist;
      };

      const scaleMeters = getNiceScaleDistance(params.pixelsPerMeter);
      const scalePx = scaleMeters * params.pixelsPerMeter;
      const marginX = 25;
      const marginY = canvas.height - 25;
      
      ctx.save();
      ctx.fillStyle = 'rgba(15, 15, 20, 0.85)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(marginX - 10, marginY - 30, scalePx + 20, 42, 6);
      ctx.fill();
      ctx.stroke();
      
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(marginX, marginY - 10);
      ctx.lineTo(marginX, marginY - 2);
      ctx.lineTo(marginX + scalePx, marginY - 2);
      ctx.lineTo(marginX + scalePx, marginY - 10);
      ctx.stroke();
      
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px Inter';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${scaleMeters}m`, marginX + (scalePx / 2), marginY - 13);
      ctx.restore();
    }

  }, [imageSrc, buildings, verandas, currentPolygon, currentLineStart, mousePos, result, params, manualEquipments, mode]);

  return (
    <div className="flex h-screen bg-bg-main text-text-primary font-sans">
      {notification && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-[400px] px-4 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className={`p-3.5 rounded-lg shadow-2xl border flex items-start space-x-3 backdrop-blur bg-zinc-950/95 text-white ${
            notification.type === 'success' ? 'border-emerald-500/50 shadow-emerald-950/20' :
            notification.type === 'error' ? 'border-rose-500/50 shadow-rose-950/20' :
            notification.type === 'warning' ? 'border-amber-500/50 shadow-amber-950/20' :
            'border-cyan-500/50 shadow-cyan-950/20'
          }`}>
            <div className={`mt-0.5 rounded-full p-1 ${
              notification.type === 'success' ? 'text-emerald-400 bg-emerald-500/10' :
              notification.type === 'error' ? 'text-rose-400 bg-rose-500/10' :
              notification.type === 'warning' ? 'text-amber-400 bg-amber-500/10' :
              'text-cyan-400 bg-cyan-500/10'
            }`}>
              {notification.type === 'success' && <Check className="w-4 h-4" />}
              {notification.type === 'error' && <X className="w-4 h-4" />}
              {notification.type === 'warning' && <AlertTriangle className="w-4 h-4" />}
              {notification.type === 'info' && <Info className="w-4 h-4" />}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-xs font-semibold text-gray-100 leading-normal whitespace-pre-wrap">{notification.message}</p>
            </div>
            <button 
              onClick={() => setNotification(null)}
              className="text-gray-400 hover:text-white shrink-0 p-0.5 rounded hover:bg-white/5 transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {rulerLine && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4 min-h-screen">
          <div className="w-[440px] bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl p-5 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="flex items-center space-x-3 border-b border-zinc-900 pb-3 mb-4">
              <div className="p-2 bg-red-500/10 rounded-lg text-red-500">
                <Ruler className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">스케일 보정 (Ruler Calibration)</h3>
                <p className="text-[11px] text-gray-500 mt-0.5">그린 선의 길이 정보를 통해 정밀한 축척(Scale)을 설정합니다.</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 bg-zinc-900/60 p-3 rounded-lg border border-zinc-800/50">
                <div className="text-left">
                  <span className="text-[10px] text-gray-500 block uppercase">Drawn Vector Length</span>
                  <span className="text-sm font-mono font-bold text-[#ff3d00] mt-1 block">
                    {Math.round(Math.sqrt((rulerLine.end.x - rulerLine.start.x)**2 + (rulerLine.end.y - rulerLine.start.y)**2))} px
                  </span>
                </div>
                <div className="text-left">
                  <span className="text-[10px] text-gray-500 block uppercase">Current Scale</span>
                  <span className="text-sm font-mono font-bold text-sky-400 mt-1 block">
                    {params.pixelsPerMeter} Pix / m
                  </span>
                </div>
              </div>

              <div className="text-left space-y-1.5">
                <label className="text-xs text-gray-300 font-semibold block">방금 지도/이미지에 표시한 선의 실제 길이(m)</label>
                <div className="relative">
                  <input
                    type="number"
                    step="any"
                    value={rulerInputMeters}
                    onChange={(e) => setRulerInputMeters(e.target.value)}
                    className="w-full px-3 py-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:border-red-500 font-mono"
                    placeholder="예: 50"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleApplyRulerCalibration(); }}
                    autoFocus
                  />
                  <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-gray-500 font-bold">미터 (m)</span>
                </div>
                <p className="text-[10px] text-gray-400 leading-normal mt-1">
                  💡 <strong>팁</strong>: 업로드한 지도 캡처 이미지 구석의 축적선(Scale Bar, 예: 50m) 양끝을 클릭한 뒤, 입력란에 축척 숫자를 기입하시면 오차없이 가장 정밀한 시뮬레이션 결과가 도출됩니다.
                </p>
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => { setRulerLine(null); setMode('idle'); }}
                  className="flex-1 py-2 bg-zinc-900 hover:bg-zinc-800 text-xs text-gray-400 hover:text-white rounded-lg transition-all border border-zinc-800 hover:border-zinc-700 cursor-pointer"
                >
                  취소 (Cancel)
                </button>
                <button
                  type="button"
                  onClick={handleApplyRulerCalibration}
                  className="flex-1 py-1.5 bg-red-600 hover:bg-red-500 text-xs text-white rounded-lg font-bold transition-all hover:shadow-[0_0_15px_rgba(239,68,68,0.35)] cursor-pointer"
                >
                  보정 적용 (Set Scale)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="w-80 bg-bg-panel border-r border-border-color flex flex-col z-10">
        <div className="p-4 border-b border-border-color shrink-0">
          <h1 className="text-xl font-bold text-accent tracking-wide">RF-SIM [VER 1.0.4]</h1>
          <p className="text-sm text-text-secondary mt-1">Network Optimization Tool</p>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <section>
            <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">1. Base Map or GIS</h2>
            <div className="grid grid-cols-2 gap-2 mb-2">
                <label className="flex flex-col items-center justify-center w-full h-16 border border-border-color bg-bg-accent rounded cursor-pointer hover:bg-border-color transition-colors">
                  <Upload className="w-4 h-4 text-text-secondary mb-1" />
                  <span className="text-[10px] text-text-primary">Image (JPG/PNG)</span>
                  <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                </label>
                <label className="flex flex-col items-center justify-center w-full h-16 border border-border-color bg-bg-accent rounded cursor-pointer hover:bg-border-color transition-colors">
                  <Database className="w-4 h-4 text-text-secondary mb-1" />
                  <span className="text-[10px] text-text-primary">SHP (.zip)</span>
                  <input type="file" className="hidden" accept=".zip" onChange={handleShpUpload} />
                </label>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
               <button onClick={handleSaveTopology} className="w-full py-1.5 bg-bg-accent border border-border-color rounded text-xs text-text-secondary hover:text-white transition-colors flex items-center justify-center">
                 <Save className="w-3 h-3 mr-1" /> Save Topology
               </button>
               <label className="w-full py-1.5 bg-bg-accent border border-border-color rounded text-xs text-text-secondary hover:text-white transition-colors flex items-center justify-center cursor-pointer">
                 <FolderOpen className="w-3 h-3 mr-1" /> Load Topology
                 <input type="file" className="hidden" accept=".json" onChange={handleLoadTopology} />
               </label>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
               <button onClick={loadSampleData} className="w-full py-1.5 bg-gray-800 border border-border-color rounded text-xs text-text-secondary hover:text-white transition-colors flex items-center justify-center">
                 <Search className="w-3 h-3 mr-1" /> Sample Data
               </button>
               <button onClick={handleExportGeoJSON} className="w-full py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-warning hover:text-yellow-300 transition-colors flex items-center justify-center">
                 <Download className="w-3 h-3 mr-1" /> GeoJSON Export
               </button>
            </div>

            {/* VWorld Browser GIS Search Box */}
            <div className="border border-border-color rounded-lg p-3 bg-zinc-950/40 space-y-3 mt-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-accent tracking-wider uppercase flex items-center">
                  <RadioTower className="w-3.5 h-3.5 mr-1.5 animate-pulse" /> VWorld 아파트 검색
                </span>
                <span className="text-[9px] text-gray-500 font-mono">GetFeature 2.0</span>
              </div>
              
              <div className="space-y-2 text-xs">
                <div>
                  <label className="text-[10px] text-text-secondary block mb-0.5">VWorld 인증키</label>
                  <input 
                    type="password" 
                    placeholder="인증키가 없을 시 동작하지 않습니다" 
                    value={vworldKey} 
                    onChange={e => setVworldKey(e.target.value)} 
                    className="w-full px-2 py-1 bg-bg-accent border border-border-color rounded font-mono text-[11px] text-white focus:outline-none focus:border-accent"
                  />
                </div>

                <div>
                  <div className="flex justify-between items-center mb-0.5">
                    <label className="text-[10px] text-text-secondary">VWorld 등록 도메인</label>
                    <span className="text-[9px] text-[#00e5ff] font-mono select-all">접속도메인: {window.location.origin}</span>
                  </div>
                  <input 
                    type="text" 
                    placeholder="예: localhost 또는 현재 사이트 주소" 
                    value={vworldDomain} 
                    onChange={e => setVworldDomain(e.target.value)} 
                    className="w-full px-2 py-1 bg-bg-accent border border-border-color rounded font-mono text-[11px] text-white focus:outline-none focus:border-accent"
                  />
                  <p className="text-[9px] text-gray-400 mt-1 leading-normal">
                    💡 브이월드 오픈플랫폼에서 발급받은 인증키의 <strong>등록 도메인</strong> 정보와 완전히 일치해야 합니다. (자세한 주소: <span className="text-gray-300 select-all">{window.location.origin}</span>)
                  </p>
                </div>

                <div>
                  <label className="text-[10px] text-text-secondary block mb-1">API 호출 방식</label>
                  <div className="grid grid-cols-2 gap-1 bg-bg-accent p-0.5 rounded border border-border-color">
                    <button
                      type="button"
                      onClick={() => setVworldRequestMode('direct')}
                      className={`py-1 text-[10px] font-medium rounded transition-all ${vworldRequestMode === 'direct' ? 'bg-[#00e5ff] text-zinc-950 font-semibold shadow-sm' : 'text-text-secondary hover:text-white'}`}
                    >
                      직접 호출 (WAF 우회 권장)
                    </button>
                    <button
                      type="button"
                      onClick={() => setVworldRequestMode('proxy')}
                      className={`py-1 text-[10px] font-medium rounded transition-all ${vworldRequestMode === 'proxy' ? 'bg-[#00e5ff] text-zinc-950 font-semibold shadow-sm' : 'text-text-secondary hover:text-white'}`}
                    >
                      서버 프록시 경유
                    </button>
                  </div>
                  <p className="text-[9px] text-gray-400 mt-1 leading-normal">
                    💡 서버 IP 차단(502 Bad Gateway/Socket Hang Up)을 완벽 극복하려면, <strong>'직접 호출'</strong> 방식을 권장합니다.
                  </p>
                </div>

                <div className="pt-1">
                  <div className="flex justify-between items-center mb-0.5">
                    <label className="text-[10px] text-text-secondary block">아파트 단지명 자동 매칭 검색</label>
                    <span className="text-[9px] text-gray-500 font-mono">도로명건물 (LT_C_SPBD) 자동 사용</span>
                  </div>
                  <div className="flex space-x-1">
                    <input 
                      type="text" 
                      placeholder="예: 은마아파트, 반포자이" 
                      value={searchQuery} 
                      onChange={e => setSearchQuery(e.target.value)} 
                      onKeyDown={e => { if (e.key === 'Enter') handleVWorldSearch(); }}
                      className="flex-1 px-2 py-1 bg-bg-accent border border-border-color rounded text-[11px] text-white focus:outline-none focus:border-accent"
                    />
                    <button 
                      onClick={handleVWorldSearch} 
                      disabled={isSearching} 
                      className="px-2.5 bg-accent text-black rounded text-xs hover:bg-[#00e5ff]/90 transition-colors flex items-center justify-center cursor-pointer"
                    >
                      검색 및 로드
                    </button>
                  </div>
                </div>
              </div>

              {/* Status and Candidates list */}
              {isSearching && (
                <div className="text-[11px] text-accent flex items-center justify-center py-1 bg-bg-accent/30 rounded mt-2">
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> 단지 데이터 검색 및 가져오는 중...
                </div>
              )}

              {errorMessage && !isSearching && (
                <div className="text-[10px] text-red-400 p-1.5 bg-red-950/20 rounded border border-red-900/30 font-mono break-all leading-tight mt-2">
                  {errorMessage}
                </div>
              )}

              {isFetchingPolygons && (
                <div className="text-[11px] text-warning flex items-center justify-center py-1.5 bg-bg-accent/30 rounded border border-warning/10 animate-pulse mt-2">
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> 단지 건물 폴리곤 다운로드 중...
                </div>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">2. Draw Areas</h2>
            <div className="grid grid-cols-3 gap-2">
              <button 
                onClick={() => setMode('building')}
                className={`flex flex-col items-center p-2 rounded border ${mode === 'building' ? 'bg-bg-accent border-accent text-accent' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Square className="w-4.5 h-4.5 mb-1" />
                <span className="text-[10px] font-medium text-center leading-tight">Building</span>
              </button>
              <button 
                onClick={() => setMode('veranda')}
                className={`flex flex-col items-center p-2 rounded border ${mode === 'veranda' ? 'bg-bg-accent border-warning text-warning' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Minus className="w-4.5 h-4.5 mb-1" />
                <span className="text-[10px] font-medium text-center leading-tight">1st 베란다</span>
              </button>
              <button 
                onClick={() => setMode('second_veranda')}
                className={`flex flex-col items-center p-2 rounded border ${mode === 'second_veranda' ? 'bg-bg-accent border-[#29b6f6] text-[#29b6f6]' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Minus className="w-4.5 h-4.5 mb-1 rotate-45" />
                <span className="text-[10px] font-medium text-center leading-tight">2nd 베란다</span>
              </button>
              <button 
                onClick={() => setMode('equipment')}
                className={`flex flex-col items-center p-2 rounded border ${mode === 'equipment' ? 'bg-bg-accent border-[#ffb300] text-[#ffb300]' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <RadioTower className="w-4.5 h-4.5 mb-1" />
                <span className="text-[10px] font-medium text-center leading-tight">Place Site</span>
              </button>
              <button 
                onClick={() => setMode('ruler')}
                className={`flex flex-col items-center p-2 rounded border ${mode === 'ruler' ? 'bg-bg-accent border-[#ff3d00] text-[#ff3d00]' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Ruler className="w-4.5 h-4.5 mb-1" />
                <span className="text-[10px] font-medium text-center leading-tight">스케일 보정</span>
              </button>
              <button 
                onClick={() => setMode('eraser')}
                className={`flex flex-col items-center p-2 rounded border ${mode === 'eraser' ? 'bg-bg-accent border-error text-error' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Eraser className="w-4.5 h-4.5 mb-1" />
                <span className="text-[10px] font-medium text-center leading-tight">Eraser</span>
              </button>
            </div>
            <p className="text-xs text-text-secondary mt-2">
              {mode === 'building' && "Click to add points. Right-click to finish polygon."}
              {mode === 'veranda' && "Click start and end points to draw a standard (1등급) veranda."}
              {mode === 'second_veranda' && "Click start and end points to draw a second (2등급, 70% 가중치) veranda."}
              {mode === 'equipment' && "Click on the map/building edges to place a co-located 3-sector site."}
              {mode === 'ruler' && "지도 축척선(Scale bar)의 양끝을 클릭하여 선을 그린 뒤 실제 거리를 입력하세요!"}
              {mode === 'eraser' && "Click on a building, veranda, or site to remove it."}
              {mode === 'idle' && "Select a tool to start drawing."}
            </p>
            
            <div className="mt-3.5 pt-2 border-t border-zinc-800 space-y-1.5 text-[10px]">
              <div className="flex items-center justify-between text-text-secondary mb-1">
                <span className="font-semibold uppercase tracking-wider text-[9px]">Simulation Targets</span>
              </div>
              <div className="flex items-center space-x-2">
                <span className="w-4 h-1.5 bg-[#ffb300] rounded"></span>
                <span className="text-gray-300">베란다 (Primary : 100% 점수)</span>
              </div>
              <div className="flex items-center space-x-2">
                <span className="w-4 h-1 border-t-2 border-dashed border-[#29b6f6]"></span>
                <span className="text-gray-300">Second 베란다 (긴 벽면 : 70% 점수)</span>
              </div>
              <div className="flex items-center space-x-2">
                <span className="w-1.5 h-1.5 bg-gray-500 rounded-full"></span>
                <span className="text-zinc-500">짧은 측면 벽 (콘크리트 : 노카운트)</span>
              </div>
            </div>

            <button onClick={clearDrawing} className="mt-3 text-xs text-text-secondary hover:text-text-primary flex items-center">
              <RotateCcw className="w-3 h-3 mr-1" /> Clear All Drawings
            </button>
          </section>

          <section>
            <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">3. Parameters</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-text-secondary block mb-1">Pixels per Meter (Scale)</label>
                <input type="number" value={params.pixelsPerMeter} onChange={e => setParams({...params, pixelsPerMeter: Number(e.target.value)})} className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-white font-mono" />
              </div>
              <div>
                <label className="text-xs text-text-secondary block mb-1">Target Coverage (%)</label>
                <input type="number" value={params.targetCoverage} onChange={e => setParams({...params, targetCoverage: Number(e.target.value)})} className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-white font-mono" />
              </div>
              <div>
                <label className="text-xs text-text-secondary block mb-1">Beam Width (°)</label>
                <input type="number" value={params.beamWidth} onChange={e => setParams({...params, beamWidth: Number(e.target.value)})} className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-white font-mono" />
              </div>
              <div>
                <label className="text-xs text-text-secondary block mb-1">Max Range (m) <span className="text-[10px] text-accent">(Beam Radius)</span></label>
                <input type="number" value={params.maxRange} onChange={e => setParams({...params, maxRange: Number(e.target.value)})} className="w-full px-3 py-2 bg-bg-accent border border-border-color rounded text-sm text-white font-mono" />
              </div>
              <div className="flex items-center space-x-2 pt-1">
                <input type="checkbox" id="strictCo" checked={params.strictCoLocation} onChange={e => setParams({...params, strictCoLocation: e.target.checked})} className="rounded bg-bg-accent border-border-color" />
                <label htmlFor="strictCo" className="text-xs text-text-secondary cursor-pointer">Strict 1 Pole / Building</label>
              </div>
            </div>
          </section>

          <section>
             <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">4. Manual Nodes ({manualEquipments.length})</h2>
             {manualEquipments.length === 0 && <p className="text-xs text-text-secondary italic">No manual nodes placed.</p>}
             <div className="space-y-2">
               {manualEquipments.map((eq) => (
                 <div key={eq.id} className="p-2 bg-bg-accent border border-border-color rounded text-xs">
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-bold text-[#ffb300]">{eq.id}</span>
                      <button onClick={() => deleteEq(eq.id)} className="text-text-secondary hover:text-red-400">Remove</button>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-text-secondary w-16">Angle: {eq.angle}°</span>
                      <input type="range" min="0" max="359" value={eq.angle} onChange={(e) => updateEqAngle(eq.id, Number(e.target.value))} className="flex-1 accent-[#ffb300]" />
                    </div>
                 </div>
               ))}
             </div>
          </section>

          <section className="mb-4 space-y-2">
            <button 
              onClick={handleEvaluateCurrent}
              disabled={isSimulating || (buildings.length === 0) || manualEquipments.length === 0}
              className="w-full py-2 bg-bg-accent text-white border border-border-color disabled:opacity-50 hover:bg-border-color rounded flex items-center justify-center transition-colors text-sm"
            >
              <Check className="w-4 h-4 mr-2" /> Evaluate Setup Only
            </button>
            <button 
              onClick={handleRunSimulation}
              disabled={isSimulating || buildings.length === 0 || verandas.length === 0}
              className="w-full py-2.5 bg-accent text-black disabled:bg-border-color disabled:text-text-secondary rounded font-bold flex items-center justify-center transition-colors uppercase text-sm"
            >
              {isSimulating ? (
                <span className="flex items-center"><RotateCcw className="w-4 h-4 mr-2 animate-spin" /> Simulating...</span>
              ) : (
                <span className="flex items-center"><Play className="w-4 h-4 mr-2" /> Auto Populate & Optimize</span>
              )}
            </button>
          </section>

          {result && (
            <div className="space-y-4">
              <div className="p-3 bg-bg-accent border-l-4 border-accent rounded">
                <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-[1.5px] mb-2">Results</h3>
                <div className="flex justify-between text-sm mb-1 pb-0.5">
                  <span className="text-text-secondary text-xs uppercase">Equipments:</span>
                  <span className="font-bold text-white font-mono text-lg">{result.equipments.length.toString().padStart(2, '0')}</span>
                </div>
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="text-text-secondary text-xs uppercase">1st 베란다 커버리지 (모수):</span>
                  <span className="font-bold text-success font-mono text-lg">{result.coverageRatio.toFixed(1)}%</span>
                </div>
                {result.secondCoveredSamples && result.secondCoveredSamples.length > 0 && (
                  <div className="flex justify-between text-sm border-t border-zinc-800 pt-1.5 mt-1">
                    <span className="text-zinc-400 text-[11px] uppercase flex items-center">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#29b6f6] mr-1.5 inline-block animate-pulse"></span>
                      2nd 베란다 전파 투영 보너스:
                    </span>
                    <span className="font-bold text-[#29b6f6] font-mono text-xs">+{result.secondCoveredSamples.length}m</span>
                  </div>
                )}
              </div>

              <div className="bg-bg-accent rounded border border-border-color overflow-hidden flex flex-col">
                 <div className="bg-gray-900 border-b border-border-color p-2 flex items-center text-xs text-text-secondary font-mono">
                    <Terminal className="w-4 h-4 mr-2 text-accent" />
                    SIMULATION LOG
                 </div>
                 <div className="p-3 text-xs font-mono text-gray-300 h-48 overflow-y-auto space-y-2">
                    {result.logs.map((log, i) => (
                      <div key={i} className="border-l-2 border-accent pl-2">
                         <span className="text-accent">[{new Date().toLocaleTimeString()}]</span> {log.message}
                      </div>
                    ))}
                 </div>
              </div>

              <button 
                onClick={handleDownloadReport}
                className="w-full py-2 mt-4 bg-gray-800 text-white border border-border-color hover:bg-gray-700 rounded flex items-center justify-center transition-colors text-sm font-semibold"
              >
                <Download className="w-4 h-4 mr-2" /> Download Results (ZIP)
              </button>
            </div>
          )}

        </div>
      </div>

      <div className="flex-1 relative bg-black flex flex-col overflow-hidden">
        <div className="h-12 bg-bg-panel border-b border-border-color flex items-center px-4 justify-end space-x-4">
            <div className="flex items-center space-x-2 text-text-secondary">
               <ZoomOut className="w-4 h-4" />
               <input type="range" min="0.1" max="3" step="0.1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-24 accent-accent" />
               <ZoomIn className="w-4 h-4" />
               <span className="text-xs font-mono w-12 text-right">{Math.round(zoom * 100)}%</span>
            </div>
        </div>
        <div className="flex-1 overflow-auto map-container p-8 relative">
          {(!imageSrc && buildings.length === 0) ? (
            <div className="h-full flex flex-col items-center justify-center text-text-secondary">
              <ImageIcon className="w-16 h-16 mb-4 opacity-50" />
              <p className="font-mono text-sm">Upload a map, SHP zip, or load sample to start</p>
            </div>
          ) : (
            <div 
               className="inline-block relative shadow-2xl border border-border-color"
               style={{ 
                  width: canvasSize.width * zoom, 
                  height: canvasSize.height * zoom,
               }}
            >
              <canvas
                ref={canvasRef}
                width={canvasSize.width}
                height={canvasSize.height}
                onClick={handleCanvasClick}
                onContextMenu={handleCanvasRightClick}
                onMouseMove={handleCanvasMouseMove}
                style={{ 
                    transform: `scale(${zoom})`, 
                    transformOrigin: 'top left',
                    width: canvasSize.width,
                    height: canvasSize.height
                }}
                className={`${mode !== 'idle' ? 'cursor-crosshair' : 'cursor-default'} opacity-80 absolute top-0 left-0 bg-[#0a0a0a]`}
              />
            </div>
          )}

          {/* Floating AI UI */}
          <AnimatePresence>
            {result && (
              <div className="fixed bottom-6 right-6 flex flex-col items-end space-y-4 z-50">
                {showAiPanel && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 20, scale: 0.95 }}
                    className="w-96 max-h-[70vh] bg-bg-panel border border-border-color rounded-xl shadow-2xl flex flex-col overflow-hidden"
                  >
                    <div className="bg-gray-900 p-3 border-b border-border-color flex justify-between items-center">
                      <div className="flex items-center text-xs text-warning font-bold tracking-wider uppercase">
                        <Sparkles className="w-4 h-4 mr-2" />
                        AI Analysis
                      </div>
                      <button onClick={() => setShowAiPanel(false)} className="text-text-secondary hover:text-white p-1 hover:bg-white/5 rounded transition-colors">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                      {!aiInsights && !isGeneratingInsights ? (
                        <div className="h-full flex flex-col items-center justify-center text-center py-8">
                          <Sparkles className="w-12 h-12 text-[#ffb300] mb-4 opacity-20" />
                          <p className="text-xs text-text-secondary mb-4">Click below to generate detailed insights about the simulation results.</p>
                          <button 
                            onClick={handleGenerateAIInsights} 
                            className="px-6 py-2 bg-warning text-black font-bold rounded-lg text-xs hover:bg-[#ffca28] transition-colors"
                          >
                            Generate Insights
                          </button>
                        </div>
                      ) : (
                        <div className="text-sm text-gray-300 leading-relaxed">
                          <div className="markdown-body">
                            <Markdown>{aiInsights || 'Analyzing results...'}</Markdown>
                          </div>
                          {isGeneratingInsights && (
                            <div className="flex items-center mt-4 text-warning text-xs">
                              <RotateCcw className="w-3 h-3 mr-2 animate-spin" />
                              Processing simulation data...
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}

                <motion.button
                  whileHover={{ scale: 1.02, y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setShowAiPanel(!showAiPanel)}
                  className={`px-8 py-4 rounded-2xl flex items-center justify-center shadow-2xl transition-all duration-300 border-2 z-50 group shadow-warning/20 ${
                    showAiPanel 
                    ? 'bg-white border-warning text-black' 
                    : 'bg-warning border-white/20 text-black'
                  }`}
                >
                  <Sparkles className={`w-5 h-5 mr-3 ${showAiPanel ? 'text-warning' : 'text-black'}`} />
                  <span className="font-bold text-lg tracking-tight uppercase">AI Insights</span>
                  {showAiPanel && <X className="w-5 h-5 ml-3 text-black/50" />}
                </motion.button>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

