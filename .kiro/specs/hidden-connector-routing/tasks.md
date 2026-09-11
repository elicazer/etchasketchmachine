# Implementation Plan: Hidden Connector Routing

## Overview

Build the opt-in `Connector_Router` that routes inter-stroke connectors over
already-drawn ink and envelope edges to minimize visible (Exposed) travel, while
guaranteeing byte-for-byte identical output when the feature is off. The work
proceeds bottom-up inside the new `web/src/path/connector_router.ts` module
(types → `DrawnInkIndex` → overlap classification → `routeConnector` candidate
generation/selection → guards/budget), then wires the router into
`web/src/path/stitch.ts` (opt-in branch + `stitchPolylinesWithReport`, default
branch untouched) and `web/src/path/planner.ts` (`PlanOptions.connectorHiding` +
`routerOptions`, `ConnectorHidingReport`). The 15 design Correctness Properties
each become a tagged fast-check property test (≥100 iterations), complemented by
guard/edge/example/budget tests and a single 1000-stroke performance test. The
Python mirror in `tools/imagepath_service/` is explicitly optional and additive.

Each task references the requirement clauses and/or design property numbers it
implements. Tasks build incrementally and end with everything wired together;
there is no orphaned code.

## Tasks

- [x] 1. Create the router module skeleton and shared types
  - Create `web/src/path/connector_router.ts` importing `Point`, `PlannedSegment` from `../types`
  - Define and export `StepEnvelope`, `InkSegment`, `ConnectorResult`, and `RouterOptions` interfaces exactly as in the design's Components section
  - Declare the public signatures `class DrawnInkIndex`, `routeConnector(exit, entry, ink, env, opts)` returning `ConnectorResult` (stub bodies that fall back to the straight 2-point connector for now), with documented defaults `maxCandidates = 32`, `maxPoints = 1000`, `timeBudgetMs = 5000`
  - Add a small private Chebyshev helper `chebyshev(a, b) = max(|dx|, |dy|)` and a `RouterOptions` clamping helper (clamp `maxPoints` to ≥ 2, `maxCandidates` to ≥ 1, `timeBudgetMs` to ≥ 0) consistent with the planner's range-clamping style
  - _Requirements: 2.2, 3.1, 6.5, 8.2_

- [x] 2. Implement the DrawnInkIndex spatial occupancy structure
  - [x] 2.1 Implement the uniform-grid index
    - Implement the constructor `(env, cellSize?)` choosing `cellSize ≈ max(1, round(maxDim / sqrt(expectedSegments)))` when not supplied
    - Implement `add(segment)`: split a multi-point `PlannedSegment` into one `InkSegment {a, b}` per adjacent vertex pair and insert each into every grid cell its 1-step-grown bounding box overlaps, using an integer DDA/Bresenham walk so diagonal ink registers in all crossed cells; also store ink endpoints in per-cell endpoint buckets
    - Implement `nearbyEndpoints(p, radius)` returning only local endpoints from `p`'s cell and neighbors within `radius`
    - Implement `coveringSegments(p)` returning ink in `p`'s cell plus the 8 neighbors
    - Represent the four inclusive `Step_Envelope` perimeter edges as implicit `InkSegment`s consulted alongside grid contents
    - _Requirements: 1.3, 1.4, 8.1, 8.2_

  - [x] 2.2 Write unit tests for DrawnInkIndex
    - In `web/src/path/drawn_ink_index.test.ts`: assert `add` registers horizontal, vertical, and diagonal sub-segments in all overlapped cells; `nearbyEndpoints`/`coveringSegments` return local results only; envelope edges are present before any stroke is added
    - _Requirements: 1.3, 1.4_

