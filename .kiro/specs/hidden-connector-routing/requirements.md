# Requirements Document

## Introduction

The Etch-a-Sketch drawing machine has a stylus that **cannot lift** — it is
always in contact with the surface. To draw a multi-stroke image the path
pipeline linearises every stroke into one continuous path, inserting straight
"connector" segments from the exit endpoint of one stroke to the entry endpoint
of the next. Because the pen never lifts, **every connector is drawn as a
visible line**.

For dense tonal images (the hatch-fill portrait) a single image can produce
hundreds of short strokes (~509 in a representative portrait), and therefore
hundreds of visible connector lines. These read as long diagonal slashes and a
"starburst" of lines converging on hub points, badly degrading the output.
Stroke-ordering optimization (greedy nearest-neighbor plus a deterministic
2-opt pass) has already minimized total connector *travel* (Chebyshev travel cut
~6939 → 5594 steps, worst single jump 281px → 178px) and has reached its ceiling;
the remaining connectors are still visible.

This feature adds **connector hiding via routing over already-drawn ink**. On an
Etch-a-Sketch, retracing a groove that has already been drawn adds **no new
visible ink**. The Connector_Router routes each inter-stroke travel move so that,
instead of cutting a straight diagonal across blank surface, it follows paths
along strokes that are **already drawn** (and along the drawing-area perimeter /
envelope edges where helpful) to reach the next stroke's entry point. Travel that
runs over existing ink is invisible; only the unavoidable residual — gaps not
covered by existing ink — remains visible.

This generalizes the existing precedent in `web/src/path/stitch.ts`, where
`appendReturnToHome()` / `appendEdgeReturnToHome()` already route the
return-to-home connector along envelope edges rather than slashing across the
art. Connector hiding extends edge / over-ink routing to **all** inter-stroke
connectors.

The user understands the honest tradeoff: on a no-pen-lift device connectors can
be **reduced and often hidden, but not always eliminated**. The feature must
therefore degrade gracefully to the current straight / edge-routed connector when
a connector cannot be hidden, and must never increase visible ink.

## Glossary

- **Etch_A_Sketch**: The physical drawing device whose stylus cannot lift; all
  pen motion, including inter-stroke travel, draws a visible groove.
- **Path_Planner**: `PathPlanner.plan()` in `web/src/path/planner.ts`; orchestrates
  scale → RDP → stitch → return-home and produces the `PlannedPath` that reaches
  the machine.
- **Stitcher**: `stitchPolylines()` in `web/src/path/stitch.ts`; orders strokes and
  weaves connector segments between them.
- **Connector_Router**: The new component that computes, for a given travel move,
  a route that follows already-drawn ink and/or envelope edges to minimize the
  visible portion of that connector.
- **Stroke**: A `PlannedSegment` with `kind: 'stroke'` — user-content motion that
  intentionally lays down visible ink.
- **Connector**: A `PlannedSegment` with `kind: 'connector'` — unavoidable
  inter-stroke or return-to-home travel. Today a 2-point straight hop; this
  feature allows a connector to be a multi-point polyline.
- **Drawn_Ink**: The set of line segments already committed to the surface by all
  strokes (and connectors) drawn earlier in the path order; retracing Drawn_Ink
  adds no new visible ink.
- **Hidden_Travel**: The portion of a connector's length that overlaps Drawn_Ink
  (or, for the first/return connector, the envelope edge) and is therefore
  invisible.
- **Exposed_Travel**: The portion of a connector's length that does NOT overlap
  Drawn_Ink and is therefore visible on the finished drawing.
- **Step_Envelope**: The inclusive integer step rectangle `[0, env.x] × [0, env.y]`
  the drawing must stay within.
- **Continuity_Invariant**: Adjacent segments share an endpoint — each segment's
  last point equals the next segment's first point (Req 14.1 of the parent spec) —
  so the whole `PlannedPath` is one contiguous path.
- **Chebyshev_Distance**: `max(|dx|, |dy|)` — the machine's real per-move step
  count and the metric used to charge connector travel.
- **Connector_Hiding_Enabled**: The opt-in flag a caller sets to request connector
  routing; when unset the pipeline behaves exactly as today.

## Requirements

### Requirement 1: Route connectors over already-drawn ink

**User Story:** As a user drawing a dense tonal image, I want inter-stroke travel to follow lines that are already drawn, so that the connectors do not appear as new visible slashes across my drawing.

#### Acceptance Criteria

