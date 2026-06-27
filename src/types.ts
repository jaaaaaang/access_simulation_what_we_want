export type Point = { x: number; y: number; centerFactor?: number; isCandidate?: boolean; edgeLength?: number };
export type Line = { start: Point; end: Point; bIdx?: number; normal?: Point; isSecond?: boolean };
export type Polygon = Point[];
export type Equipment = { id: string; x: number; y: number; angle: number; bIdx?: number; coveredPoints?: Point[]; isManual?: boolean };

export type SimulationParams = {
  beamWidth: number;
  maxRange: number;
  targetCoverage: number;
  pixelsPerMeter: number;
  strictCoLocation: boolean;
  preventAutoSectors?: boolean;
};

export type LogEntry = {
    id: string;
    x: number;
    y: number;
    angle: number;
    score: number;
    coveredCount: number;
    message: string;
};

export type SimulationResult = {
  equipments: Equipment[];
  coverageRatio: number;
  coveredSamples: Point[];
  secondCoveredSamples?: Point[];
  logs: LogEntry[];
  buildingCoverages?: { 
    bIdx: number; 
    ratio: number; 
    covered: number; 
    total: number;
    secondCovered?: number;
    secondTotal?: number;
  }[];
};
