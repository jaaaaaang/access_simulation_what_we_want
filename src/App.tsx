import React, { useState, useRef, useEffect } from 'react';
import { Upload, Square, Minus, Play, RotateCcw, Image as ImageIcon, Terminal, Database, Search, ZoomIn, ZoomOut, RadioTower, Check, Sparkles, Download, Eraser, Save, FolderOpen, X, AlertTriangle, Info } from 'lucide-react';
import { Point, Line, Polygon, SimulationParams, SimulationResult, Equipment } from './types';
import { runSimulation, pointInPolygon, snapToPolygonEdge } from './lib/simulation';
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
  const [mode, setMode] = useState<'idle' | 'building' | 'veranda' | 'equipment' | 'eraser'>('idle');
  
  const [currentPolygon, setCurrentPolygon] = useState<Point[]>([]);
  const [currentLineStart, setCurrentLineStart] = useState<Point | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  
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
    return (localStorage.getItem('vworld_request_mode') as 'direct' | 'proxy') || 'direct';
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCandidates, setSearchCandidates] = useState<any[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'success' | 'error' | 'no_result'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [isFetchingPolygons, setIsFetchingPolygons] = useState(false);
  const [searchLayer, setSearchLayer] = useState<'LT_C_SPBD' | 'LT_C_BLDINFO'>('LT_C_SPBD');
  const [useNameFilter, setUseNameFilter] = useState(true);

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
    } else if (mode === 'veranda') {
      if (!currentLineStart) {
        setCurrentLineStart(p);
      } else {
        setVerandas([...verandas, { start: currentLineStart, end: p }]);
        setCurrentLineStart(null);
      }
    } else if (mode === 'equipment') {
       let bIdx = buildings.findIndex(b => pointInPolygon(p, b));
       let finalP = p;
       if (bIdx >= 0) {
           finalP = snapToPolygonEdge(p, buildings[bIdx]);
       }
       setManualEquipments([...manualEquipments, {
           id: `M-${manualEquipments.length + 1}`,
           x: finalP.x, y: finalP.y, angle: 90,
           bIdx: bIdx >= 0 ? bIdx : undefined,
           isManual: true
       }]);
       setResult(null);
    } else if (mode === 'eraser') {
      // Priority 1: Eraser Manual Equipment
      const eqIdx = manualEquipments.findIndex(eq => Math.sqrt((eq.x - p.x)**2 + (eq.y - p.y)**2) < 10);
      if (eqIdx >= 0) {
        setManualEquipments(manualEquipments.filter((_, i) => i !== eqIdx));
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
    } else if (mode === 'veranda') {
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

    setSearchStatus('searching');
    setSearchCandidates([]);
    setErrorMessage('');

    try {
      localStorage.setItem('vworld_api_key', vworldKey.trim());
      localStorage.setItem('vworld_api_domain', vworldDomain.trim());
      localStorage.setItem('vworld_request_mode', vworldRequestMode);
      const encodeQuery = encodeURIComponent(searchQuery);
      // VWorld Search API 2.0 (place type search)
      const url = `https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=15&query=${encodeQuery}&type=place&format=json&key=${vworldKey.trim()}&domain=${encodeURIComponent(vworldDomain.trim())}`;
      
      let data: any;

      if (vworldRequestMode === 'direct') {
        data = await fetchJSONP(url);
      } else {
        const targetFetchUrl = `/api/vworld-proxy?url=${encodeURIComponent(url)}`;
        const res = await fetch(targetFetchUrl);
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch (err) {
          throw new Error(`서버 프록시 에러 (구글 서버 IP 대역 차단 가능성 높음): ${text.substring(0, 150)}... 해결법: 호출 방식을 '직접 호출 (WAF 우회 권장)'로 설정해 주세요.`);
        }
      }

      if (data.response && data.response.status === 'OK' && data.response.result) {
        let items = data.response.result.items || [];
        if (!Array.isArray(items)) {
          items = [items];
        }
        setSearchCandidates(items);
        setSearchStatus('success');
      } else {
        const status = data.response?.status || 'UNKNOWN';
        const errorMsg = data.response?.error || '검색 결과가 없거나 인증키 및 도메인이 올바르지 않습니다.';
        if (status === 'NOT_FOUND' || status === 'EMPTY') {
          setSearchStatus('no_result');
        } else {
          setSearchStatus('error');
          let extraHelp = '';
          if (vworldRequestMode === 'proxy') {
            extraHelp = ' (구글 클라우드 서버IP 차단 예방을 위해 "내 브라우저에서 직접 호출" 모드로 변경해 보시는 것을 권장합니다.)';
          }
          setErrorMessage(`에러: ${status} - ${errorMsg}${extraHelp}`);
        }
      }
    } catch (err: any) {
      console.error(err);
      setSearchStatus('error');
      let extraHelp = '';
      if (vworldRequestMode === 'proxy') {
        extraHelp = ' [구글 클라우드 서버 IP 대역 대개 차단 때문일 수 있으므로 "내 브라우저에서 직접 호출"을 권장합니다.]';
      }
      setErrorMessage(`네트워크 오류: ${err.message}.${extraHelp} CORS 정책 또는 브이월드에 등록된 도메인 설정을 확인해 주세요.`);
    }
  };

  const handleSelectCandidate = async (candidate: any) => {
    if (!candidate.point || !candidate.point.x || !candidate.point.y) {
      showAppNotification("선택한 객체에 좌표 정보가 없습니다.", "warning");
      return;
    }

    setIsFetchingPolygons(true);
    const lon = Number(candidate.point.x);
    const lat = Number(candidate.point.y);

    // Create bounds (~600m radius around matched point)
    const minLon = lon - 0.007;
    const maxLon = lon + 0.007;
    const minLat = lat - 0.005;
    const maxLat = lat + 0.005;

    const geomFilter = `BOX(${minLon},${minLat},${maxLon},${maxLat})`;
    const cleanTitle = stripHtml(candidate.title || '');
    const apartmentName = cleanTitle.split(/\s+/)[0]; 

    try {
      // VWorld Data API 2.0 GetFeature
      let url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=${searchLayer}&key=${vworldKey.trim()}&format=json&crs=EPSG:4326&size=100&geomFilter=${geomFilter}&domain=${encodeURIComponent(vworldDomain.trim())}`;

      if (useNameFilter && apartmentName) {
        const encodedName = encodeURIComponent(apartmentName);
        url += `&attrFilter=buld_nm:like:${encodedName}`;
      }

      let data: any;
      if (vworldRequestMode === 'direct') {
        data = await fetchJSONP(url);
      } else {
        const targetFetchUrl = `/api/vworld-proxy?url=${encodeURIComponent(url)}`;
        const res = await fetch(targetFetchUrl);
        const text = await res.text();
        try {
          data = JSON.parse(text);
        } catch (err) {
          throw new Error(`서버 프록시 에러 (구글 서버 IP 대역 차단 가능성 높음): ${text.substring(0, 150)}... 해결법: 호출 방식을 '직접 호출 (WAF 우회 권장)'로 설정해 주세요.`);
        }
      }

      if (data.response && data.response.status === 'OK' && data.response.result) {
        const featureCollection = data.response.result.featureCollection;
        if (featureCollection && featureCollection.features && featureCollection.features.length > 0) {
          const features = featureCollection.features;

          let localMinLon = Infinity, localMinLat = Infinity, localMaxLon = -Infinity, localMaxLat = -Infinity;
          
          features.forEach((f: any) => {
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
          features.forEach((f: any) => {
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

          if (canvasRef.current) {
            canvasRef.current.width = cWidth;
            canvasRef.current.height = cHeight;
          }

          showAppNotification(`성공적으로 ${parsedBuildings.length}개의 건물 폴리곤을 가져와 시뮬레이션 보드에 배치했습니다!`, "success");
        } else {
          showAppNotification(`해당 영역 또는 단지 조건(${apartmentName})으로 가져온 건물 데이터가 레이어에 없습니다. 레이어를 변경하거나 필터를 끄고 다시 로드해 보세요.`, "warning");
        }
      } else {
        const errorMsg = data.response?.error || '건물 데이터를 가져오지 못했습니다. API 제한량 또는 인증키 설정을 확인하세요.';
        showAppNotification(`인식 에러: ${errorMsg}`, "error");
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

              ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
              ctx.beginPath();
              // A simple background box for text
              ctx.roundRect(cx - 24, cy - 12, 48, 24, 4);
              ctx.fill();

              ctx.fillStyle = bCov.ratio >= 90 ? '#00e676' : bCov.ratio >= 50 ? '#ffb300' : '#ff5252';
              ctx.font = 'bold 12px Inter';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(`${Math.round(bCov.ratio)}%`, cx, cy);
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

    verandas.forEach(line => {
      ctx.beginPath();
      ctx.moveTo(line.start.x, line.start.y);
      ctx.lineTo(line.end.x, line.end.y);
      ctx.strokeStyle = '#ffb300';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.stroke();
    });

    if (currentLineStart && mousePos) {
      ctx.beginPath();
      ctx.moveTo(currentLineStart.x, currentLineStart.y);
      ctx.lineTo(mousePos.x, mousePos.y);
      ctx.strokeStyle = '#ffb300';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.setLineDash([8, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw manual equipments not yet simulated
    if (!result) {
      manualEquipments.forEach((eq) => {
        const angleRad = (eq.angle - 90) * Math.PI / 180;
        const beamHalfConf = (params.beamWidth / 2) * Math.PI / 180;
        const mainStart = angleRad - beamHalfConf;
        const mainEnd = angleRad + beamHalfConf;
        const leakLeftStart = angleRad - beamHalfConf - (15 * Math.PI / 180);
        const leakRightEnd = angleRad + beamHalfConf + (15 * Math.PI / 180);
        const radius = params.maxRange * params.pixelsPerMeter * 0.4; // Preview beam

        // Left leakage
        ctx.beginPath();
        ctx.moveTo(eq.x, eq.y);
        ctx.arc(eq.x, eq.y, radius, leakLeftStart, mainStart);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 235, 59, 0.2)'; // Yellow
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 235, 59, 0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Right leakage
        ctx.beginPath();
        ctx.moveTo(eq.x, eq.y);
        ctx.arc(eq.x, eq.y, radius, mainEnd, leakRightEnd);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 235, 59, 0.2)';
        ctx.fill();
        ctx.stroke();

        // Main beam
        ctx.beginPath();
        ctx.moveTo(eq.x, eq.y);
        ctx.arc(eq.x, eq.y, radius, mainStart, mainEnd);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 179, 0, 0.2)'; // amber for manual preview
        ctx.fill();
        ctx.strokeStyle = '#000000'; // Black edge
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // We also want to align multiple manual nodes horizontally if overlapped, but it's preview. Let's just draw the node larger.
        ctx.beginPath();
        ctx.arc(eq.x, eq.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffb300';
        ctx.fill();
        
        ctx.fillStyle = '#000';
        ctx.font = 'bold 12px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(eq.id.split('-')[1], eq.x, eq.y);
      });
    }

    if (result) {
      // Draw connection lines (beams)
      result.equipments.forEach((eq) => {
        if (eq.coveredPoints && eq.coveredPoints.length > 0) {
          ctx.beginPath();
          eq.coveredPoints.forEach(p => {
            ctx.moveTo(eq.x, eq.y);
            ctx.lineTo(p.x, p.y);
          });
          ctx.strokeStyle = 'rgba(0, 229, 255, 0.25)'; // faint cyan beam
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      });

      ctx.fillStyle = '#00e676';
      result.coveredSamples.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
      });

      const drawnNodes = new Map<string, number>();

      result.equipments.forEach((eq, index) => {
        // Adjust angle so 0 deg is North (Up - 12 o'clock)
        const angleRad = (eq.angle - 90) * Math.PI / 180;
        const beamHalfConf = (params.beamWidth / 2) * Math.PI / 180;
        const mainStart = angleRad - beamHalfConf;
        const mainEnd = angleRad + beamHalfConf;
        const leakLeftStart = angleRad - beamHalfConf - (15 * Math.PI / 180);
        const leakRightEnd = angleRad + beamHalfConf + (15 * Math.PI / 180);
        const radius = params.maxRange * params.pixelsPerMeter;

        // Left leakage (Yellow)
        ctx.beginPath();
        ctx.moveTo(eq.x, eq.y);
        ctx.arc(eq.x, eq.y, radius, leakLeftStart, mainStart);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 235, 59, 0.2)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 235, 59, 0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Right leakage (Yellow)
        ctx.beginPath();
        ctx.moveTo(eq.x, eq.y);
        ctx.arc(eq.x, eq.y, radius, mainEnd, leakRightEnd);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 235, 59, 0.2)';
        ctx.fill();
        ctx.stroke();

        // Main beam (Cyan)
        ctx.beginPath();
        ctx.moveTo(eq.x, eq.y);
        ctx.arc(eq.x, eq.y, radius, mainStart, mainEnd);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0, 229, 255, 0.2)';
        ctx.fill();
        ctx.strokeStyle = '#000000'; // Change to black line for visibility
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const key = `${Math.round(eq.x)},${Math.round(eq.y)}`;
        const offsetCount = drawnNodes.get(key) || 0;
        drawnNodes.set(key, offsetCount + 1);

        // Offset label horizontally side-by-side if multiple nodes share the same pole
        const xOffset = eq.x + (offsetCount * 18); // 18px horizontal padding between labels
        
        ctx.beginPath();
        ctx.arc(xOffset, eq.y, 8, 0, Math.PI * 2); // Larger circle
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#000';
        ctx.font = 'bold 12px Inter'; // Larger 마킹
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(eq.id.replace('AUTO-', '').replace('M-', ''), xOffset, eq.y);
      });
    }

  }, [imageSrc, buildings, verandas, currentPolygon, currentLineStart, mousePos, result, params, manualEquipments]);

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

                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label className="text-[10px] text-text-secondary block mb-0.5">조회 레이어</label>
                    <select 
                      value={searchLayer} 
                      onChange={e => setSearchLayer(e.target.value as any)} 
                      className="w-full px-1.5 py-1 bg-bg-accent border border-border-color rounded text-[11px] text-white focus:outline-none"
                    >
                      <option value="LT_C_SPBD">도로명건물 (SPBD)</option>
                      <option value="LT_C_BLDINFO">건축물정보 (BLD)</option>
                    </select>
                  </div>
                  <div className="flex flex-col justify-end">
                    <label className="flex items-center space-x-1.5 cursor-pointer py-1">
                      <input 
                        type="checkbox" 
                        checked={useNameFilter} 
                        onChange={e => setUseNameFilter(e.target.checked)} 
                        className="rounded bg-bg-accent border-border-color text-accent w-3 h-3"
                      />
                      <span className="text-[10px] text-text-secondary whitespace-nowrap">단지명 동 필터ing</span>
                    </label>
                  </div>
                </div>

                <div className="pt-1">
                  <label className="text-[10px] text-text-secondary block mb-0.5">아파트 단지명 검색</label>
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
                      disabled={searchStatus === 'searching'} 
                      className="px-2.5 bg-accent text-black rounded text-xs hover:bg-[#00e5ff]/90 transition-colors flex items-center justify-center cursor-pointer"
                    >
                      검색
                    </button>
                  </div>
                </div>
              </div>

              {/* Status and Candidates list */}
              {searchStatus === 'searching' && (
                <div className="text-[11px] text-accent flex items-center justify-center py-1 bg-bg-accent/30 rounded">
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> 단지 대표위치 검색 중...
                </div>
              )}

              {searchStatus === 'no_result' && (
                <div className="text-[11px] text-warning text-center py-1 bg-bg-accent/30 rounded">
                  검색 결과가 없습니다.
                </div>
              )}

              {searchStatus === 'error' && (
                <div className="text-[10px] text-red-400 p-1.5 bg-red-950/20 rounded border border-red-900/30 font-mono break-all leading-tight">
                  {errorMessage}
                </div>
              )}

              {isFetchingPolygons && (
                <div className="text-[11px] text-warning flex items-center justify-center py-1.5 bg-bg-accent/30 rounded border border-warning/10 animate-pulse">
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> 단지 건물 폴리곤 다운로드 중...
                </div>
              )}

              {searchCandidates.length > 0 && searchStatus === 'success' && (
                <div className="space-y-1.5 pt-1.5 border-t border-zinc-800">
                  <span className="text-[10px] text-text-secondary font-semibold block mb-1">검색 결과 ({searchCandidates.length}):</span>
                  <div className="max-h-36 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                    {searchCandidates.map((c, idx) => (
                      <button 
                        key={idx} 
                        onClick={() => handleSelectCandidate(c)}
                        disabled={isFetchingPolygons}
                        className="w-full text-left p-1.5 bg-zinc-900 border border-zinc-800 rounded hover:border-accent hover:bg-zinc-800/80 transition-all text-[11px] line-clamp-2 block group cursor-pointer"
                      >
                        <div className="font-bold text-white group-hover:text-accent transition-colors truncate">
                          {stripHtml(c.title)}
                        </div>
                        <div className="text-[9px] text-gray-400 truncate">
                          {c.address?.road || c.address?.parcel || '주소 정보 없음'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">2. Draw Areas</h2>
            <div className="grid grid-cols-3 gap-2">
              <button 
                onClick={() => setMode('building')}
                className={`flex flex-col items-center p-3 rounded border ${mode === 'building' ? 'bg-bg-accent border-accent text-accent' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Square className="w-5 h-5 mb-1" />
                <span className="text-[10px] font-medium">Building</span>
              </button>
              <button 
                onClick={() => setMode('veranda')}
                className={`flex flex-col items-center p-3 rounded border ${mode === 'veranda' ? 'bg-bg-accent border-warning text-warning' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Minus className="w-5 h-5 mb-1" />
                <span className="text-[10px] font-medium">Veranda</span>
              </button>
              <button 
                onClick={() => setMode('eraser')}
                className={`flex flex-col items-center p-3 rounded border ${mode === 'eraser' ? 'bg-bg-accent border-error text-error' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Eraser className="w-5 h-5 mb-1" />
                <span className="text-[10px] font-medium">Eraser</span>
              </button>
              <button 
                onClick={() => setMode('equipment')}
                className={`flex flex-col items-center p-3 rounded border ${mode === 'equipment' ? 'bg-bg-accent border-[#ffb300] text-[#ffb300]' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'} col-span-3`}
              >
                <RadioTower className="w-5 h-5 mb-1" />
                <span className="text-xs font-medium">Place Manual Node</span>
              </button>
            </div>
            <p className="text-xs text-text-secondary mt-2">
              {mode === 'building' && "Click to add points. Right-click to finish polygon."}
              {mode === 'veranda' && "Click start and end points to draw a line."}
              {mode === 'equipment' && "Click anywhere to place a custom node."}
              {mode === 'eraser' && "Click on a building, veranda, or node to remove it."}
              {mode === 'idle' && "Select a tool to start drawing."}
            </p>
            <button onClick={clearDrawing} className="mt-2 text-xs text-text-secondary hover:text-text-primary flex items-center">
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
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-text-secondary text-xs uppercase">Equipments:</span>
                  <span className="font-bold text-white font-mono text-lg">{result.equipments.length.toString().padStart(2, '0')}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-text-secondary text-xs uppercase">Coverage:</span>
                  <span className="font-bold text-success font-mono text-lg">{result.coverageRatio.toFixed(1)}%</span>
                </div>
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

