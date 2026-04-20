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

    const angle_to_P = Math.atan2(sample.y - point.y, sample.x - point.x) * 180 / Math.PI;
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

    let f_d = d_m <= 70 ? 1 : (d_m <= 100 ? 0.9 : (d_m <= 150 ? 0.85 : 0));

    const vx = (point.x - sample.x) / d_px;
    const vy = (point.y - sample.y) / d_px;
    if (!sample.line.normal) return 0;
    const cos_phi = vx * sample.line.normal.x + vy * sample.line.normal.y;
    
    if (cos_phi <= 0) return 0;
    
    return cos_phi * f_d * angular_loss;
}

export function runSimulation(
    buildings: Polygon[],
    verandas: Line[],
    params: SimulationParams,
    initialEquipments: Equipment[] = []
): SimulationResult {
    const candidatePoints: (Point & {bIdx: number})[] = [];
    const step = 10; 
    
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
    const sampleStep = (params.pixelsPerMeter * 1) || 5; // 1 point = 1 meter of veranda
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

    if (samples.length === 0) {
        return { equipments: [], coverageRatio: 0, coveredSamples: [], logs: [] };
    }

    const equipments: Equipment[] = [];
    const logs: LogEntry[] = [];
    const targetCoveredCount = samples.length * (params.targetCoverage / 100);
    let currentCoveredCount = 0;
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
            currentCoveredCount++;
            newEq.coveredPoints.push({x: samples[s.idx].x, y: samples[s.idx].y});
        }
        equipments.push(newEq);
        
        if (newEq.bIdx !== undefined && !establishedNodes.has(newEq.bIdx)) {
             establishedNodes.set(newEq.bIdx, {x: newEq.x, y: newEq.y});
        }
        logs.push({
            id: newEq.id,
            x: Math.round(newEq.x), y: Math.round(newEq.y), angle: Math.round(newEq.angle),
            score: 0, coveredCount: selectedSamples.length, // Manual implies custom score mapping not needed for placement
            message: `[MANUAL] Node ${newEq.id} at (${Math.round(newEq.x)}, ${Math.round(newEq.y)}) facing ${Math.round(newEq.angle)}°. Secured ${selectedSamples.length} meters of coverage.`
        });
    }

    let maxIterations = 50; 
    
    // Phase 2: Greedy Optimizer (only runs if targetCoverage > current)
    while (currentCoveredCount < targetCoveredCount && maxIterations > 0 && candidatePoints.length > 0) {
        maxIterations--;
        let bestCandidate: Equipment | null = null;
        let bestScore = -1;
        let bestCoveredIndices: number[] = [];

        for (const point of candidatePoints) {
            if (params.strictCoLocation && establishedNodes.has(point.bIdx)) {
                const established = establishedNodes.get(point.bIdx)!;
                if (Math.abs(point.x - established.x) > 1 || Math.abs(point.y - established.y) > 1) continue;
            }

            let bestAngleScore = -1;
            let bestAngle = 0;
            let bestAngleCoveredIndices: number[] = [];
            const omniCoveredIndices = new Set<number>();

            // Find existing angles on this exact pole to prevent overlapping sectors
            const existingAngles: number[] = [];
            for (const eq of equipments) {
                if (Math.abs(eq.x - point.x) < 2 && Math.abs(eq.y - point.y) < 2) {
                    existingAngles.push(eq.angle);
                }
            }

            for (let angle = 0; angle < 360; angle += 10) {
                // Skip angles that are too close to existing equipments on the same pole
                let isOverlap = false;
                for (const ea of existingAngles) {
                    let diff = Math.abs(ea - angle);
                    diff = diff > 180 ? 360 - diff : diff;
                    if (diff < Math.max(params.beamWidth * 0.7, 30)) { // Require angular separation
                        isOverlap = true;
                        break;
                    }
                }
                if (isOverlap) continue;

                const scoredSamples: {idx: number, score: number}[] = [];

                for (let i = 0; i < samples.length; i++) {
                    if (samples[i].covered) continue;
                    if (point.bIdx !== undefined && point.bIdx === samples[i].line.bIdx) continue;
                    
                    const score = evaluateRay(point, angle, samples[i], params, buildings);
                    if (score > 0.05) {
                        scoredSamples.push({idx: i, score});
                        omniCoveredIndices.add(i);
                    }
                }
                
                scoredSamples.sort((a, b) => b.score - a.score);
                const selectedSamples = scoredSamples;
                const score = selectedSamples.reduce((sum, s) => sum + s.score, 0);

                if (score > bestAngleScore) {
                    bestAngleScore = score;
                    bestAngle = angle;
                    bestAngleCoveredIndices = selectedSamples.map(s => s.idx);
                }
            }

            // Heuristic for strict co-location: strongly favor pole locations that have a high total 360-degree visibility
            // This prevents the "Greedy Trap" where a corner is picked for 1 extra point, sacrificing multi-sector potential.
            let finalScore = bestAngleScore;
            // Only apply omni bonus if it's a NEW pole being established
            if (params.strictCoLocation && point.bIdx !== undefined && !establishedNodes.has(point.bIdx)) {
                finalScore += (omniCoveredIndices.size * 0.2); // 0.2 weight ensures multi-visibility strongly pulls the node
            }

            if (finalScore > bestScore && bestAngleScore > 0) {
                bestScore = finalScore;
                bestCandidate = { id: `AUTO-${equipments.length + 1}`, x: point.x, y: point.y, angle: bestAngle, bIdx: point.bIdx, isManual: false };
                bestCoveredIndices = bestAngleCoveredIndices;
            }
        }

        if (!bestCandidate || bestCoveredIndices.length === 0) {
            logs.push({
                id: 'stop', x: 0, y: 0, angle: 0, score: 0, coveredCount: 0,
                message: `Auto-optimizer stopped: Target unreachable with remaining locations.`
            });
            break; 
        }

        bestCandidate.coveredPoints = [];
        for (const idx of bestCoveredIndices) {
            samples[idx].covered = true;
            currentCoveredCount++;
            bestCandidate.coveredPoints.push({x: samples[idx].x, y: samples[idx].y});
        }
        equipments.push(bestCandidate);

        if (bestCandidate.bIdx !== undefined && !establishedNodes.has(bestCandidate.bIdx)) {
             establishedNodes.set(bestCandidate.bIdx, {x: bestCandidate.x, y: bestCandidate.y});
        }
        
        logs.push({
            id: bestCandidate.id,
            x: Math.round(bestCandidate.x),
            y: Math.round(bestCandidate.y),
            angle: bestCandidate.angle,
            score: Math.round(bestScore * 100) / 100,
            coveredCount: bestCoveredIndices.length,
            message: `[AUTO] Node ${bestCandidate.id} placed facing ${bestCandidate.angle}°. (Score: ${Math.round(bestScore * 100) / 100}). Secured ${bestCoveredIndices.length} meters of coverage.`
        });
    }

    const buildingCoverages: { bIdx: number; ratio: number; covered: number; total: number }[] = [];
    buildings.forEach((b, idx) => {
        const bSamples = samples.filter(s => s.line.bIdx === idx);
        if (bSamples.length > 0) {
            const covered = bSamples.filter(s => s.covered).length;
            buildingCoverages.push({
                bIdx: idx,
                total: bSamples.length,
                covered: covered,
                ratio: (covered / bSamples.length) * 100
            });
        }
    });

    return {
        equipments,
        coverageRatio: (currentCoveredCount / samples.length) * 100,
        coveredSamples: samples.filter(s => s.covered).map(s => ({x: s.x, y: s.y})),
        logs,
        buildingCoverages
    };
}