- [x] 3. Implement overlap classification and Chebyshev accounting
  - [x] 3.1 Implement isHidden and per-leg Hidden/Exposed splitting
    - Implement `DrawnInkIndex.isHidden(a, b)`: true iff `[a, b]` is collinear with and contained within some covering `InkSegment` or envelope edge to within a perpendicular distance of 1 integer step
    - Implement a `classifyRoute(points, ink)` helper that walks each adjacent leg, splits it at the integer step where coverage changes, charges each step as Hidden (covered) or Exposed (gap > 1 step), reclassifies an unhideable Hidden leg as Exposed (flagging it) while retaining the route, and returns `{ hiddenTravel, exposedTravel, totalTravel }` with `hidden + exposed == total` exactly
    - _Requirements: 1.1, 1.4, 10.1, 10.2, 10.3, 10.4_

  - [x] 3.2 Write unit tests for classification and conservation
    - In `web/src/path/connector_classification.test.ts`: assert a leg lying on ink is Hidden, a gap leg is Exposed, a partly-covered leg splits at the coverage boundary, an envelope-edge leg is fully Hidden, and `hidden + exposed == total` for hand-built routes
    - _Requirements: 10.1, 10.3, 10.4_

- [x] 4. Implement routeConnector candidate generation and selection
  - Replace the stub `routeConnector` body with the snap-to-ink, traverse-along-ink heuristic: query `nearbyEndpoints(exit, R)` / `nearbyEndpoints(entry, R)` plus nearest points on each envelope edge, growing `R` geometrically over rounds; build 3-phase `approach → traverse → depart` candidate routes (`exit → sExit → …along ink…→ junction → …along ink…→ sEntry → entry`)
  - Compute the straight baseline `straightLen = chebyshev(exit, entry)` and evaluate each candidate via `classifyRoute`
  - Implement selection: (1) minimize Exposed_Travel, (2) tie → minimize total Chebyshev length, (3) tie → choose the route whose ordered point-coordinate sequence is lexicographically smallest (x before y, shorter prefix smaller), leaving no tie unresolved
  - Use no randomness, wall-clock, or external mutable state so the result depends only on the arguments
  - _Requirements: 1.1, 1.2, 1.5, 3.1, 3.2, 3.3, 5.3_

- [x] 5. Implement guards, fallback, and budget handling
  - Apply guards in order to each selected route, falling back to the straight 2-point connector on any failure: collapse consecutive duplicate points (preserve first/last); require `2 ≤ points ≤ maxPoints` after collapse else `rejected`; require every adjacent pair differs in ≥ 1 coordinate; require first point `== exit` and last `== entry` exactly; require every route point and every traversed integer step inside the inclusive envelope else report containment failure and fall back; require `exposedTravel < straightLen` strictly else emit straight with `fellBack = true`
  - Short-circuit to the straight fallback (no hiding search) when the ink set is empty / `i == 0`
  - Enforce the per-connector candidate cap (`maxCandidates`, default 32): stop evaluating and emit the best strictly-improving route found so far, else straight
  - Populate `ConnectorResult` fields (`segment`, `hiddenTravel`, `exposedTravel`, `totalTravel`, `fellBack`, `rejected`) for every outcome
  - _Requirements: 2.1, 2.3, 2.4, 2.6, 2.7, 4.1, 4.2, 4.3, 4.4, 5.2, 6.1, 6.2, 6.3, 6.4, 6.5, 8.3_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Wire the router into the stitcher
  - In `web/src/path/stitch.ts`: extend `StitchOptions` with `connectorHiding?: boolean`, `env?: StepEnvelope`, and `routerOptions?: RouterOptions`
  - Keep the default branch byte-for-byte unchanged: when `connectorHiding` is falsy, run the existing straight-connector loop verbatim
  - Add the opt-in branch: after the SAME `orderPolylinesNearestNeighbor` call, weave connectors incrementally by maintaining a `DrawnInkIndex` of everything emitted so far and calling `routeConnector(current, segStart, ink, env, routerOptions)` per gap, adding each emitted stroke and routed connector to the index before the next gap
  - Add `stitchPolylinesWithReport(polys, opts)` returning `{ segments, connectors: ConnectorResult[] }`; have `stitchPolylines` delegate to it and return only `segments`
  - Enforce the global `timeBudgetMs` between connectors via an injected clock: once exceeded, emit all remaining gaps as straight connectors and still return a complete plan
  - _Requirements: 1.3, 6.4, 7.2, 7.5, 7.6, 8.4_

