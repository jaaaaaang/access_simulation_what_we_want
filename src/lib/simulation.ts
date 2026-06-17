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

function distToPolygon(p: Point, poly: Polygon) {
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
    point: { x: number; y: number; bIdx?: number },
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
                    continue; // Skip own building: transmitter on the roof is not blocked by itself
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
    const step = 10; 
    
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
                    bIdx
                });
            }
        }
    });

    // Solve standard verandas and map their outward normal vectors
    verandas.forEach((line) => {
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
        line.isSecond = false;

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

    // Extract second verandas (representing long sides of concrete buildings)
    const secondVerandas = getSecondVerandas(buildings);

    type Sample = Point & { line: Line, covered: boolean };
    const samples: Sample[] = [];
    const secondSamples: Sample[] = [];
    const sampleStep = (params.pixelsPerMeter * 1) || 5; // 1 point = 1 meter of veranda
    
    // Populate standard veranda samples
    verandas.forEach(line => {
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

    // Populate second veranda (building long sides) samples for bonus rating ONLY (not in target denominator)
    secondVerandas.forEach(line => {
        const len = distance(line.start, line.end);
        const steps = Math.ceil(len / sampleStep);
        for (let i = 0; i <= steps; i++) {
            const t = steps === 0 ? 0 : i / steps;
            secondSamples.push({
                x: line.start.x + (line.end.x - line.start.x) * t,
                y: line.start.y + (line.end.y - line.start.y) * t,
                line,
                covered: false
            });
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
    
    // Phase 2: Tri-Sector Site Greedy Optimizer (3분기 고정 배치)
    while (currentCoveredScore < targetCoveredScore && maxIterations > 0 && candidatePoints.length > 0) {
        maxIterations--;
        let bestSitePoint: (Point & { bIdx: number }) | null = null;
        let bestSiteAngles: number[] = [0, 120, 240];
        let bestSiteScore = -1;
        let bestSiteCoveredIndices: number[] = [];

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
            
            // 2. Precompute the raw ray score of each sector direction (from 0 to 350 deg, in steps of 10)
            // for all active samples
            const scoreMatrix = new Float32Array(36 * numActive);
            const angleScores = new Float32Array(36);

            for (let aIdx = 0; aIdx < 36; aIdx++) {
                const angle = aIdx * 10;
                let activeAngleScore = 0;
                for (let s = 0; s < numActive; s++) {
                    const globalIdx = activeSampleIndices[s];
                    const rayScore = evaluateRay(point, angle, samples[globalIdx], params, buildings);
                    if (rayScore > 0.05) {
                        const weightedScore = rayScore * getWeight(samples[globalIdx]);
                        scoreMatrix[aIdx * numActive + s] = weightedScore;
                        activeAngleScore += weightedScore;
                    }
                }
                angleScores[aIdx] = activeAngleScore;
            }

            // 3. Find the combination of 3 sectors spaced >= 80 degrees with maximum joint coverage
            let maxJointScore = -1;
            let best3Angles: number[] = [0, 120, 240];

            for (let i = 0; i < 36; i++) {
                if (angleScores[i] === 0) continue; // Skip inactive directions to save calculations

                for (let j = i + 1; j < 36; j++) {
                    let diffAB = Math.abs((i - j) * 10);
                    diffAB = diffAB > 180 ? 360 - diffAB : diffAB;
                    if (diffAB < 80) continue;

                    for (let k = j + 1; k < 36; k++) {
                        let diffBC = Math.abs((j - k) * 10);
                        diffBC = diffBC > 180 ? 360 - diffBC : diffBC;
                        if (diffBC < 80) continue;

                        let diffCA = Math.abs((k - i) * 10);
                        diffCA = diffCA > 180 ? 360 - diffCA : diffCA;
                        if (diffCA < 80) continue;

                        // Joint coverage: sum of maximum weighted score across the 3 sectors for each active sample
                        let jointScore = 0;
                        for (let s = 0; s < numActive; s++) {
                            const valA = scoreMatrix[i * numActive + s];
                            const valB = scoreMatrix[j * numActive + s];
                            const valC = scoreMatrix[k * numActive + s];
                            
                            const maxVal = valA > valB ? (valA > valC ? valA : valC) : (valB > valC ? valB : valC);
                            jointScore += maxVal;
                        }

                        // Colocation booster
                        let multiplier = 1.0;
                        if (params.strictCoLocation) {
                            for (const eq of equipments) {
                                 if (Math.sqrt((eq.x - point.x)**2 + (eq.y - point.y)**2) < 2) {
                                     multiplier = 1.30; 
                                     break;
                                 }
                            }
                        }
                        const finalJointScore = jointScore * multiplier;

                        if (finalJointScore > maxJointScore) {
                            maxJointScore = finalJointScore;
                            best3Angles = [i * 10, j * 10, k * 10];
                        }
                    }
                }
            }

            if (maxJointScore > bestSiteScore && maxJointScore > 0) {
                bestSiteScore = maxJointScore;
                bestSitePoint = point;
                bestSiteAngles = best3Angles;
                
                // Collect covered global samples for the best selected angle combination
                const aIdx0 = best3Angles[0] / 10;
                const aIdx1 = best3Angles[1] / 10;
                const aIdx2 = best3Angles[2] / 10;

                bestSiteCoveredIndices = [];
                for (let s = 0; s < numActive; s++) {
                    if (scoreMatrix[aIdx0 * numActive + s] > 0 || 
                        scoreMatrix[aIdx1 * numActive + s] > 0 || 
                        scoreMatrix[aIdx2 * numActive + s] > 0) {
                        bestSiteCoveredIndices.push(activeSampleIndices[s]);
                    }
                }
            }
        }

        if (!bestSitePoint || bestSiteCoveredIndices.length === 0) {
            logs.push({
                id: 'stop', x: 0, y: 0, angle: 0, score: 0, coveredCount: 0,
                message: `Auto-optimizer ended: Unfinished targeting with remaining coordinates.`
            });
            break; 
        }

        const angles = bestSiteAngles;
        const suffix = ['A', 'B', 'C'];
        const sectorCoveredPoints: Point[][] = [[], [], []];

        for (const idx of bestSiteCoveredIndices) {
            samples[idx].covered = true;
            currentCoveredScore += getWeight(samples[idx]);
            
            const s = samples[idx];
            let bestAngleIdx = 0;
            let maxRayScore = -1;
            for (let aIdx = 0; aIdx < 3; aIdx++) {
                const rs = evaluateRay(bestSitePoint, angles[aIdx], s, params, buildings);
                if (rs > maxRayScore) {
                     maxRayScore = rs;
                     bestAngleIdx = aIdx;
                }
            }
            sectorCoveredPoints[bestAngleIdx].push({x: s.x, y: s.y});
        }

        // Deploy the 3 co-located equipments representing the tri-sector site
        for (let aIdx = 0; aIdx < 3; aIdx++) {
            const eqId = `AUTO-${nextSiteIdx}-${suffix[aIdx]}`;
            equipments.push({
                id: eqId,
                x: bestSitePoint.x,
                y: bestSitePoint.y,
                angle: angles[aIdx],
                bIdx: bestSitePoint.bIdx,
                coveredPoints: sectorCoveredPoints[aIdx],
                isManual: false
            });
        }

        if (bestSitePoint.bIdx !== undefined && !establishedNodes.has(bestSitePoint.bIdx)) {
             establishedNodes.set(bestSitePoint.bIdx, {x: bestSitePoint.x, y: bestSitePoint.y});
         }
 
         logs.push({
             id: `SITE-${nextSiteIdx}`,
             x: Math.round(bestSitePoint.x),
             y: Math.round(bestSitePoint.y),
             angle: angles[0],
             score: Math.round(bestSiteScore * 100) / 100,
             coveredCount: bestSiteCoveredIndices.length,
             message: `[AUTO-SITE] Tri-Sector Site #${nextSiteIdx} placed on Building #${bestSitePoint.bIdx + 1} at (${Math.round(bestSitePoint.x)}, ${Math.round(bestSitePoint.y)}) facing optimized dirs ${angles.join('°/')}. Secured ${bestSiteCoveredIndices.length} meters of building boundaries.`
         });
 
         nextSiteIdx++;
     }

    // Phase 3: Evaluate RF penetration on Second Verandas (Bonus Score only)
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

    const buildingCoverages: { 
        bIdx: number; 
        ratio: number; 
        covered: number; 
        total: number;
        secondCovered?: number;
        secondTotal?: number;
    }[] = [];

    buildings.forEach((b, idx) => {
        const bSamples = samples.filter(s => s.line.bIdx === idx);
        const bSecondSamples = secondSamples.filter(s => s.line.bIdx === idx);
        
        if (bSamples.length > 0 || bSecondSamples.length > 0) {
            const covered = bSamples.filter(s => s.covered).length;
            const secondCovered = bSecondSamples.filter(s => s.covered).length;
            
            buildingCoverages.push({
                bIdx: idx,
                total: bSamples.length,
                covered: covered,
                ratio: bSamples.length > 0 ? (covered / bSamples.length) * 100 : 0,
                secondCovered: secondCovered,
                secondTotal: bSecondSamples.length
            });
        }
    });

    return {
        equipments,
        coverageRatio: totalWeightSum > 0 ? (currentCoveredScore / totalWeightSum) * 100 : 0,
        coveredSamples: samples.filter(s => s.covered).map(s => ({x: s.x, y: s.y})),
        secondCoveredSamples: secondSamples.filter(s => s.covered).map(s => ({x: s.x, y: s.y})),
        logs,
        buildingCoverages
    };
}