1. WHERE Connector_Hiding_Enabled is set, WHEN the Connector_Router computes a connector between a stroke's exit point and the next stroke's entry point, THE Connector_Router SHALL select the route that minimizes Exposed_Travel measured in Chebyshev_Distance steps where Chebyshev_Distance equals max(|dx|, |dy|), treating a route segment as overlapping Drawn_Ink only when it is collinear with and contained within a Drawn_Ink segment to within a 1 integer-step tolerance.
2. WHERE Connector_Hiding_Enabled is set, WHEN a candidate route following Drawn_Ink has Exposed_Travel in Chebyshev_Distance steps strictly less than the straight 2-point connector's Chebyshev_Distance length, THE Connector_Router SHALL emit that route.
3. WHERE Connector_Hiding_Enabled is set, WHEN routing the connector at path index i, THE Connector_Router SHALL treat only segments at path indices strictly less than i as Drawn_Ink, and SHALL treat Drawn_Ink as the empty set when i equals 0, so the route never relies on ink not yet drawn.
4. WHERE Connector_Hiding_Enabled is set, WHEN routing to or from the Step_Envelope perimeter, THE Connector_Router SHALL treat the inclusive integer perimeter edges of the rectangle [0, env.x] x [0, env.y] as routable Hidden_Travel that contributes zero Exposed_Travel, consistent with appendEdgeReturnToHome.
5. WHERE Connector_Hiding_Enabled is set, IF two or more candidate routes share the minimum Exposed_Travel in Chebyshev_Distance steps, THEN THE Connector_Router SHALL select the route with the smallest total Chebyshev_Distance length, and SHALL break any remaining tie by selecting the route whose ordered sequence of point coordinates is the smallest, so the selection is deterministic.
6. WHERE Connector_Hiding_Enabled is set, IF no candidate route following Drawn_Ink has Exposed_Travel in Chebyshev_Distance steps strictly less than the straight 2-point connector's Chebyshev_Distance length, THEN THE Connector_Router SHALL emit the straight 2-point connector between the exit point and the next entry point.
7. IF Connector_Hiding_Enabled is not set, THEN THE Connector_Router SHALL emit the straight 2-point connector between the exit point and the next entry point.

### Requirement 2: Continuity invariant preserved

**User Story:** As a maintainer of the path pipeline, I want routed connectors to remain part of one contiguous path, so that downstream G-code emit and Drawing_Command encoding continue to work unchanged.

#### Acceptance Criteria

1. WHEN the Connector_Router replaces a straight connector with a multi-point route, THE Connector_Router SHALL set the route's first point exactly equal (integer x and integer y) to the preceding segment's last point and the route's last point exactly equal (integer x and integer y) to the following segment's first point.
2. THE Connector_Router SHALL emit each routed connector as a single PlannedSegment with kind 'connector' whose pointsSteps contains at least 2 and at most 1000 points.
3. WHEN a routed connector is emitted, THE Connector_Router SHALL ensure every adjacent point pair differs in at least one integer step coordinate (x or y), preserving the no-zero-length sub-segment invariant.
4. WHEN a computed route contains one or more consecutive identical points (equal integer x and integer y), THE Connector_Router SHALL collapse each such run to a single occurrence while preserving the route's first and last points unchanged.
5. WHEN the Path_Planner assembles the PlannedPath with routed connectors, THE Path_Planner SHALL preserve the Continuity_Invariant (exact integer equality of x and y between one segment's last point and the next segment's first point) across every adjacent segment pair.
6. IF a routed connector would violate the Continuity_Invariant, THEN THE Path_Planner SHALL discard the route and emit the straight 2-point connector for those endpoints, retaining the preceding and following segments unchanged.
7. IF a computed route would contain fewer than 2 points after collapsing consecutive identical points, OR would contain more than 1000 points, THEN THE Connector_Router SHALL discard the route and emit the straight 2-point connector for those endpoints, and SHALL indicate the route was rejected to the Path_Planner.

### Requirement 3: Determinism

**User Story:** As a maintainer relying on property tests, I want connector routing to be deterministic, so that the same inputs always produce the same path.

#### Acceptance Criteria