- [x] 8. Wire the router and report into the planner
  - In `web/src/path/planner.ts`: add `connectorHiding?: boolean` and `routerOptions?: RouterOptions` to `PlanOptions` (default disabled, independent of `twoOpt` and all other options), and export the `ConnectorHidingReport` interface
  - In the envelope-fit branch, call `stitchPolylinesWithReport(simplified, { start: home, twoOpt: true, connectorHiding: true, env, routerOptions })` when `connectorHiding` is set, otherwise keep the existing `stitchPolylines(simplified, { start: home, twoOpt: true })` call unchanged
  - Aggregate per-connector `ConnectorResult`s into a `ConnectorHidingReport` (sum Hidden/Exposed; classify each connector fully hidden / partially hidden / not hidden; counts sum to connector total) and surface it via a `planWithReport()` accessor returning `PlannedPath & { connectorHiding?: ConnectorHidingReport }`
  - When `connectorHiding` is off, compute the off-mode report: each connector's full Chebyshev length is Exposed, `totalHiddenTravel == 0`, all connectors classified not hidden
  - Leave `appendReturnToHome` / `appendEdgeReturnToHome` as the unchanged home-return mechanism
  - _Requirements: 7.1, 7.3, 7.4, 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Write router-level property tests (fast-check, ≥100 iterations each)
  - [x] 10.1 Property 1 - never increase visible ink
    - In `web/src/path/connector_router.minimize.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 1: ...`
    - Assert emitted connector `exposedTravel ≤ chebyshev(exit, entry)` for random ink/endpoints/envelopes
    - **Property 1: Never increase visible ink**
    - **Validates: Requirements 1.1, 5.1, 5.4**

  - [x] 10.2 Property 2 - strictly-improving route is chosen when one exists
    - In `web/src/path/connector_router.minimize.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 2: ...`
    - Generate ink that deliberately covers the gap; assert a routed multi-point connector is emitted with the minimum, strictly-lower Exposed among evaluated candidates
    - **Property 2: Strictly-improving route is chosen when one exists**
    - **Validates: Requirements 1.1, 1.2, 5.2, 5.3**

  - [x] 10.3 Property 3 - fallback to the straight 2-point connector
    - In `web/src/path/connector_router.minimize.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 3: ...`
    - Use empty/irrelevant ink (and Exposed-equals-straight candidates); assert the emitted connector is exactly `[exit, entry]`
    - **Property 3: Fallback to the straight 2-point connector**
    - **Validates: Requirements 1.6, 5.2, 6.1, 6.2, 6.3**

  - [x] 10.4 Property 5 - point-count bound and segment kind
    - In `web/src/path/connector_router.invariants.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 5: ...`
    - Assert every emitted connector has `kind: 'connector'` and `2 ≤ pointsSteps.length ≤ 1000`
    - **Property 5: Point-count bound and segment kind**
    - **Validates: Requirements 2.2, 2.7**

  - [x] 10.5 Property 6 - no zero-length sub-segments
    - In `web/src/path/connector_router.invariants.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 6: ...`
    - Assert every adjacent point pair differs in ≥ 1 integer coordinate
    - **Property 6: No zero-length sub-segments**
    - **Validates: Requirements 2.3**

  - [x] 10.6 Property 7 - consecutive-duplicate collapse
    - In `web/src/path/connector_router.invariants.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 7: ...`
    - Assert collapsing yields no consecutive duplicates, preserves first/last, and is idempotent
    - **Property 7: Consecutive-duplicate collapse**
    - **Validates: Requirements 2.4**

  - [x] 10.7 Property 8 - determinism and tie-break
    - In `web/src/path/connector_router.determinism.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 8: ...`
    - Assert repeated invocations on equal-value inputs return identical point sequences, and equal-Exposed/equal-total ties resolve to the lexicographically smallest route
    - **Property 8: Determinism**
    - **Validates: Requirements 1.5, 3.1, 3.2, 3.3**

  - [x] 10.8 Property 9 - Drawn_Ink reorder invariance
    - In `web/src/path/connector_router.determinism.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 9: ...`
    - Shuffle the same ink value set before a second invocation; assert identical point sequences
    - **Property 9: Drawn_Ink reorder invariance**
    - **Validates: Requirements 3.4**

  - [x] 10.9 Property 10 - envelope containment of every traversed step
    - In `web/src/path/connector_router.geometry.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 10: ...`
    - Assert every route point and every traversed integer step satisfies `0 ≤ x ≤ env.x`, `0 ≤ y ≤ env.y`
    - **Property 10: Envelope containment of every traversed step**
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [x] 10.10 Property 15 - Hidden/Exposed classification and conservation
    - In `web/src/path/connector_router.geometry.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 15: ...`
    - Assert each Hidden leg is collinear-and-contained within ink/edge to 1 step, gap legs > 1 step are Exposed, and `hiddenTravel + exposedTravel == totalTravel` with each step counted once
    - **Property 15: Hidden/Exposed classification and conservation**
    - **Validates: Requirements 1.4, 10.1, 10.3, 10.4**

