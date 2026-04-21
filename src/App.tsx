import React, { useState, useRef, useEffect } from 'react';
import { Upload, Square, Minus, Play, RotateCcw, Image as ImageIcon, Terminal, Database, Search, ZoomIn, ZoomOut, RadioTower, Check, Sparkles, Download } from 'lucide-react';
import { Point, Line, Polygon, SimulationParams, SimulationResult, Equipment } from './types';
import { runSimulation, pointInPolygon, snapToPolygonEdge } from './lib/simulation';
import { sampleBuildings, sampleVerandas } from './lib/sampleData';
// @ts-ignore
import * as shp from 'shpjs';
import { GoogleGenAI } from '@google/genai';
import Markdown from 'react-markdown';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

export default function App() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [buildings, setBuildings] = useState<Polygon[]>([]);
  const [verandas, setVerandas] = useState<Line[]>([]);
  const [manualEquipments, setManualEquipments] = useState<Equipment[]>([]);
  const [mode, setMode] = useState<'idle' | 'building' | 'veranda' | 'equipment'>('idle');
  
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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    
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
      if (canvasRef.current) {
        canvasRef.current.width = cWidth;
        canvasRef.current.height = cHeight;
      }
    } catch (err) {
       console.error("SHP Parse Error:", err);
       alert("SHP 파일 파싱에 실패했습니다. 올바른 형태의 zip 데이터인지 확인해 주세요.");
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
          // Verify environment
          if (!process.env.GEMINI_API_KEY) {
               setAiInsights("Failed: GEMINI_API_KEY is not defined in the environment. Please add it to your setup.");
               setIsGeneratingInsights(false);
               return;
          }

          const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
          
          let buildingData = result.buildingCoverages?.map(bc => `- 건물 ${bc.bIdx + 1}: ${bc.ratio.toFixed(0)}% (커버됨 ${bc.covered}m / 총 ${bc.total}m)`).join('\n') || '없음';
          let equipmentData = result.logs.map(log => `- 장비 ${log.id}: ${log.coveredCount}m 커버 (전파 Score: ${log.score.toFixed(1)}, 평균 품질 효율: ${((log.score / log.coveredCount) * 100 || 0).toFixed(1)}%)`).join('\n') || '없음';
          
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
3. 저효율 잉여 장비 식별 및 제거 제안 (중요!): 장비 목록 중, 평균 품질 효율(%)이 지나치게 낮거나, 커버하는 절대적인 미터(m) 수 자체가 너무 적은 장비들을 명확히 지목하세요. 이들을 제거했을 때 예상되는 전체 커버리지 하락폭이 미미함을 수치로 설명하며 제거를 강하게 권장하세요.
4. 그 외 파라미터 튜닝(빔 폭, 거리) 등 실질적이고 간결한 추가 개선 권장 사항.

불필요한 인사말 등은 생략하고 바로 분석을 시작하세요. 모든 답변은 명확하고 전문적인 한국어(Korean)로 작성하세요.`;

          const aiResponse = await ai.models.generateContentStream({
              model: 'gemini-3.1-pro-preview',
              contents: prompt,
          });

          let fullText = "";
          for await (const chunk of aiResponse) {
              fullText += chunk.text;
              setAiInsights(fullText);
          }
      } catch (e: any) {
          console.error(e);
          setAiInsights("Failed to generate AI insights: " + e.message + "\nPlease check your network or API Key.");
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
            <button onClick={loadSampleData} className="w-full py-1.5 bg-bg-accent border border-border-color rounded text-xs text-text-secondary hover:text-white transition-colors flex items-center justify-center">
              <Search className="w-3 h-3 mr-1" /> Load Sample Data
            </button>
          </section>

          <section>
            <h2 className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-[1.5px] border-b border-border-color pb-1">2. Draw Areas</h2>
            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={() => setMode('building')}
                className={`flex flex-col items-center p-3 rounded border ${mode === 'building' ? 'bg-bg-accent border-accent text-accent' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Square className="w-5 h-5 mb-1" />
                <span className="text-xs font-medium">Building</span>
              </button>
              <button 
                onClick={() => setMode('veranda')}
                className={`flex flex-col items-center p-3 rounded border ${mode === 'veranda' ? 'bg-bg-accent border-warning text-warning' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'}`}
              >
                <Minus className="w-5 h-5 mb-1" />
                <span className="text-xs font-medium">Veranda</span>
              </button>
              <button 
                onClick={() => setMode('equipment')}
                className={`flex flex-col items-center p-3 rounded border ${mode === 'equipment' ? 'bg-bg-accent border-[#ffb300] text-[#ffb300]' : 'bg-bg-accent border-border-color text-text-primary hover:border-text-secondary'} col-span-2`}
              >
                <RadioTower className="w-5 h-5 mb-1" />
                <span className="text-xs font-medium">Place Manual Node</span>
              </button>
            </div>
            <p className="text-xs text-text-secondary mt-2">
              {mode === 'building' && "Click to add points. Right-click to finish polygon."}
              {mode === 'veranda' && "Click start and end points to draw a line."}
              {mode === 'equipment' && "Click anywhere to place a custom node."}
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
                    <Sparkles className="w-4 h-4 mr-2 text-accent" />
                    AI INSIGHTS 
                 </div>
                 <div className="p-3">
                    {!aiInsights && !isGeneratingInsights && (
                        <button onClick={handleGenerateAIInsights} className="w-full py-2 bg-[#ffb300]/20 text-[#ffb300] font-medium rounded text-xs hover:bg-[#ffb300]/40 transition-colors border border-[#ffb300]/50">
                            ✨ Analyze Results & Recommendations
                        </button>
                    )}
                    {(isGeneratingInsights || aiInsights) && (
                        <div className="text-sm text-gray-300">
                           <div className="markdown-body">
                             <Markdown>{aiInsights || 'Analyzing results...'}</Markdown>
                           </div>
                        </div>
                    )}
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
        </div>
      </div>
    </div>
  );
}

