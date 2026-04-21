# Telecom RF Simulation : Logic & Guidelines Blueprint

## 1. Overview
This simulation application evaluates and optimizes Radio Frequency (RF) coverage for telecom equipment placed on or between buildings. Its primary objective is to determine how well telecom equipment (antennas) can cover specified target areas (verandas/windows of buildings) under geometric and physical constraints.

## 2. Terminology & Definitions
- **Pixels To Meters**: All physical constraints (Distance, Limit) are calculated by scaling the UI screen coordinate (pixel) into meters via a set `pixelsPerMeter` parameter.
- **Building (Polygon)**: An obstruction model. RF rays cannot pass through a building array. 
- **Veranda (Line)**: The target segments on buildings that require coverage. These lines represent windows or external structures where coverage is needed.
- **Node/Equipment (Point & Angle)**: The RF transceivers. Defined by properties: `(x, y)` location, `angle` (boresight direction in degrees: 0° is North/Up, 90° is East/Right), and an `id`.
- **Target Points (`samples`)**: To measure physical coverage continuously, verandas are broken down into discretely sampled coordinates. Each point represents exactly **1 Meter** of physical veranda distance (calculated dynamically based on `pixelsPerMeter`). There is no artificial point cap (`maxCapacity` is fully removed), allowing realistic open-ended volume evaluation.

## 3. Core Parameters (`SimulationParams`)
- **`beamWidth` (degrees)**: The main functional sector spread of the antenna where coverage is optimal.
- **`maxRange` (meters)**: The absolute maximum distance a signal can travel and still be viable.
- **`targetCoverage` (%)**: The goal threshold. The Auto-optimizer runs until it reaches this overall coverage percentage.
- **`pixelsPerMeter`**: The translation ratio from canvas pixels to physical meters.
- **`strictCoLocation` (Global Pole Minimization)**: If true, drastically favors grouping multiple equipment units (sectors) onto the **exact same physical pole**, even if the equipment targets entirely different buildings across the map. Minimizes physical infrastructure, cabling, and power construction costs.

## 4. Simulation Engine Flow (`src/lib/simulation.ts`)

### Step 4.1: Preprocessing & Sampling
Verandas are not stored as solid blocks but rather iteratively broken down into discrete "Sample Points".
- A sampling step is strictly defined as `1 meter` (scaled by `pixelsPerMeter`). 
- A point representation is generated for each 1m span of all veranda lines.
- These points represent real physical space; if a node hits 100 points, it secures exactly 100 meters of RF coverage.