- [x] 11. Write planner/stitch-level property tests (fast-check, ≥100 iterations each)
  - [x] 11.1 Property 4 - continuity and endpoint anchoring
    - In `web/src/path/planner_hiding.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 4: ...`
    - On hiding-enabled plans, assert every connector's first point `== exit`, last point `== entry`, and each segment's last point equals the next segment's first point exactly
    - **Property 4: Continuity and endpoint anchoring**
    - **Validates: Requirements 2.1, 2.5, 6.5**

  - [x] 11.2 Property 11 - opt-in identity (off ⇒ byte-for-byte unchanged)
    - In `web/src/path/planner_hiding.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 11: ...`
    - Assert `plan(input, { connectorHiding: false, ... })` is deep-equal (byte-for-byte) to `plan(input, { ... })` with the option absent, including the woven straight connectors
    - **Property 11: Opt-in identity (off ⇒ unchanged)**
    - **Validates: Requirements 7.1, 7.2**

  - [x] 11.3 Property 12 - stroke order/orientation invariance
    - In `web/src/path/planner_hiding.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 12: ...`
    - For either `twoOpt` value, assert the ordered `stroke` segments (order and per-stroke point sequences) are identical whether hiding is on or off
    - **Property 12: Stroke order/orientation invariance**
    - **Validates: Requirements 7.5, 7.6**

  - [x] 11.4 Property 13 - observability report aggregation
    - In `web/src/path/planner_hiding.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 13: ...`
    - Assert `totalHiddenTravel`/`totalExposedTravel` equal the per-connector sums (non-negative integers), each connector classified fully/partially/not hidden, and the three counts sum to the connector total
    - **Property 13: Observability report aggregation**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**

  - [x] 11.5 Property 14 - off-mode accounting
    - In `web/src/path/planner_hiding.props.test.ts`, tagged `// Feature: hidden-connector-routing, Property 14: ...`
    - With hiding disabled, assert each connector's full Chebyshev length is its Exposed_Travel, `totalHiddenTravel == 0`, and every connector classified not hidden
    - **Property 14: Off-mode accounting**
    - **Validates: Requirements 9.5**

- [x] 12. Write edge, example, and guard tests
  - [x] 12.1 Guard edge cases
    - In `web/src/path/connector_router.guards.test.ts`: force `> 1000` points and `< 2` points after collapse and assert straight fallback with `rejected = true`; force a would-be-discontinuous route and assert neighbors retained; force an uncontainable route and assert containment failure is reported and the straight fallback is emitted
    - _Requirements: 2.6, 2.7, 4.4_

  - [x] 12.2 API shape matrix
    - In `web/src/path/connector_router.guards.test.ts`: matrix over `{connectorHiding: true/false/absent} × {twoOpt: true/false}` asserting flag independence, default-disabled, a valid `PlannedPath`, and no thrown error
    - _Requirements: 7.3, 7.4_

  - [x] 12.3 Edge routing example
    - In `web/src/path/connector_router.guards.test.ts`: a connector whose endpoints sit near the perimeter routes over envelope edges with zero Exposed, mirroring `appendEdgeReturnToHome` behavior
    - _Requirements: 1.4_

  - [x] 12.4 Budget tests
    - In `web/src/path/connector_router.guards.test.ts`: low `maxCandidates` and tiny `timeBudgetMs` each produce a complete, valid plan with `Exposed ≤ straight`; assert the instrumented per-connector candidate counter never exceeds 32
    - _Requirements: 6.4, 8.2, 8.3, 8.4_

