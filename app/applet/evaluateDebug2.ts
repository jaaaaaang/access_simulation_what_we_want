import { runSimulation } from '../../src/lib/simulation';
import { Polygon, Line } from '../../src/types';

const buildings: Polygon[] = [
  [{ x: 300, y: 300 }, { x: 450, y: 300 }, { x: 450, y: 400 }, { x: 300, y: 400 }],
  [{ x: 650, y: 300 }, { x: 800, y: 300 }, { x: 800, y: 400 }, { x: 650, y: 400 }],
  [{ x: 150, y: 600 }, { x: 300, y: 600 }, { x: 300, y: 700 }, { x: 150, y: 700 }],
  [{ x: 500, y: 600 }, { x: 650, y: 600 }, { x: 650, y: 700 }, { x: 500, y: 700 }]
];

const verandas: Line[] = [
  { start: { x: 300, y: 400 }, end: { x: 450, y: 400 } },
  { start: { x: 650, y: 400 }, end: { x: 800, y: 400 } },
  { start: { x: 150, y: 600 }, end: { x: 300, y: 600 } },
  { start: { x: 500, y: 600 }, end: { x: 650, y: 600 } }
];

const params = { beamWidth: 60, maxRange: 150, targetCoverage: 0, pixelsPerMeter: 2, maxCapacity: 50, strictCoLocation: true };

const manualEquipments = [
  { id: "M-1", x: 228, y: 518, angle: 293, isManual: true, bIdx: undefined },
  { id: "M-2", x: 775, y: 520, angle: 252, isManual: true, bIdx: undefined },
  { id: "M-3", x: 483, y: 763, angle: 227, isManual: true, bIdx: undefined },
  { id: "M-4", x: 503, y: 763, angle: 322, isManual: true, bIdx: undefined }
];

const res = runSimulation(buildings, verandas, params, manualEquipments as any);
console.log(res.logs);