1. THE Connector_Router SHALL compute each route as a pure function of its inputs (the connector endpoints, the Drawn_Ink set, and the Step_Envelope), using no randomness, no wall-clock or system time, and no external mutable state, so that the emitted route depends only on the values passed into the invocation.
2. WHEN the Connector_Router is invoked two or more times with inputs that are equal in value (identical endpoints, an identical Drawn_Ink segment set, and an identical Step_Envelope), THE Connector_Router SHALL return routes whose point sequences are identical in length, in order, and in integer coordinate values.
3. WHEN two or more candidate routes have equal Exposed_Travel and equal total Chebyshev_Distance, THE Connector_Router SHALL select the single route that is least under one fixed, documented total ordering of routes (lexicographic comparison of each route's ordered point coordinates, comparing x before y), such that no tie between candidate routes is left unresolved.
4. WHEN the Connector_Router is invoked with Drawn_Ink segments supplied in different iteration orders that are otherwise equal in value, THE Connector_Router SHALL return routes whose point sequences are identical in length, in order, and in integer coordinate values.

### Requirement 4: Envelope containment

**User Story:** As a user, I want routed connectors to stay inside the drawable area, so that the machine never drives the stylus against its mechanical limits.

#### Acceptance Criteria

1. WHEN the Connector_Router emits a routed connector, THE Connector_Router SHALL ensure every route point (x, y) satisfies 0 ≤ x ≤ env.x and 0 ≤ y ≤ env.y, where env.x and env.y are non-negative integers defining the inclusive Step_Envelope.
2. THE Connector_Router SHALL emit every route point as integer motor-step coordinates.
3. WHEN the Connector_Router emits a route segment connecting two adjacent route points, THE Connector_Router SHALL ensure every integer motor-step position traversed along that segment also satisfies 0 ≤ x ≤ env.x and 0 ≤ y ≤ env.y.
4. IF the Connector_Router cannot produce a route in which every point lies within the inclusive Step_Envelope, THEN THE Connector_Router SHALL NOT emit the connector and SHALL report an error indicating that the route could not be contained within the Step_Envelope.

### Requirement 5: No new visible ink

**User Story:** As a user, I want connector hiding to only ever reduce the visible connector lines, so that enabling the feature can never make my drawing worse.

#### Acceptance Criteria

1. WHEN the Connector_Router emits a routed connector in place of the straight 2-point connector for the same endpoints, THE Connector_Router SHALL ensure the routed connector's Exposed_Travel, measured in Chebyshev_Distance steps, is less than or equal to the straight connector's visible length, where the straight connector's visible length equals its full Chebyshev_Distance length.
2. IF no route the Connector_Router evaluates for a connector achieves an Exposed_Travel strictly less than the straight connector's full Chebyshev_Distance length, THEN THE Connector_Router SHALL emit the straight 2-point connector for those endpoints.
3. WHEN the minimum Exposed_Travel achievable among the routes the Connector_Router evaluates is greater than zero steps, THE Connector_Router SHALL emit the evaluated route with the lowest Exposed_Travel, breaking ties using the fixed, documented tie-break order defined in Requirement 3.3.
4. THE Connector_Router SHALL never emit a connector for a pair of endpoints whose Exposed_Travel, measured in Chebyshev_Distance steps, exceeds the straight 2-point connector's full Chebyshev_Distance length for those same endpoints.

### Requirement 6: Graceful fallback

**User Story:** As a user drawing isolated regions with no nearby ink, I want the connector to still be produced correctly, so that the path is always complete even when hiding is impossible.

#### Acceptance Criteria

1. IF the Connector_Router finds no candidate route whose Exposed_Travel (measured in Chebyshev steps) is strictly less than the Exposed_Travel of the straight 2-point connector for the same endpoints, THEN THE Connector_Router SHALL emit the straight 2-point connector consisting of exactly the two given endpoints.
2. WHEN a candidate route has an Exposed_Travel equal to that of the straight 2-point connector, THE Connector_Router SHALL emit the straight 2-point connector rather than the candidate route.
3. IF the Drawn_Ink set is empty at the time a connector is routed, THEN THE Connector_Router SHALL emit the straight 2-point connector for those endpoints without performing a hiding search.
4. IF computing a route for a connector reaches the configured per-connector work bound (as defined in Requirement 8) before completing, THEN THE Connector_Router SHALL emit the best improving route found so far when at least one route with strictly lower Exposed_Travel than the straight connector exists, and SHALL otherwise emit the straight 2-point connector.
5. THE Connector_Router SHALL ensure every emitted connector, whether a routed path or the straight 2-point fallback, begins at the first given endpoint and ends at the second given endpoint.

### Requirement 7: Opt-in, backward-compatible integration

**User Story:** As a maintainer with existing callers and property tests, I want connector hiding to be off by default, so that current behavior and tests are unchanged unless a caller explicitly enables it.

#### Acceptance Criteria

1. WHERE Connector_Hiding_Enabled is not set, THE Path_Planner SHALL produce a PlannedPath that is byte-for-byte identical to the PlannedPath it produces with connector hiding absent for the same inputs.
2. WHERE Connector_Hiding_Enabled is not set, THE Stitcher SHALL weave straight 2-point connectors byte-for-byte identical to those it weaves with connector hiding absent for the same inputs.
3. THE Path_Planner SHALL expose Connector_Hiding_Enabled as an optional boolean flag in its plan options whose absent value is treated as disabled, and SHALL expose the flag independent of the twoOpt stroke-order refinement value (true or false) and of all other plan option values.
4. IF Connector_Hiding_Enabled is omitted from the plan options, THEN THE Path_Planner SHALL continue planning with connector hiding disabled, SHALL return a valid PlannedPath, and SHALL NOT raise an error or reject the plan request.
5. WHERE Connector_Hiding_Enabled is set together with twoOpt set to true, THE Path_Planner SHALL apply connector routing only after the final stroke order and orientation are decided.
6. WHERE Connector_Hiding_Enabled is set together with twoOpt set to false, THE Path_Planner SHALL apply connector routing only after the final stroke order and orientation are decided.

### Requirement 8: Performance bound

**User Story:** As a user, I want connector hiding to fit within the existing planning budget, so that planning a dense image still completes in a few seconds.

#### Acceptance Criteria

1. WHEN routing connectors for a path of up to 1000 strokes, THE Connector_Router SHALL complete within 5 seconds.
2. THE Connector_Router SHALL limit the work performed per connector to a documented maximum number of candidate routes (default 32 candidates per connector), such that total routing cost grows at most linearly with the stroke count.
3. IF the per-connector candidate-route limit is reached before a hidden route is found, THEN THE Connector_Router SHALL stop evaluating that connector, leave that connector unhidden, and continue routing the remaining connectors.
4. IF total routing time reaches 5 seconds before all connectors are processed, THEN THE Connector_Router SHALL stop routing, emit each unprocessed connector unhidden, and return a complete plan.

### Requirement 9: Observability of hidden vs exposed travel

**User Story:** As a user and as a maintainer, I want to see how much connector travel was hidden versus exposed, so that I can judge the benefit and detect regressions.

#### Acceptance Criteria

1. WHEN connector routing has run, THE Path_Planner SHALL report the planned path's total Hidden_Travel as the sum of the per-connector Hidden_Travel over all connectors and the total Exposed_Travel as the sum of the per-connector Exposed_Travel over all connectors, each as a non-negative integer.
2. WHEN connector routing has run, THE Path_Planner SHALL classify each connector as fully hidden when its Exposed_Travel equals 0, as not hidden when its Hidden_Travel equals 0, and as partially hidden when both its Hidden_Travel and its Exposed_Travel are greater than 0.
3. WHEN connector routing has run, THE Path_Planner SHALL report the count of fully hidden, partially hidden, and not hidden connectors, where the three counts are non-negative integers that sum to the total number of connectors in the planned path.
4. THE reported Hidden_Travel and Exposed_Travel SHALL be expressed in the machine's Chebyshev_Distance step metric, consistent with the existing connector-travel accounting.
5. WHERE Connector_Hiding_Enabled is not set, WHEN the Path_Planner reports connector-travel observability, THE Path_Planner SHALL report each connector's full Chebyshev length as Exposed_Travel, a total Hidden_Travel of 0, and every connector classified as not hidden.

### Requirement 10: Route geometry follows existing ink and edges

**User Story:** As a user, I want routed connectors to physically trace the lines already on the surface, so that the retraced travel genuinely lands in existing grooves and stays invisible.

#### Acceptance Criteria

1. WHEN a route segment is classified as Hidden_Travel, THE Connector_Router SHALL place that segment collinear with and fully contained within an existing piece of Drawn_Ink or a Step_Envelope perimeter edge, such that every point of the segment lies within a perpendicular distance of 1 integer step of that ink piece or edge.
2. IF a route segment classified as Hidden_Travel cannot be placed collinear with and within 1 integer step of any existing Drawn_Ink piece or Step_Envelope perimeter edge, THEN THE Connector_Router SHALL reclassify that segment as Exposed_Travel and emit an indication that the segment could not be hidden, while retaining the routed connector.
3. WHEN a route transitions between two pieces of Drawn_Ink separated by a gap greater than 1 integer step, THE Connector_Router SHALL connect them with a single segment whose full Chebyshev length is counted as Exposed_Travel.
4. WHEN the Connector_Router emits Hidden_Travel and Exposed_Travel for one connector, THE Connector_Router SHALL ensure the sum of the Hidden_Travel length and the Exposed_Travel length equals the total Chebyshev length of the routed connector exactly, with each routed step counted in exactly one of the two categories.