- [x] 13. Write the performance test (clearly marked)
  - [x] 13.1 1000-stroke routing under 5 seconds
    - In `web/src/path/connector_router.perf.test.ts`: plan a synthetic 1000-stroke path with hiding enabled and assert completion `< 5 s`; tag the test so it can be excluded from fast watch runs
    - **PERFORMANCE TEST** - long-running; exclude from watch mode
    - _Requirements: 8.1_

- [x] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Optional Python mirror harness (explicitly descoped - not on the critical path)
  - [x] 15.1 Mirror routing in vectorize.py
    - **OPTIONAL / DESCOPED** - additive harness only; the web planner is the source of truth
    - In `tools/imagepath_service/vectorize.py`: add a pure `route_connectors_over_ink(ordered, env, start)` mirroring `connector_router.ts` classification, Chebyshev accounting, snap-and-traverse, and the same deterministic tie-break, plus `total_exposed_travel_chebyshev(...)`
    - _Requirements: 1.1, 1.5, 10.4_

  - [x] 15.2 Add the compare.py --hide-connectors flag
    - **OPTIONAL / DESCOPED**
    - In `tools/imagepath_service/compare.py`: add a `--hide-connectors` flag that renders Exposed legs in connector-gray and Hidden legs invisibly, and prints exposed travel before vs after hiding alongside the existing greedy-vs-2-opt numbers
    - _Requirements: 9.1, 9.4_

  - [x] 15.3 Cross-check parity fixture
    - **OPTIONAL / DESCOPED**
    - In `tools/imagepath_service/test_route_connectors_parity.py`: a small fixture asserting the same inputs yield the same Exposed_Travel total in both the Python mirror and the web implementation
    - _Requirements: 1.1, 10.4_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; the
  router core (tasks 1, 2.1, 3.1, 4, 5), stitcher wiring (7), and planner wiring
  (8) are the non-optional implementation path.
- Each task references specific requirement clauses and/or design property
  numbers for traceability.
- Checkpoints (tasks 6, 9, 14) ensure incremental validation.
- Property tests validate the 15 universal correctness properties; unit, edge,
  guard, and budget tests cover guards, API shape, and budgets.
- Property 11 (task 11.2) is the explicit opt-in identity guarantee: with
  `connectorHiding` off, planner output is byte-for-byte identical.
- Task 13.1 is the only long-running performance test (1000 strokes, < 5 s) and
  should be excluded from fast watch runs.
- Task 15.* is the explicitly optional Python mirror; descoping it loses only
  the offline PNG preview of hidden travel and never affects machine output.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1", "2.2"] },
    { "id": 3, "tasks": ["4.1", "3.2"] },
    { "id": 4, "tasks": ["5.1"] },
    { "id": 5, "tasks": ["7.1", "10.1", "10.4", "10.7", "10.9"] },
    { "id": 6, "tasks": ["8.1", "10.2", "10.5", "10.8", "10.10"] },
    { "id": 7, "tasks": ["10.3", "10.6", "11.1", "12.1", "13.1", "15.1"] },
    { "id": 8, "tasks": ["11.2", "12.2", "15.2"] },
    { "id": 9, "tasks": ["11.3", "12.3", "15.3"] },
    { "id": 10, "tasks": ["11.4", "12.4"] },
    { "id": 11, "tasks": ["11.5"] }
  ]
}
```
