import { evaluateRay } from './src/lib/simulation';
import { Polygon, Point, Line } from './src/types';

const buildings: Polygon[] = [
  [{ x: 300, y: 300 }, { x: 450, y: 300 }, { x: 450, y: 400 }, { x: 300, y: 400 }],
  [{ x: 650, y: 300 }, { x: 800, y: 300 }, { x: 800, y: 400 }, { x: 650, y: 400 }],
  [{ x: 150, y: 600 }, { x: 300, y: 600 }, { x: 300, y: 700 }, { x: 150, y: 700 }],
  [{ x: 500, y: 600 }, { x: 650, y: 600 }, { x: 650, y: 700 }, { x: 500, y: 700 }]
];

const eq = { id: "M-1", x: 228, y: 518, angle: 293, isManual: true };
const sample = {
  x: 375, y: 400, covered: false,
  line: { start: { x: 300, y: 400 }, end: { x: 450, y: 400 }, normal: {x: 0, y: 1}, bIdx: 0 }
};

const params = { beamWidth: 60, maxRange: 150, targetCoverage: 65, pixelsPerMeter: 2, maxCapacity: 50 };

console.log("Evaluating Ray...");
const score = evaluateRay(eq as any, eq.angle, sample as any, params, buildings);
console.log("SCORE:", score);
