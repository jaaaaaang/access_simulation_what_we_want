import { Point, Line, Polygon, Equipment, SimulationParams, SimulationResult, LogEntry } from '../types';

export function pointInPolygon(point: Point, vs: Polygon) {
    let x = point.x, y = point.y;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].x, yi = vs[i].y;
        let xj = vs[j].x, yj = vs[j].y;
        let intersect = ((yi > y) != (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

export function distance(p1: Point, p2: Point) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

function distToSegmentSquared(p: Point, v: Point, w: Point) {
  const l2 = Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
  if (l2 === 0) return distance(p, v) * distance(p, v);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.pow(p.x - (v.x + t * (w.x - v.x)), 2) + Math.pow(p.y - (v.y + t * (w.y - v.y)), 2);
}

export function distToPolygon(p: Point, poly: Polygon) {
    let minDist = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const d2 = distToSegmentSquared(p, poly[j], poly[i]);
        if (d2 < minDist) {
            minDist = d2;
        }
    }
    return Math.sqrt(minDist);
}

export function snapToPolygonEdge(p: Point, poly: Polygon): Point {
    let minDist = Infinity;
    let closestPoint: Point = { x: p.x, y: p.y };
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const v = poly[j];
        const w = poly[i];
        const l2 = Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
        if (l2 === 0) {
            const d = distance(p, v);
            if (d < minDist) { minDist = d; closestPoint = {x: v.x, y: v.y}; }
            continue;
        }
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        const proj = { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) };
        const d = distance(p, proj);
        if (d < minDist) {
            minDist = d;
            closestPoint = proj;
        }
    }
    return closestPoint;
}

// Extract the long face walls of standard polygon buildings and treat them as Second Verandas (70% score)
export function getSecondVerandas(buildings: Polygon[]): Line[] {
    const secondLines: Line[] = [];
    buildings.forEach((poly, bIdx) => {
        const N = poly.length;
        if (N < 3) return;
        
        // Calculate all edge lengths
        const edgeLengths: number[] = [];
        for (let i = 0; i < N; i++) {
            edgeLengths.push(distance(poly[i], poly[(i + 1) % N]));
        }
        
        // Calculate average edge length of this specific building
        const avgLength = edgeLengths.reduce((a, b) => a + b, 0) / N;
        
        // Any edge with length >= avgLength is classified as a "long face wall" meaning a Second Veranda
        for (let i = 0; i < N; i++) {
            if (edgeLengths[i] >= avgLength) {
                const start = poly[i];
                const end = poly[(i + 1) % N];
                
                // Normal vector computation
                const dx = end.x - start.x;
                const dy = end.y - start.y;
                let nx = -dy;
                let ny = dx;
                const len = Math.sqrt(nx*nx + ny*ny);
                if (len > 0) {
                    nx /= len;
                    ny /= len;
                }
                
                // Determine outward normal (away from building interior)
                const midPoint = { x: (start.x + end.x)/2, y: (start.y + end.y)/2 };
                let isInside1 = false;
                let isInside2 = false;
                for(let ep = 1; ep <= 10; ep += 2) {
                    if (pointInPolygon({ x: midPoint.x + nx * ep, y: midPoint.y + ny * ep }, poly)) isInside1 = true;
                    if (pointInPolygon({ x: midPoint.x - nx * ep, y: midPoint.y - ny * ep }, poly)) isInside2 = true;
                    if (isInside1 !== isInside2) break; 
                }
                if (isInside1 && !isInside2) {
                    nx = -nx; ny = -ny;
                } else if (isInside2 && !isInside1) {
                    // correct
                } else {
                    let cx = 0, cy = 0;
                    poly.forEach(p => { cx += p.x; cy += p.y; });
                    cx /= poly.length;
                    cy /= poly.length;
                    if (nx * (midPoint.x - cx) + ny * (midPoint.y - cy) < 0) {
                        nx = -nx; ny = -ny;
                    }
                }
                
                secondLines.push({
                    start,
                    end,
                    bIdx,
                    normal: { x: nx, y: ny },
                    isSecond: true
                });
            }
        }
    });
    return secondLines;
}