### Step 4.2: Distance, Obstruction, & Ray Tracing (`evaluateRay` function)
To define if a sample point receives coverage from a specific Node, the `evaluateRay` function mathematically computes viability:
1. **Geometric Angle Correction**: Calibrates the mathematical vectors (`Math.atan2`) with standard display North mapping to ensure raycast direction perfectly aligns with the UI rendering (Angle 0 = Top/12 o'clock).
2. **Range Validation**: Calculate physical distance `d`. If `d > maxRange`, score = 0.
3. **Angle Assessment**: Compute the angle difference between the target point and the equipment's boresight (`angle`).
4. **Beam Loss Formula**:
   - *Main Lobe* (`diff <= beamWidth / 2`): Minimal loss. Applies a cosine-based spatial decay.
   - *Diffraction / Edge Leakage Zone* (Between `beamWidth/2` and `beamWidth/2 + 15°`): The signal is heavily distorted/diffracted but exists. Applies a steep linear degradation penalty scaling from `0.5` down to `0`.
   - *Out of Bounds* (`diff > beamWidth/2 + 15°`): Signal = 0.
5. **Line of Sight (LOS) Collision Evaluation**: Raycasts towards the target point step by step. If the ray intersects a Polygon inside the map (other than the bounds of the source/target offsets), it is labeled "blocked" and score = 0.
6. **Distance Attenuation**: Closer points are inherently easier to serve. Creates a structural weight multiplier `f_d` where distances <= 70m get maximum value, and decay further out. 
7. **Incidence Vector Adjustment**: Examines the normal vector of the veranda surface against the ray to calculate the angle of incidence. Direct perpendicular hits maximize the score, oblique glancing hits drastically lower it.

*Returns*: A decimal Score `> 0` if covered, or `0` if impossible.

### Step 4.3: Manual Equipment Bootstrapping (Phase 1)
Pre-placed (manually drawn by the user) nodes are processed first. `evaluateRay` is iterated over every sample point. Any point scoring `> 0.05` is flagged as 'Covered' and added to that Node's total secured meters constraint.

### Step 4.4: Greedy Auto-Optimizer Algorithm (Phase 2)
If the pre-placed nodes do not satisfy the `targetCoverage` percentage, the AI-like greedy loop steps in:
1. **Candidate Points Initialization**: Every edge (corner and perimeter) of every building Polygon is indexed as a candidate physical pole location.
2. **Optimizer Loop**:
   - Iterates through ALL Candidate points repeatedly for unused sample points until `currentCoveredCount` >= `targetCoveredCount` or iterations exhaust.
   - For each Candidate point, rotates virtually 360° (in 10° steps).
   - *Cross-Building Global Colocation Bonus*: If `strictCoLocation` is enabled, candidate points that land on an ALREADY established pole anywhere globally receive a massive **1.30x (30%) multiplier score bonus**. This definitively forces the algorithm to avoid spinning up new poles for new buildings, highly favoring putting a 2nd or 3rd sector directly on top of an existing pole, drastically reducing network rollout costs.
   - *Interference constraint*: Tests to ensure the angle inside grouped nodes avoids violent angular overlap (`beamwidth*0.7` separation required).
   - *Evaluation summation*: Accumulates total quality `score` for valid targets.
3. **Decisive Placement**: Selects the absolute best scoring `(Location, Angle)` pair out of the global matrix, records it, adds covered targets to the tracker, and writes the `establishedNodes` global footprint to encourage future colocation snapping.

## 5. Scoring Metrics Detailed
- The total **Score** recorded in logs is *not* a straight count of meters. It is the cumulative qualitative mathematical sum output by `evaluateRay`: `{Incidence M.} * {Distance M.} * {Beam Edge Loss M.}`.
- **Secured Coverage (Meters)**: The absolute raw number of sample points hit (1 point = 1 meter).
- **Average Quality Efficiency**: Mathematically defined as `(Score / Meters) * 100`. 
   - *High Efficiency (e.g., >110%)*: Indicates a golden placement. Meticulously perpendicular beam angles, very close range, hitting the target dead center.
   - *Low Efficiency (e.g., <60%)*: Implies a highly degraded RF link. Covering points only barely via refraction edges, extreme oblique angles, crossing the map limits. Suggests low ROI (Return on Investment).

## 6. AI Insights Generation & Heuristics
When the simulation finishes, a structured data payload with the simulation parameters, global arrays, and per-node efficiencies is sent to `gemini-3.1-pro-preview` via `@google/genai`. 
- **Direct Output Format**: The AI is instructed to output strictly in professional Korean, outputting raw Markdown cleanly without any conversational filler or introductions.
- **Node Culling Identification**: Armed with the the explicit "Average Quality Efficiency" derived above, the AI is explicitly directed to hunt for inefficient "surplus" equipment nodes. If Node 4 technically adds 50 meters of coverage but runs at a dismal 50% Quality Efficiency rate, the AI acts as the domain expert, analyzing whether the infrastructure investment validates the marginal network gain, ultimately suggesting node removals and consolidations.

## 7. Simulation Logging & Export
- **Absolute Positioning in Logs**: Every auto-placed and manually-placed equipment tracks exactly where it was placed. If it intersects or snaps to a building constraint, it outputs the unique 1-based building ID (e.g., `Building #2`) and absolute X/Y coordinate vector, resolving context gaps in plain-text logs.
- **ZIP Payload Export**: Users can download a localized `rf_simulation_results.zip` package locally containing:
   - `simulation_result.png`: A direct snapshot string generated identically from the underlying HTML `<canvas>` representation.
   - `simulation_report.txt`: Includes complete input topology heuristics, runtime parameters, the absolute location tracking log output, and the localized markdown response from the AI heuristics model.