export function evaluateRay(
    point: { x: number; y: number; bIdx?: number; isCandidate?: boolean },
    angle: number,
    sample: Point & { line: Line },
    params: SimulationParams,
    buildings: Polygon[]
): number {
    const d_px = distance(point, sample);
    const d_m = d_px / params.pixelsPerMeter;
    if (d_m > params.maxRange) return 0;

    let math_angle_to_P = Math.atan2(sample.y - point.y, sample.x - point.x) * 180 / Math.PI;
    let angle_to_P = math_angle_to_P + 90; 
    if (angle_to_P < 0) angle_to_P += 360;
    if (angle_to_P >= 360) angle_to_P -= 360;

    let diff = Math.abs(angle_to_P - angle);
    diff = diff > 180 ? 360 - diff : diff;
    const halfWidth = params.beamWidth / 2;
    if (diff > halfWidth + 15) return 0; 
    
    let angular_loss = 0;
    if (diff <= halfWidth) {
        const theta = (diff / halfWidth) * (Math.PI / 4); 
        angular_loss = Math.pow(Math.cos(theta), 2);
    } else {
        const extra = diff - halfWidth;
        angular_loss = 0.5 * (1 - (extra / 15));
        if (angular_loss <= 0) return 0;
    }

    let blocked = false;
    const rayStep = 3; 
    const startOffset = 5; 
    const endOffset = 5;   

    if (d_px > startOffset + endOffset) {
        for (let dist = startOffset; dist < d_px - endOffset; dist += rayStep) {
            const t = dist / d_px;
            const p = { 
                x: point.x + (sample.x - point.x) * t, 
                y: point.y + (sample.y - point.y) * t 
            };
            
            let hit = false;
            for (let bIdx = 0; bIdx < buildings.length; bIdx++) {
                if (point.bIdx !== undefined && bIdx === point.bIdx) {
                    if (!point.isCandidate) {
                        continue; // Skip own building for manual/roof nodes
                    }
                    // For candidates (on the edge), they should only shoot outward.
                    // If p is inside the building, it means the ray is shooting through the building.
                }
                if (pointInPolygon(p, buildings[bIdx])) {
                    hit = true;
                    break;
                }
            }
            if (hit) {
                blocked = true;
                break;
            }
        }
    }
    if (blocked) return 0;

    const r_pct = d_m / params.maxRange;
    let f_d = r_pct <= 0.46 ? 1.0 : (r_pct <= 0.66 ? 0.9 : (r_pct <= 1.0 ? 0.85 : 0));
    
    // Add distance reward to ensure closer equipment is scored higher
    if (f_d > 0) {
        f_d += (1.0 - r_pct) * 0.2; // Max 0.2 bonus for being extremely close
    }

    const vx = (point.x - sample.x) / d_px;
    const vy = (point.y - sample.y) / d_px;
    if (!sample.line.normal) return 0;
    const cos_phi = vx * sample.line.normal.x + vy * sample.line.normal.y;
    
    if (cos_phi <= 0) return 0;
    
    const score = cos_phi * f_d * angular_loss;
    
    // Applying Second Veranda penalty (-30% score / weight rating)
    return sample.line.isSecond ? score * 0.7 : score;
}

export function runSimulation(
    buildings: Polygon[],
    verandas: Line[],
    params: SimulationParams,
    initialEquipments: Equipment[] = []
): SimulationResult {
    const candidatePoints: (Point & {bIdx: number})[] = [];
    const step = 4; 
    
    // 1. Generate site candidate location points along building boundaries
    buildings.forEach((poly, bIdx) => {
        for (let i = 0; i < poly.length; i++) {
            const p1 = poly[i];
            const p2 = poly[(i + 1) % poly.length];
            const dist = distance(p1, p2);
            const steps = Math.ceil(dist / step);
            for (let j = 0; j < steps; j++) {
                const t = steps === 0 ? 0 : j / steps;
                candidatePoints.push({
                    x: p1.x + (p2.x - p1.x) * t,
                    y: p1.y + (p2.y - p1.y) * t,
                    bIdx,
                    centerFactor: 1.0 - Math.abs(t - 0.5) * 2,
                    isCandidate: true,
                    edgeLength: dist
                });
            }
        }
    });

    // Solve standard and second verandas and map their outward normal vectors
    // Divide user-drawn verandas into 1st verandas (isSecond !== true) and 2nd verandas (isSecond === true)
    const firstVerandas = verandas.filter(v => !v.isSecond);
    const userSecondVerandas = verandas.filter(v => v.isSecond);

    // Identify buildings with 1st verandas
    const buildingsWithFirstVeranda = new Set<number>();
    
    // Map properties and outward normal vectors for 1st verandas
    firstVerandas.forEach((line) => {
        let minD = Infinity;
        let bestBIdx = -1;
        const midPoint = { x: (line.start.x + line.end.x)/2, y: (line.start.y + line.end.y)/2 };
        
        buildings.forEach((b, bIdx) => {
           const d = distToPolygon(midPoint, b);
           if (d < minD) {
               minD = d;
               bestBIdx = bIdx;
           }
        });
        line.bIdx = bestBIdx;
        if (bestBIdx !== -1) {
            buildingsWithFirstVeranda.add(bestBIdx);
        }

        const dx = line.end.x - line.start.x;
        const dy = line.end.y - line.start.y;
        let nx = -dy;
        let ny = dx;
        const len = Math.sqrt(nx*nx + ny*ny);
        if (len > 0) {
            nx /= len;
            ny /= len;
        }

        let isInside1 = false;
        let isInside2 = false;
        if (bestBIdx !== -1) {
            const poly = buildings[bestBIdx];
            for(let ep = 1; ep <= 10; ep += 2) {
                if (pointInPolygon({ x: midPoint.x + nx * ep, y: midPoint.y + ny * ep }, poly)) isInside1 = true;
                if (pointInPolygon({ x: midPoint.x - nx * ep, y: midPoint.y - ny * ep }, poly)) isInside2 = true;
                if (isInside1 !== isInside2) break; 
            }
            if (isInside1 && !isInside2) {
                nx = -nx; ny = -ny;
            } else if (isInside2 && !isInside1) {
                // nx, ny is already outward
            } else {
                let cx = 0, cy = 0;
                poly.forEach(p => { cx += p.x; cy += p.y; });
                cx /= poly.length;
                cy /= poly.length;
                if (nx * (midPoint.x - cx) + ny * (midPoint.y - cy) < 0) {
                    nx = -nx; ny = -ny;
                }
            }
        }
        line.normal = { x: nx, y: ny };
    });
    
    const autoSecondVerandas = getSecondVerandas(buildings).filter(line => 
      line.bIdx !== undefined && buildingsWithFirstVeranda.has(line.bIdx)
    );
    const secondVerandas = [...userSecondVerandas, ...autoSecondVerandas];

    // Map properties and outward normal vectors for 2nd verandas
    secondVerandas.forEach((line) => {
        let minD = Infinity;
        let bestBIdx = -1;
        const midPoint = { x: (line.start.x + line.end.x)/2, y: (line.start.y + line.end.y)/2 };
        
        buildings.forEach((b, bIdx) => {
           const d = distToPolygon(midPoint, b);
           if (d < minD) {
               minD = d;
               bestBIdx = bIdx;
           }
        });
        line.bIdx = bestBIdx;

        const dx = line.end.x - line.start.x;
        const dy = line.end.y - line.start.y;
        let nx = -dy;
        let ny = dx;
        const len = Math.sqrt(nx*nx + ny*ny);
        if (len > 0) {
            nx /= len;
            ny /= len;
        }

        let isInside1 = false;
        let isInside2 = false;
        if (bestBIdx !== -1) {
            const poly = buildings[bestBIdx];
            for(let ep = 1; ep <= 10; ep += 2) {
                if (pointInPolygon({ x: midPoint.x + nx * ep, y: midPoint.y + ny * ep }, poly)) isInside1 = true;
                if (pointInPolygon({ x: midPoint.x - nx * ep, y: midPoint.y - ny * ep }, poly)) isInside2 = true;
                if (isInside1 !== isInside2) break; 
            }
            if (isInside1 && !isInside2) {
                nx = -nx; ny = -ny;
            } else if (isInside2 && !isInside1) {
                // nx, ny is already outward
            } else {
                let cx = 0, cy = 0;
                poly.forEach(p => { cx += p.x; cy += p.y; });
                cx /= poly.length;
                cy /= poly.length;
                if (nx * (midPoint.x - cx) + ny * (midPoint.y - cy) < 0) {
                    nx = -nx; ny = -ny;
                }
            }
        }
        line.normal = { x: nx, y: ny };
    });

    type Sample = Point & { line: Line, covered: boolean };
    const samples: Sample[] = [];
    const secondSamples: Sample[] = [];
    const sampleStep = (params.pixelsPerMeter * 1) || 5; // 1 point = 1 meter of veranda
    
    // Populate standard veranda samples from user-drawn 1st verandas ONLY
    firstVerandas.forEach(line => {
        const len = distance(line.start, line.end);
        const steps = Math.ceil(len / sampleStep);
        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            samples.push({
                x: line.start.x + (line.end.x - line.start.x) * t,
                y: line.start.y + (line.end.y - line.start.y) * t,
                line,
                covered: false
            });
        }
    });

    // Populate second veranda samples from user-drawn 2nd verandas AND add them to samples for optimization
    secondVerandas.forEach(line => {
        const len = distance(line.start, line.end);
        const steps = Math.ceil(len / sampleStep);
        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            const s = {
                x: line.start.x + (line.end.x - line.start.x) * t,
                y: line.start.y + (line.end.y - line.start.y) * t,
                line,
                covered: false
            };
            secondSamples.push(s);
        }
    });

    if (samples.length === 0) {
        return { equipments: [], coverageRatio: 0, coveredSamples: [], logs: [] };
    }

    const getWeight = (s: Sample) => (s.line.isSecond ? 0.7 : 1.0);

    const equipments: Equipment[] = [];
    const logs: LogEntry[] = [];
    const totalWeightSum = samples.reduce((sum, s) => sum + getWeight(s), 0);
    const targetCoveredScore = totalWeightSum * (params.targetCoverage / 100);
    let currentCoveredScore = 0;
    const establishedNodes = new Map<number, Point>();

    // Phase 1: Evaluate pre-placed / manual equipments
    for (const eq of initialEquipments) {
        const scoredSamples: {idx: number, score: number}[] = [];
        for (let i = 0; i < samples.length; i++) {
            if (samples[i].covered) continue;
            if (eq.bIdx !== undefined && eq.bIdx === samples[i].line.bIdx) continue;
            
            const score = evaluateRay(eq, eq.angle, samples[i], params, buildings);
            if (score > 0.05) {
                scoredSamples.push({idx: i, score});
            }
        }
        scoredSamples.sort((a, b) => b.score - a.score);
        const selectedSamples = scoredSamples;
        
        const newEq = { ...eq, coveredPoints: [] as Point[] };
        for (const s of selectedSamples) {
            samples[s.idx].covered = true;
            currentCoveredScore += getWeight(samples[s.idx]);
            newEq.coveredPoints.push({x: samples[s.idx].x, y: samples[s.idx].y});
        }
        equipments.push(newEq);
        
        if (newEq.bIdx !== undefined && !establishedNodes.has(newEq.bIdx)) {
             establishedNodes.set(newEq.bIdx, {x: newEq.x, y: newEq.y});
        }
        logs.push({
            id: newEq.id,
            x: Math.round(newEq.x), y: Math.round(newEq.y), angle: Math.round(newEq.angle),
            score: 0, coveredCount: selectedSamples.length, 
            message: `[MANUAL] Node ${newEq.id} placed ${newEq.bIdx !== undefined ? `on Building #${newEq.bIdx + 1}` : 'on Map'} at (${Math.round(newEq.x)}, ${Math.round(newEq.y)}) facing ${Math.round(newEq.angle)}°. Secured ${selectedSamples.length} meters of coverage.`
        });
    }

    let maxIterations = 40; 
    const uniqueManualCoords = new Set<string>();
    initialEquipments.forEach(eq => uniqueManualCoords.add(`${Math.round(eq.x)},${Math.round(eq.y)}`));
    let nextSiteIdx = uniqueManualCoords.size + 1;
    
    // Add candidate points along all verandas every 4 pixels
    [...firstVerandas, ...secondVerandas].forEach(v => {
        if (v.bIdx !== undefined) {
            const dist = distance(v.start, v.end);
            const steps = Math.ceil(dist / 4);
            for (let j = 0; j <= steps; j++) {
                const t = steps === 0 ? 0 : j / steps;
                candidatePoints.push({
                    x: v.start.x + (v.end.x - v.start.x) * t,
                    y: v.start.y + (v.end.y - v.start.y) * t,
                    bIdx: v.bIdx,
                    centerFactor: 1.0 - Math.abs(t - 0.5) * 2,
                    isCandidate: true,
                    edgeLength: dist
                });
            }
        }
    });

    // Phase 2: Tri-Sector Site Greedy Optimizer (3분기 고정 배치)
    while (!params.preventAutoSectors && currentCoveredScore < targetCoveredScore && maxIterations > 0 && candidatePoints.length > 0) {
        maxIterations--;
        
        let candidateSites: { point: (Point & { bIdx: number }), angles: number[], jointScore: number, maxSingleScore: number, coveredIndices: number[], coveredSecondIndices: number[], bestSingleSectorScoreForPoint: number }[] = [];

        for (const point of candidatePoints) {
            let isAllowed = true;
            if (params.strictCoLocation) {
                if (establishedNodes.has(point.bIdx)) {
                    const established = establishedNodes.get(point.bIdx)!;
                    if (Math.abs(point.x - established.x) > 1 || Math.abs(point.y - established.y) > 1) {
                         isAllowed = false;
                    }
                }
            }
            if (!isAllowed) continue;

            // 1. Gather all standard veranda samples not yet covered and not on the current transmitting building
            const activeSampleIndices: number[] = [];
            for (let i = 0; i < samples.length; i++) {
                if (samples[i].covered) continue;
                if (point.bIdx !== undefined && point.bIdx === samples[i].line.bIdx) continue;
                activeSampleIndices.push(i);
            }

            if (activeSampleIndices.length === 0) continue;

            const numActive = activeSampleIndices.length;
            
            const activeSampleBIdx = new Int32Array(numActive);
            for (let s = 0; s < numActive; s++) {
                activeSampleBIdx[s] = samples[activeSampleIndices[s]].line.bIdx !== undefined ? samples[activeSampleIndices[s]].line.bIdx! : -1;
            }

            // 2. Precompute the raw ray score of each sector direction (from 0 to 350 deg, in steps of 10)
            // for all active samples
            const scoreMatrix = new Float32Array(36 * numActive);
            const angleScores = new Float32Array(36);
            let bestSingleSectorScoreForPoint = 0;

            for (let aIdx = 0; aIdx < 36; aIdx++) {
                const angle = aIdx * 10;
                let activeAngleScore = 0;
                const bScoresForAngle = new Map<number, number>();

                for (let s = 0; s < numActive; s++) {
                    const globalIdx = activeSampleIndices[s];
                    const rayScore = evaluateRay(point, angle, samples[globalIdx], params, buildings);
                    if (rayScore > 0.05) {
                        const weightedScore = rayScore * getWeight(samples[globalIdx]);
                        scoreMatrix[aIdx * numActive + s] = weightedScore;
                        activeAngleScore += weightedScore;
                        
                        const bIdx = activeSampleBIdx[s];
                        if (bIdx !== -1) {
                            bScoresForAngle.set(bIdx, (bScoresForAngle.get(bIdx) || 0) + weightedScore);
                        }
                    }
                }
                angleScores[aIdx] = activeAngleScore;

                for (const score of bScoresForAngle.values()) {
                    if (score > bestSingleSectorScoreForPoint) bestSingleSectorScoreForPoint = score;
                }
            }

            // 3. Find the combination of 3 sectors spaced >= 60 degrees
            for (let i = 0; i < 36; i++) {
                if (angleScores[i] === 0) continue; // Skip inactive directions to save calculations

                for (let j = i + 1; j < 36; j++) {
                    let diffAB = Math.abs((i - j) * 10);
                    diffAB = diffAB > 180 ? 360 - diffAB : diffAB;
                    if (diffAB < 60) continue;

                    for (let k = j + 1; k < 36; k++) {
                        let diffBC = Math.abs((j - k) * 10);
                        diffBC = diffBC > 180 ? 360 - diffBC : diffBC;
                        if (diffBC < 60) continue;

                        let diffCA = Math.abs((k - i) * 10);
                        diffCA = diffCA > 180 ? 360 - diffCA : diffCA;
                        if (diffCA < 60) continue;

                        let jointScore = 0;
                        const bScores = new Map<number, number>();
                        const coveredIndices: number[] = [];

                        for (let s = 0; s < numActive; s++) {
                            const valA = scoreMatrix[i * numActive + s];
                            const valB = scoreMatrix[j * numActive + s];
                            const valC = scoreMatrix[k * numActive + s];
                            
                            const maxVal = valA > valB ? (valA > valC ? valA : valC) : (valB > valC ? valB : valC);
                            if (maxVal > 0) {
                                jointScore += maxVal;
                                const bIdx = activeSampleBIdx[s];
                                if (bIdx !== -1) {
                                    bScores.set(bIdx, (bScores.get(bIdx) || 0) + maxVal);
                                }
                                coveredIndices.push(activeSampleIndices[s]);
                            }
                        }

                        let maxSingleScore = 0;
                        for (const score of bScores.values()) {
                            if (score > maxSingleScore) maxSingleScore = score;
                        }

                        let multiplier = 1.0;
                        if (params.strictCoLocation) {
                            for (const eq of equipments) {
                                 if (Math.sqrt((eq.x - point.x)**2 + (eq.y - point.y)**2) < 2) {
                                     multiplier = 1.30; 
                                     break;
                                 }
                            }
                        }
                        
                        // Add center bonus to encourage placing nodes in the middle of a face
                        multiplier *= (1.0 + (point.centerFactor || 0) * 0.15);
                        
                        // Add edge length bonus to encourage placing on longer faces (like main building sides)
                        if (point.edgeLength) {
                            multiplier *= (1.0 + Math.min(1.0, point.edgeLength / 100) * 0.15);
                        }

                        const finalJointScore = jointScore * multiplier;

                        if (finalJointScore > 0) {
                            candidateSites.push({
                                point,
                                angles: [i * 10, j * 10, k * 10],
                                jointScore: finalJointScore,
                                maxSingleScore,
                                coveredIndices,
                                bestSingleSectorScoreForPoint
                            });
                        }
                    }
                }
            }
        }

        let bestSitePoint: (Point & { bIdx: number }) | null = null;
        let bestSiteAngles: number[] = [];
        let bestSiteScore = -1;
        let bestSiteCoveredIndices: number[] = [];
        
        for (const site of candidateSites) {
            if (site.jointScore > bestSiteScore) {
                bestSiteScore = site.jointScore;
                bestSitePoint = site.point;
                bestSiteAngles = site.angles;
                bestSiteCoveredIndices = site.coveredIndices;
            }
        }

        if (!bestSitePoint || bestSiteCoveredIndices.length === 0) {
            logs.push({
                id: 'stop', x: 0, y: 0, angle: 0, score: 0, coveredCount: 0,
                message: `Auto-optimizer ended: Unfinished targeting with remaining coordinates.`
            });
            break;
        }

        // 1. Refine each of the three best site angles using coordinate descent (+/- 15 degrees)
        const stepActiveSamples: Sample[] = [];
        const stepActiveIndices: number[] = [];
        for (let i = 0; i < samples.length; i++) {
            if (samples[i].covered) continue;
            if (bestSitePoint!.bIdx !== undefined && bestSitePoint!.bIdx === samples[i].line.bIdx) continue;
            stepActiveSamples.push(samples[i]);
            stepActiveIndices.push(i);
        }

        const refinedAngles = [...bestSiteAngles];
        for (let aIdx = 0; aIdx < 3; aIdx++) {
            let bestAngle = refinedAngles[aIdx];
            let maxJointScore = -1;
            
            // Precompute max of other two sectors for each sample
            const otherScores = stepActiveSamples.map(s => {
                const s1 = evaluateRay(bestSitePoint!, refinedAngles[(aIdx + 1) % 3], s, params, buildings);
                const s2 = evaluateRay(bestSitePoint!, refinedAngles[(aIdx + 2) % 3], s, params, buildings);
                return Math.max(s1, s2);
            });
            
            for (let offset = -15; offset <= 15; offset += 1) {
                const testAngle = (bestSiteAngles[aIdx] + offset + 360) % 360;
                let jointScore = 0;
                
                for (let i = 0; i < stepActiveSamples.length; i++) {
                    const s = stepActiveSamples[i];
                    const scoreTest = evaluateRay(bestSitePoint!, testAngle, s, params, buildings);
                    const maxS = Math.max(scoreTest, otherScores[i]);
                    
                    if (maxS > 0.05) {
                        jointScore += maxS * (s.line.isSecond ? 0.7 : 1.0);
                    }
                }
                
                if (jointScore > maxJointScore) {
                    maxJointScore = jointScore;
                    bestAngle = testAngle;
                }
            }
            refinedAngles[aIdx] = bestAngle;
        }

        const suffix = ['A', 'B', 'C'];
        const sectorCoveredPoints: Point[][] = [[], [], []];
        const sectorCoveredIndices: number[][] = [[], [], []];

        for (let i = 0; i < stepActiveSamples.length; i++) {
            const s = stepActiveSamples[i];
            const originalIdx = stepActiveIndices[i];
            let bestAngleIdx = 0;
            let maxRayScore = -1;
            for (let aIdx = 0; aIdx < 3; aIdx++) {
                const rs = evaluateRay(bestSitePoint!, refinedAngles[aIdx], s, params, buildings);
                if (rs > maxRayScore) {
                     maxRayScore = rs;
                     bestAngleIdx = aIdx;
                }
            }
            if (maxRayScore > 0.05) {
                sectorCoveredPoints[bestAngleIdx].push({x: s.x, y: s.y});
                sectorCoveredIndices[bestAngleIdx].push(originalIdx);
            }
        }

        // Sort sectors by their score contribution (highest first)
        const sectorOrder = [0, 1, 2].sort((a, b) => {
            const scoreA = sectorCoveredIndices[a].reduce((sum, idx) => sum + getWeight(samples[idx]), 0);
            const scoreB = sectorCoveredIndices[b].reduce((sum, idx) => sum + getWeight(samples[idx]), 0);
            return scoreB - scoreA;
        });

        const deployedSectors: string[] = [];
        let siteAddedCount = 0;

        // Deploy ONLY active sectors, and stop if target coverage is met or sector is too weak
        for (const aIdx of sectorOrder) {
            if (sectorCoveredPoints[aIdx].length === 0) continue; // Prune inactive sector
            if (currentCoveredScore >= targetCoveredScore) continue; // Skip if target already met
            
            // Mark samples as covered
            let sectorScore = 0;
            for (const idx of sectorCoveredIndices[aIdx]) {
                if (!samples[idx].covered) {
                    samples[idx].covered = true;
                    sectorScore += getWeight(samples[idx]);
                }
            }
            
            // If the sector provides very little new coverage (e.g. < 15 points), prune it
            if (sectorScore < 15 && deployedSectors.length > 0) continue;
            if (sectorScore < 15 && deployedSectors.length === 0) break; // Abort site if even best sector is too weak

            currentCoveredScore += sectorScore;
            
            const eqId = `AUTO-${nextSiteIdx}-${suffix[aIdx]}`;
            equipments.push({
                id: eqId,
                x: bestSitePoint.x,
                y: bestSitePoint.y,
                angle: refinedAngles[aIdx],
                bIdx: bestSitePoint.bIdx,
                coveredPoints: sectorCoveredPoints[aIdx],
                isManual: false
            });
            deployedSectors.push(`${suffix[aIdx]}(${refinedAngles[aIdx]}°)`);
            siteAddedCount += sectorCoveredIndices[aIdx].length;
        }

        if (deployedSectors.length === 0) {
            // If no sectors were deployed (e.g. they only covered already covered points), stop to prevent infinite loop
            break;
        }

        if (bestSitePoint.bIdx !== undefined && !establishedNodes.has(bestSitePoint.bIdx)) {
             establishedNodes.set(bestSitePoint.bIdx, {x: bestSitePoint.x, y: bestSitePoint.y});
         }
 
         logs.push({
             id: `SITE-${nextSiteIdx}`,
             x: Math.round(bestSitePoint.x),
             y: Math.round(bestSitePoint.y),
             angle: refinedAngles[0],
             score: Math.round(bestSiteScore * 100) / 100,
             coveredCount: bestSiteCoveredIndices.length,
             message: `[AUTO-SITE] Site #${nextSiteIdx} placed on Building #${bestSitePoint.bIdx + 1} at (${Math.round(bestSitePoint.x)}, ${Math.round(bestSitePoint.y)}). Deployed ${deployedSectors.length} active sectors: ${deployedSectors.join(', ')}. Secured ${bestSiteCoveredIndices.length} meters of building boundaries.`
         });
 
         nextSiteIdx++;
     }

    // Phase 3: Evaluate RF penetration on Second Verandas (Bonus Score only) and add spare sectors
    for (const sample of secondSamples) {
        for (const eq of equipments) {
            if (eq.bIdx !== undefined && eq.bIdx === sample.line.bIdx) continue; // No direct self-inside reception
            const score = evaluateRay(eq, eq.angle, sample, params, buildings);
            if (score > 0.05) {
                sample.covered = true;
                break; // One direct shot is enough
            }
        }
    }

    // Phase 3.5: Add spare sectors to existing sites to cover remaining 2nd verandas
    const sitesMap = new Map<string, { x: number, y: number, bIdx?: number, angles: number[], eqIds: string[] }>();
    for (const eq of equipments) {
        const key = `${eq.x},${eq.y}`;
        if (!sitesMap.has(key)) {
            sitesMap.set(key, { x: eq.x, y: eq.y, bIdx: eq.bIdx, angles: [], eqIds: [] });
        }
        const site = sitesMap.get(key)!;
        site.angles.push(eq.angle);
        site.eqIds.push(eq.id);
    }

    for (const site of sitesMap.values()) {
        while (site.angles.length < 3) {
            let bestAngle = -1;
            let bestScore = 0;
            let bestCoveredIndices: number[] = [];

            for (let aIdx = 0; aIdx < 36; aIdx++) {
                const angle = aIdx * 10;
                let isAllowed = true;
                for (const existingAngle of site.angles) {
                    let diff = Math.abs(angle - existingAngle);
                    diff = diff > 180 ? 360 - diff : diff;
                    if (diff < 60) {
                        isAllowed = false;
                        break;
                    }
                }
                if (!isAllowed) continue;

                let score = 0;
                const coveredIndices: number[] = [];
                for (let i = 0; i < secondSamples.length; i++) {
                    const sample = secondSamples[i];
                    if (sample.covered) continue;
                    if (site.bIdx !== undefined && site.bIdx === sample.line.bIdx) continue;
                    const rayScore = evaluateRay(site, angle, sample, params, buildings);
                    if (rayScore > 0.05) {
                        score += rayScore;
                        coveredIndices.push(i);
                    }
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestAngle = angle;
                    bestCoveredIndices = coveredIndices;
                }
            }

            if (bestScore > 0 && bestAngle !== -1) {
                let refinedAngle = bestAngle;
                let maxRefinedScore = -1;
                for (let offset = -10; offset <= 10; offset += 1) {
                    const testAngle = (bestAngle + offset + 360) % 360;
                    let rScore = 0;
                    for (const idx of bestCoveredIndices) {
                        const rayScore = evaluateRay(site, testAngle, secondSamples[idx], params, buildings);
                        if (rayScore > 0.05) rScore += rayScore;
                    }
                    if (rScore > maxRefinedScore) {
                        maxRefinedScore = rScore;
                        refinedAngle = testAngle;
                    }
                }

                site.angles.push(refinedAngle);
                
                const existingSuffixes = site.eqIds.map(id => id.substring(id.lastIndexOf('-') + 1));
                const missingSuffix = ['A', 'B', 'C'].find(s => !existingSuffixes.includes(s)) || 'X';
                const baseNodeId = site.eqIds[0].substring(0, site.eqIds[0].lastIndexOf('-'));
                const eqId = `${baseNodeId}-${missingSuffix}`;
                
                site.eqIds.push(eqId);
                const coveredPoints = bestCoveredIndices.map(idx => ({x: secondSamples[idx].x, y: secondSamples[idx].y}));
                
                equipments.push({
                    id: eqId,
                    x: site.x,
                    y: site.y,
                    angle: refinedAngle,
                    bIdx: site.bIdx,
                    coveredPoints: coveredPoints,
                    isManual: false
                });

                logs.push({
                    id: eqId,
                    x: Math.round(site.x),
                    y: Math.round(site.y),
                    angle: refinedAngle,
                    score: Math.round(maxRefinedScore * 100) / 100,
                    coveredCount: bestCoveredIndices.length,
                    message: `[BONUS-SECTOR] Added extra sector at (${Math.round(site.x)}, ${Math.round(site.y)}) facing ${refinedAngle}° to cover ${bestCoveredIndices.length} meters of 2nd veranda.`
                });

                for (const idx of bestCoveredIndices) {
                    secondSamples[idx].covered = true;
                }
            } else {
                break; 
            }
        }
    }

    const buildingCoverages: { 
        bIdx: number; 
        ratio: number; 
        covered: number; 
        total: number;
        secondCovered?: number;
        secondTotal?: number;
    }[] = [];

    buildings.forEach((b, idx) => {
        const bSamples = samples.filter(s => s.line.bIdx === idx && !s.line.isSecond);
        const bSecondSamples = secondSamples.filter(s => s.line.bIdx === idx);
        
        if (bSamples.length > 0 || bSecondSamples.length > 0) {
            const total1st = bSamples.length;
            const covered1st = bSamples.filter(s => s.covered).length;
            const total2nd = bSecondSamples.length;
            const covered2nd = bSecondSamples.filter(s => s.covered).length;
            
            const covered2ndWeighted = covered2nd * 0.7;
            const baseRatio = total1st > 0 ? (covered1st / total1st) * 100 : 0;
            const bonusRatio = total2nd > 0 ? (covered2ndWeighted / total2nd) * 100 : 0;
            const ratioVal = Math.min(100, baseRatio + bonusRatio);
            
            buildingCoverages.push({
                bIdx: idx,
                total: total1st,
                covered: covered1st,
                ratio: ratioVal,
                secondCovered: Math.round(covered2ndWeighted),
                secondTotal: total2nd
            });
        }
    });

    const finalCoveredScore = samples.reduce((sum, s) => sum + (s.covered ? getWeight(s) : 0), 0);

    return {
        equipments,
        coverageRatio: totalWeightSum > 0 ? (finalCoveredScore / totalWeightSum) * 100 : 0,
        coveredSamples: samples.filter(s => s.covered && !s.line.isSecond).map(s => ({x: s.x, y: s.y})),
        secondCoveredSamples: secondSamples.filter(s => s.covered).map(s => ({x: s.x, y: s.y})),
        logs,
        buildingCoverages
    };
}
