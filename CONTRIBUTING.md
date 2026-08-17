# Contributing

## Running the tests

```bash
npm test          # the gate: ~20s, self-terminating
npm run test:slow # everything, including the quarantine: ~8m, deliberately unbounded
```

**Budget under a minute for `npm test`.** Measured on an M-series Mac, 2026-08-16: `20.3s` wall
clock, 421 tests, 405 pass, 16 skipped, exit 0. Nothing here is instant, because almost every
integration test spawns `swetest` for real ephemeris data rather than using a recorded fixture.

Several changes have cut that figure and they compound, so any older absolute number in this file's
history is stale in both directions. **SUP-389** stopped routing every spawn through `/bin/sh`:
back to back on one machine the suite went `7m39s` → `2m56s`. **SUP-387**, **SUP-390** and
**SUP-391** then took most of the spawns out of the event search entirely. Read these as
machine-specific — a `6m15s`/398-test figure in this file's history was the same pre-change suite on
a quieter machine.

`npm test` runs through `scripts/run-tests.mjs` rather than calling `node --test` directly, because
`node --test` alone cannot fail a hung run in this repo. Two independent bounds are needed
(SUP-385):

| Bound | Env var | Default | Catches |
|---|---|---|---|
| per-test | `TEST_TIMEOUT_MS` | `300000` | a test awaiting something that never settles |
| whole run | `TEST_WALL_CLOCK_MS` | `1200000` | a test that blocks without ever yielding |

The second is not redundant. `--test-timeout` is a timer *inside* the test process, so it only fires
when the event loop turns — and every `swetest` call in this repo goes through `execFileSync`
(`lib/swetest-exec.js`), so a runaway search blocks the loop outright and that timer never runs.
Verified: a test that busy-loops for 20s passes clean under `--test-timeout=2000`. Only killing the
process from outside catches that shape. Set either to `0` to disable it.

Both defaults were pitched at roughly 3× the figures measured when SUP-385 set them, and SUP-389
and SUP-387 then cut the suite by about 10× without moving them. That headroom is deliberate rather than
overlooked: these bounds exist to catch a hang, and a hang is unbounded — pitching them close to a
fast suite's real runtime buys nothing and starts failing runs on a contended or slower machine.

(`node --test` does exit `1` when a test is *cancelled* rather than failed, so a per-test timeout
surfaces as a red run with no extra handling. Beware measuring this through a pipe — `node --test … |
tail` reports `tail`'s exit status, not node's.)

### The pair-aspect quarantine

`test/find-events-pair-aspects.integration.test.js` is **skipped by default** and runs only under
`RUN_SLOW_TESTS=1` (`npm run test:slow`). It is not broken and it does not hang — it is
arithmetically enormous.

**Budget about 8 minutes.** That is an observed end-to-end figure rather than an estimate: before
SUP-387 and SUP-389 this file had never once been seen to finish, with attempts abandoned at 42
minutes and at 1h56m against a ≈1.5–2 h guess summed from parts. Measured 2026-08-16 on an M-series
Mac: `7m41s` end to end, 421 tests, 421 pass, 0 skipped, exit 0. (It was `10m56s`/`10m44s` on the
same machine before SUP-390 and SUP-391.) `test:slow` still sets **no** wall-clock bound
(`TEST_WALL_CLOCK_MS=0`); `npm test`, the actual gate, stays bounded either way.

Per-test wall clocks from that run, as reported by `node --test` — the longest few, with the
pre-SUP-390/391 figure alongside:

| Test | Wall clock | was |
|---|---|---|
| §9.5 (Sun, Midheaven) excluded at either `angle_method` — two 90yr searches | 82.9 s | 113.6 s |
| §9.3 Sun–Mars / Venus–Mars, majors **and** `include_minor` over 90yr | 72.9 s | 97.4 s |
| §9.5 North Node never pairs — 90yr | 53.1 s | 70.9 s |
| §9.1/§6.1 eight_phase identity with `include_minor` — 90yr | 48.0 s | 76.7 s |
| §9.5 retrograde is per body, not per relative rate — 90yr | 42.6 s | 56.2 s |
| Ascendant × Midheaven eligible but not default — 90yr | 29.9 s | 46.8 s |
| §9.1 Sun–Moon majors — 90yr | 22.9 s | 33.3 s |

For contrast, the same configurations measured in-process before either change (2026-08-15,
pre-SUP-389; the `find_events` call alone, not the test around it): §9.1 Sun–Moon majors 5.2 min
(25 episodes), the same with `include_minor` 12.7 min (62 episodes), §9.2 default 10 pairs 6.7 min
(109 episodes), §9.3 three slow pairs 5.1 min (1 episode), §9.6 transit 21 pairs 3.0 min (52
episodes). SUP-389 alone took the last two of those to 0.4 min and 1.4 min in a back-to-back A/B
(`56.5s → 23.7s`, `225.4s → 85.9s`) with identical episode counts; SUP-387 is the rest of the gap.

### What SUP-387 actually changed, and what drives the cost

Measured with a counting shim ahead of the real `swetest` on `PATH`, `DAY_CHART`, this branch
against `origin/main` at `a4d6b9d` — i.e. **after** SUP-389, so this isolates SUP-387 alone — on the
same machine in the same session. Spawn counts are exact; wall clocks are from separate unshimmed
runs (the shim inflates wall time ~1.7×, not spawns). Every row returned identical
`contacts`/`pair_contacts`/`events` counts on both sides:

| `find_events` call | Spawns | Wall |
|---|---|---|
| 1yr transit, aspects, pairs **off** | 11,510 → **1,490** (−87%) | 28.6 s → **5.8 s** (4.9×) |
| 1yr transit + Mars–Jupiter pair | 13,030 → **1,539** (−88%) | 32.8 s → **5.5 s** (6.0×) |
| 3yr progressed + Sun–Moon pair | 3,863 → **446** (−88%) | 9.9 s → **1.3 s** (7.6×) |
| 6mo transit, all five event types | 9,123 → **952** (−90%) | 23.4 s → **2.7 s** (8.7×) |
| 2yr progressed, angles + moving cusps | 6,560 → **1,330** (−80%) | 17.1 s → **3.9 s** (4.4×) |

The first row is the headline: the most ordinary call this server serves, down from 11,510
processes to 1,490. Against the tree before *either* change it was 83.4 s.

- **The cost is not the pair count, and it is not really pairs at all.** An earlier version of this
  section said "cost tracks the window length, not the pair count", citing ten pairs over 90 years
  costing barely more than one (6.7 vs 5.2 min). The observation was right and the explanation was
  wrong: extra pairs looked free because the *pair branch was never the expensive part*. At the
  transit rate over a year, switching pairs off entirely saves 12%; the other 88% is the ordinary
  moving-to-natal `contacts[]` search, which none of the tests in that file assert on. What you pay
  for is the sample count of the **whole aspect search** — window length × moving bodies × natal
  targets × aspect angles.
- **`include_minor` costs roughly 2.5× a majors-only search** (2.47× at 90yr, 2.29× at 10yr): four
  more aspect angles to detect and refine.
- **`bodies` is the untouched lever.** These tests all run the full default moving-body set and
  then assert only on `pair_contacts`. Narrowing to `bodies: ['Moon']` cut a 3-year progressed pair
  search 4,646 → 2,724 spawns pre-SUP-387 with pair results unchanged. Left alone deliberately:
  §9.5 has a test asserting `pair_bodies` is independent of `bodies`, and losing that coverage to
  buy minutes off a file that is quarantined anyway is a bad trade.

The two changes attack this from opposite ends and multiply: **SUP-389 made each spawn ~2.5×
cheaper without removing a single one; SUP-387 removed ~87% of them without making any one
cheaper.** Neither figure is a substitute for the other, and neither is a substitute for re-running
the thing you care about.

### What SUP-390 changed, and what is left

SUP-387 left exactly one bisection ladder standing — `refineStationJd`, which narrows a station
bracket to `JD_TOLERANCE` (0.05 s) one sample at a time: 21 halvings from the transit rate's
day-wide bracket, 30 from the progressed rate's tropical-year one. SUP-390 batches it. `swetest`
emits an arithmetic JD grid from one process (`-jX -sSTEP -nN`), so the 2^k − 1 points a k-halving
bisection *could* visit are fetched in a single spawn and the k steps replayed against them in
memory. At `k = 6` that is 63 rows a spawn.

The seam grew one optional method for it — `samplesFrom(startJd, stepDays, count)`, alongside
`seriesFor`/`positionAt`. A provider without one (the progressed Ascendant, the moving house cusps —
each sample there is a `-house` chart computation with no batched form) keeps the scalar loop
untouched, which is why the progressed-rate rows below barely move.

`DAY_CHART`, this branch against `origin/main` at `d4b7678` — i.e. **after** both SUP-387 and
SUP-389, so this isolates SUP-390 alone. Every scenario returned **byte-identical** JSON on both
sides (all seven diffed whole, not sampled). Spawn counts are exact; wall clocks are best-of-3 from
a separate uninstrumented run alternating the two trees scenario by scenario:

| `find_events` call | Spawns | Wall |
|---|---|---|
| 3yr transit, `station` only, 8 bodies | 1,154 → **270** (4.3×) | 2,603 → **878** ms (3.0×) |
| 3yr transit, sign + house ingress | 926 → **314** (2.9×) | 2,403 → **1,076** ms (2.2×) |
| 1yr transit, all five event types | 1,652 → **1,496** (1.10×) | 3,847 → **3,481** ms (1.11×) |
| 2yr progressed, house ingress, moving cusps | 810 → **785** (1.03×) | not measured |
| 3yr progressed, all five event types | 1,739 → **1,719** (1.01×) | indistinguishable |
| 1yr transit, `lunation` only, eight_phase | 402 → **402** (1.00×) | not measured |

Wall gains trail spawn gains because a batched spawn is not a free spawn — 63 rows add ~0.9 ms to a
~2.1 ms process. The progressed row is genuinely flat: six interleaved reps ran 3,853–4,344 ms on
`main` and 3,712–4,664 ms on the branch, which is noise around a 1% spawn change, not a regression.
The lunation row is 1.00× by construction rather than by accident — the Sun–Moon relative rate never
reaches zero, so that search refines no stations at all.

**Why the headline is 1.1× and not the 5× the ticket predicted.** SUP-390 was filed against the
pre-SUP-387 tree, where crossing refinement was a 24-step bisection. It is not any more. Attributing
every spawn of a 1-year all-types transit call to its call site, post-SUP-387:

| Call site | Spawns | Share |
|---|---|---|
| `refineSegmentCrossing` (Newton) | 956 | 57.9% |
| `findContacts` orb-interval midpoint test | 398 | 24.1% |
| `refineStationJd` | 252 | 15.3% |
| coarse `seriesFor` + station position reads | 28 | 1.7% |

Those 956 crossing samples refine 444 roots — **2.15 samples per root**, against a floor of 1. There
is nothing there to batch, which is what SUP-387 bought. Station refinement was all that was left,
and 15.3% of a call is what batching it can be worth. The same attribution at the progressed rate
puts `refineStationJd` at 6.3% and something else entirely at the top: 41.6% of the spawns are the
two `calculateEphemeris` calls behind every progressed frame (`progressedFrameAt`), one of which
fetches all 17 bodies purely to read the obliquity off the `Ecl. Obl.` row. That is the biggest
remaining lever at that rate and it is not this ticket — it became SUP-393, below.

The cost model the `k = 6` batch width comes from, measured on an M-series Mac 2026-08-16 with the
`execFileSync` path SUP-389 left: a spawn costs **~2.1 ms fixed** plus **~15 µs per additional row**,
flat from 1 row out to 1,024. So 63 rows cost about 1.5 spawns' wall clock and do 6 spawns' work.
`k = 5`/`6`/`7` all land within ~5% of each other on a day-wide bracket (12.8/12.2/12.0 ms against
bisection's 44 ms); `k = 11` — two spawns of 2,047 rows — is back up at 65 ms.

**The one real hazard, recorded because it is not obvious.** Near a station the printed speed does
not step cleanly through zero, it *dithers*: sampled at 0.25 s resolution through Pluto's
2027-05-08 station it reads `0.0000000 / 0.0000001 / 0.0000000 / 0.0000001` over about three
seconds, as the true speed grazes the 7th decimal. So `sign(speed) === sign(speedLo)` is **not
monotone** across the bracket, and taking the leftmost sign change in a fetched grid — the obvious
way to use a batch, and the first thing written here — is not the same rule as bisection. It moved
8 of 52 transit-rate stations, three of them by a whole reported second. Replaying bisection's own
index sequence over the grid instead is bit-identical on all 52, and agrees to 8 × 10⁻⁵ s (about two
ulps of a JD double) at the progressed rate, where the tropical-year coarse step makes the grid
arithmetic non-dyadic. `test/station-refinement.test.js` pins this with synthetic dithering curves
and a foil implementation of the rejected rule, so the guard cannot quietly go vacuous.

**The quarantine stays, and here is the arithmetic rather than a preference.** SUP-387 set out to
make this file cheap enough to un-quarantine, and SUP-390 and SUP-391 kept chipping: `test:slow`
went from never-finishing to 11 minutes to **7m41s**. That is a budget a CI job could carry — but
deleting the skip does not add 8 minutes to a CI job, it adds them to `npm test`, turning the gate
everyone runs before every commit from 20 seconds into roughly 8 minutes, a 23× regression on the
one number every contributor pays on every commit. It would also leave the default
`TEST_WALL_CLOCK_MS` (20 min) with 2.6× headroom instead of the current 59×, so an ordinary slow
morning on a contended machine would start failing honest runs. Re-open this when `test:slow` is
seconds, not minutes — which, per the floor established below, needs the spawn gone, not another
round of sample-count work.

The remaining cost is process spawn, and the only thing left that removes it is removing the spawn
itself — which SUP-391 measured and found is not reachable from `swetest` at all, leaving in-process
libswe (**SUP-394**) as the only lever, not a shorter window here. Where 8 minutes *does* pay off is
CI: `test:slow` is now a plausible separate job, which it was not at 26 minutes and certainly not at
two hours. That belongs to SUP-386, which tracks this repo having any test job at all.

So **a green `npm test` still says nothing about `include_pair_aspects`.** If you touch the pair
path — or the shared provider/root-finder seam under it in `lib/event-search.js` — run `npm run
test:slow`. Whichever of the two you ran, say which one when you report a result.

### What SUP-391 changed, and where the floor is

SUP-391 was filed to remove the process spawn itself — "a persistent `swetest` process or libswe
bindings", measuring the persistent process first because it is reversible and re-verifies nothing.
That half is not available, and the measurement saying so is worth keeping because it also bounds
every future attempt at this.

**A `swetest` spawn is ~94% process and ~6% Swiss Ephemeris.** M-series Mac, 2026-08-16, through
the `execFileSync` path SUP-389 left, 200–400 reps each:

| Spawned | Cost |
|---|---|
| `/usr/bin/true` | 1.15 ms |
| `swetest` with an unrecognised flag — parses argv, prints usage, computes nothing | 1.61 ms |
| `swetest -jX -ut -p0 -fJPls -head -n1` — one body, one instant | 1.79 ms |
| the same for ten bodies (`-p0123456789`) | 1.90 ms |
| the same for 63 rows (`-n63 -s0.01`) | 2.68 ms |
| the same for 366 rows | 8.08 ms |
| the same for 5,000 rows | 68.7 ms |

The ephemeris work behind one position is the gap between rows two and three: **0.11 ms**.
Everything under it is fork/exec/teardown, and two thirds of *that* is what any binary at all costs.
`swetest` 2.10.03 has no persistent or REPL mode — `swetest -h` lists none, and it parses argv,
computes, prints and exits — so there is nothing to keep alive; and even if there were, a `swetest`
that became instantaneous would take a 1.79 ms sample to 1.61 ms. **The ceiling on a persistent
`swetest` is about 10%, and it is unreachable.** Nothing in the Node spawn API moves it either:
`execFileSync` against `spawnSync`, the full inherited environment (65 vars, 6.9 KB) against a
minimal `{SE_EPHE_PATH}`, and piping stdout against buffering it, all landed between 1.72 and
1.88 ms — noise.

**What was left to remove.** Every spawn of the canonical call — 1 year, transit rate, `aspect`
only, `include_pair_aspects: false`, `DAY_CHART` — attributed to its call site on the tree as
SUP-390 left it:

| Call site | Spawns | Share |
|---|---|---|
| `refineSegmentCrossing` (Newton) | 805 | 62.6% |
| `findContacts` orb-interval midpoint probe | 412 | 32.0% |
| `refineStationJd` (batched) | 48 | 3.7% |
| coarse `seriesFor`, station position reads, the natal chart | 21 | 1.6% |

Those 805 samples refine **369 roots — 2.18 per root**, against a floor of 2 (one to land near the
root, one to prove the correction is inside `JD_TOLERANCE`). Nothing there. So SUP-391 took the only
other line on the list: the midpoint probe is gone, replaced by two independent derivations from
numbers `findContacts` already holds — parity across the crossing, and the sign of the crossing's own
speed against which orb boundary it belongs to. Both must agree; where they don't, the probe still
runs and still decides, so the self-verification the probe existed for is kept rather than traded
away. Across the four shapes profiled they agreed on **every** interval (251/52/154/37, zero probes),
which is why `test/orb-interval-resolution.test.js` forces the fallback in with synthetic providers
that report zero speed, or a flipped speed sign, exactly on the boundary — otherwise the branch would
ship untested.

`DAY_CHART`, this branch against `origin/main` at `6705180`. Every scenario returned
**byte-identical** JSON (all five diffed whole, not sampled). Spawn counts are exact, from a counting
shim ahead of the real `swetest` on `PATH`; wall clocks are best-of-3 from a separate uninstrumented
run, and include Node startup:

| `find_events` call | Spawns | Wall |
|---|---|---|
| 1yr transit, aspects, pairs **off** | 1,286 → **888** (−31%) | 2,643 → **1,883** ms (1.40×) |
| 1yr transit + Mars–Jupiter pair | 1,343 → **930** (−31%) | 2,832 → **1,958** ms (1.45×) |
| 6mo transit, all five event types | 900 → **642** (−29%) | 2,104 → **1,496** ms (1.41×) |
| 3yr progressed + Sun–Moon pair | 860 → **697** (−19%) | 1,879 → **1,492** ms (1.26×) |
| 2yr progressed, angles + moving cusps | 1,305 → **1,195** (−8%) | 2,985 → **2,692** ms (1.11×) |

The progressed-angles row moves least for the same reason it did under SUP-390: its cost is
elsewhere (the two `calculateEphemeris` calls behind every progressed frame), not in orb intervals.

**After this, the canonical call is 888 spawns and 90.7% of them are one thing:**

| Call site | Spawns | Share |
|---|---|---|
| `refineSegmentCrossing` (Newton) | 805 | 90.7% |
| `refineStationJd` (batched) | 48 | 5.4% |
| `findContacts` — the window's two endpoints, once per body | 14 | 1.6% |
| coarse `seriesFor`, station position reads, the natal chart | 21 | 2.4% |

At 2.18 samples per root against a floor of 2, **there is no further sample-count work worth doing.**
A perfect refiner would save 8%.

**Why not spawn in parallel.** It is the one option that needs no new dependency and cannot change a
single number — same binary, same argv, just concurrent. Throughput measured on the same machine,
400 samples, one body one instant each:

| Concurrency | 1 (sync) | 2 | 4 | 6 | 8 | 12 | 16 |
|---|---|---|---|---|---|---|---|
| ms/sample | 2.02 | 1.05 | 0.55 | 0.46 | 0.43 | 0.41 | 0.50 |

So ~4.9× is available. What is *not* available is anything to run in parallel. The search offers
almost no concurrent work at its natural seams: on the canonical call `enumerateCrossings` is
entered 2,856 times for 369 roots total, and **2,514 of those calls (88%) find zero roots**; the
largest finds 3. `findContacts` is entered 952 times for 1,203 intervals, and **812 (85%) have
exactly one**. Newton is serial within a root by definition. Extracting an 8-wide batch therefore
means inverting the control flow of the whole per-(body × natal target × aspect) loop into
collect-requests / resolve-batch / resume — not a new seam method like `samplesFrom`, a rewrite of
the engine's shape — for a constant factor that in-process bindings would then make redundant.
Recorded as measured-and-declined, not overlooked.

**What would actually remove the floor** is the other half of SUP-391's title, now **SUP-394**: in-process libswe
(native or WASM), which deletes the 1.7 ms outright. SUP-394 has since measured it, and every
estimate in this paragraph as originally written was wrong in the conservative direction — see
`docs/decisions/SUP-394-in-process-libswe.md` for the full spike. Corrections:

- **It is ~160–410× on the sample cost, not 16×.** The 16× was 1.79 ms ÷ the 0.11 ms above, and
  that 0.11 ms is a *differenced* figure: it charges every sample for opening and mapping the
  `.se1` file, `swe_set_ephe_path`, and output formatting, all of which a resident library pays
  once per process rather than once per position. Measured directly, one body at one instant costs
  **0.0054 ms** in-process against 2.24 ms spawned; the worst case measured — a 16-day JD step that
  defeats segment locality entirely — is 0.0137 ms, still 163×. End to end the canonical call is
  ~20×, bounded by Node startup and JS rather than by the ephemeris.
- **Re-verification is not the expensive half.** 119 body longitudes and 98 house cusps/angles
  across all seven fixtures came back identical to `swetest` below its own 1e-7° print quantum —
  same library version, same data files. Nothing to re-baseline. Eclipses are the one exception:
  `-solecl`/`-lunecl` type strings are `swetest`'s display layer, so that path is a port.
- **It does not add a build step; it removes two.** `swetest` is not vendored — README tells users
  to `git clone && make` it themselves, so a C toolchain is already a prerequisite of `npx` today.
  `sweph` ships N-API prebuilds for darwin-arm64/linux-x64/linux-arm64/win32-x64 and installed in
  3 seconds compiling nothing, and the Dockerfile's own clone-and-`make` layer would go away.

**The actual blocker is the licence, which is why SUP-394 is a decision.** Swiss Ephemeris is
AGPL-3.0 unless you hold a paid Astrodienst professional licence (which unlocks LGPL-3.0); this is
true of every binding, so native-vs-WASM is not the question. Today this repo distributes no Swiss
Ephemeris program code at all — it shells out to a binary the user built. Linking it in makes the
published package a combined work, and AGPL §13 is aimed at exactly this shape of software. That
call belongs to the repo owner, not to whoever picks up the ticket.

### What SUP-393 changed — the progressed frame

Everything above is about the transit rate. At the progressed rate the top line was never sample
count: it was the **frame**. A progressed Ascendant or moving house cusp is not a `-p` body but a
`-house` chart computation at a fictitious longitude (`lib/progressions.js`'s
`computeFictitiousLongitude`), and `index.js`'s `progressedFrameAt` built each one out of two
`calculateEphemeris` calls. That method always runs a planets call *and* a houses call, so a frame
was **four** spawns — and of those four, the first call's planets output was there to yield a single
number (`obliquity`, off the `Ecl. Obl.` row, after computing all 17 bodies) and the second call's
planets output was read by nobody at all.

`-p` and `-house` compose in one invocation, so both halves of the handshake are now one narrow read
each (`lib/house-frame.js`): `-po -house<lon>,<lat>,<sys> -fPZSBDl` prints the `Ecl. Obl.` row, the
twelve cusps, the Ascendant and the ARMC together. Two spawns per frame, neither computing a planet.
Per-spawn cost, same machine and method as the tables above, 300 reps each:

| Invocation | Cost |
|---|---|
| `-p0123456789tADFGHIo -fPZSBDl-` — the planets call this replaces | 2.52 ms |
| `-house… -fPZSBD` — the houses call this replaces | 2.10 ms |
| `-po -house… -fPZSBDl` — `lib/house-frame.js` | 1.81 ms |
| `-po` alone, no houses | 1.75 ms |

**Omitting `-p` does not mean "no bodies".** That is the non-obvious part and the reason the houses
call cost 2.10 ms rather than 1.81: with no `-p` at all, `swetest` computes and prints its 13 default
planets alongside the cusps. The saving comes from asking for `-po` *explicitly*, not from asking for
less. A frame therefore goes from 2×2.52 + 2×2.10 = **9.24 ms** to 2×1.81 = **3.63 ms**.

`DAY_CHART` (plus `SOUTHERN_CHART` for the naibod/Whole Sign row), this branch against `origin/main`
at `bc5ed95`. Every scenario returned **byte-identical** JSON — eleven of them, diffed whole, and
deliberately including the three transit rows, both `calculate_secondary_progressions` shapes and a
plain natal chart, because "the progressed path got faster" is only half the claim; the other half is
that nothing else moved at all. Spawn counts are exact (an `execFileSync` counting shim); wall clocks
are best-of-3 from a separate uninstrumented run alternating the two trees scenario by scenario:

| Call | Spawns | Wall |
|---|---|---|
| 3yr progressed, all five event types | 1,442 → **1,152** (1.25×) | 3,004 → **2,094** ms (1.43×) |
| 2yr progressed, `house_ingress`, moving cusps | 444 → **328** (1.35×) | 910 → **603** ms (1.51×) |
| 3yr progressed (southern, naibod, Whole Sign, moving cusps) | 1,003 → **837** (1.20×) | 1,983 → **1,509** ms (1.31×) |
| 3yr progressed, aspects + Asc/MC pairs | 771 → **677** (1.14×) | 1,474 → **1,257** ms (1.17×) |
| 3yr transit, `station` only | 189 → **189** (1.00×) | 589 → 591 ms |
| 1yr transit, all five event types | 1,098 → **1,098** (1.00×) | 2,319 → 2,360 ms |
| 3yr transit, sign + house ingress | 314 → **314** (1.00×) | 838 → 833 ms |
| `calculate_secondary_progressions` | 6 → **6** (1.00×) | unchanged |

Wall gains lead spawn gains here, which is the opposite of SUP-390 and for the same underlying
reason: the spawns removed are the *expensive* ones (a 17-body call and a 13-body one), while the two
that remain are the cheapest shape `swetest` has.

**Where the progressed rate's cost sits now.** Attribution of the 3-year all-types progressed call
before this change (1,442 spawns):

| Call site | Spawns | Share |
|---|---|---|
| body reads — Newton refinement, station refinement, coarse `seriesFor` | 746 | 51.7% |
| `progressedFrameAt` — the two frame charts, 4 spawns × 145 uncached frames | 580 | 40.2% |
| progressed Sun read inside `progressedFrameAt` (the solar arc for the frame's MC) | 112 | 7.8% |
| natal chart + the birth-time-sensitivity chart | 4 | 0.3% |

The 580 becomes 290 and nothing else moves. **Two things were deliberately left**, both because they
cannot be removed without changing published timestamps or a lot more than this:

- **The two-call handshake stays.** The fictitious longitude is a function of the ARMC *at* the
  progressed instant, so the second read cannot be issued until the first has answered. Collapsing it
  would mean computing obliquity and sidereal time in JS — reimplementing the part of Swiss Ephemeris
  this server exists to defer to.
- **The 7.8% Sun read stays.** It is one progressed-Sun position per uncached frame, taken at the
  *exact* target JD while the frame itself is cached per whole ephemeris second. Moving it onto the
  bucket's canonical instant would collapse those into one memo entry — and would move the fictitious
  longitude, hence the reported Ascendant and cusp longitudes, in their last digits. Not worth a
  published-number change for 7.8%.

`test/house-frame.integration.test.js` pins the substitution contract directly: `houseFrameAt` must
return **exactly** — not within a tolerance — what `calculateEphemeris` returns for obliquity, ARMC,
Ascendant and all twelve cusps, across five fixtures × five house systems and at fictitious
longitudes across the whole (-180, 180] range. That exactness is why the frame read keeps
reconstructing longitude from the DMS columns instead of using the decimal `-l` field it now
requests: `-l` prints `25.2146544` where the DMS columns give `25.214654389`. It also pins the claim
that lets the narrow read skip `calculateEphemeris`'s missing-ephemeris-file guard — a house frame is
byte-identical against an empty `SE_EPHE_PATH`, because obliquity and cusps come from the
nutation/sidereal-time model rather than any `.se1` file. A *planet* on that same command would
silently fall back to Moshier, which is exactly why the frame read requests none.

## Commit convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). There are two
enforcement layers, and they are not equivalent:

- **Local commit hook** (`.husky/commit-msg`, config in `commitlint.config.js`, extends
  `@commitlint/config-conventional`) runs `npx --no-install commitlint --edit "$1"` on every commit
  made in a clone with husky installed (`npm install` runs `prepare: husky`). This is convenience /
  fast feedback only — it only fires locally, and can be skipped with `git commit --no-verify`.
  Nothing enforces commit subject format at commit time in CI. Note that this repo merges with
  merge commits rather than squashing, so branch commits land on `main` verbatim — a bypassed
  message stays in the history.
- **PR title** is the layer that's actually CI-enforced. `.github/workflows/pr-title-lint.yml`
  runs `amannn/action-semantic-pull-request@v6` on PR open/edit/synchronize and requires the PR
  title itself to be a valid Conventional Commit subject. This matters because the repo is
  configured with `merge_commit_title=PR_TITLE`, so the PR title becomes the merge commit subject
  on `main` — and that's what semantic-release reads to decide the next version.

Example valid subjects:

- `feat(ephemeris): add sidereal mode`
- `fix(houses): correct Placidus calculation near polar latitudes`
- `chore: bump semantic-release plugin versions`

## Automated release process

Every push to `main` triggers `.github/workflows/release.yml`, which runs `npx semantic-release`.
The plugin pipeline (`.releaserc.json`) runs in this order:

1. `@semantic-release/commit-analyzer` — inspects commit subjects since the last release to decide
   whether the next version is a major/minor/patch bump (or no release at all).
2. `@semantic-release/release-notes-generator` — builds release notes from those commits.
3. `@semantic-release/changelog` — writes/updates `CHANGELOG.md` with the generated notes.
4. `@semantic-release/npm` (`npmPublish: false`) — bumps the version in `package.json`; does not
   publish to npm.
5. `@semantic-release/git` — commits `CHANGELOG.md` and `package.json` back to `main`, tags the
   commit, and pushes. Commit message: `chore(release): <version> [skip ci]`.
6. `@semantic-release/github` — creates a GitHub Release from the tag just pushed.

**`package.json`'s version and `CHANGELOG.md` are written by this bot, not by contributors.** Do
not hand-bump the version or hand-edit `CHANGELOG.md` in a PR — semantic-release owns both, and a
manual edit will just be overwritten (or worse, conflict with the bot's commit).

## Failure runbook

The pipeline above is ordered, and the steps after `@semantic-release/git` are **not safe to
blindly re-run** once that step has landed a commit + tag on `main`. Diagnose which case you're in
before doing anything:

- **Failure at or before `@semantic-release/npm`:** no tag or commit was pushed yet. Nothing is
  dangling. Just re-run the workflow (re-push, or use GitHub Actions' "Re-run failed jobs") —
  semantic-release recomputes everything from scratch.
- **Failure at `@semantic-release/github` (release creation), but `@semantic-release/git` already
  succeeded:** the tag and `chore(release):` commit are already on `main`, with `CHANGELOG.md` and
  `package.json` already bumped. **Do not just re-run the workflow.** Semantic-release will see
  the tag already matches the latest commit, conclude there's nothing new to release, and silently
  no-op — leaving the tag dangling with no GitHub Release. Instead, manually publish the release
  for the existing tag, e.g.:

  ```bash
  gh release create vX.Y.Z --notes-file <(path to the just-committed CHANGELOG.md section)
  ```

  (or do the equivalent through the GitHub UI), pointing at the tag that's already on `main`.

- **How to detect a dangling tag** (tag exists, no matching Release): compare the two lists —

  ```bash
  git tag --sort=-creatordate | head -5
  gh release list --limit 5
  ```

  A tag near the top of the first list with no corresponding entry in the second is dangling.

- **A tag + commit landed with a genuinely wrong version or notes:** this is rare and requires the
  repo owner's sign-off — it's a destructive operation, not something to do unprompted. Reverting
  means deleting the remote tag (`git push --delete origin vX.Y.Z`) and, if desired,
  revert-committing the `chore(release):` commit. Flag this to the repo owner rather than fixing it
  yourself.

## `CHANGELOG.md` is generated — do not hand-edit it

`CHANGELOG.md` is fully generated by `@semantic-release/changelog` from commit history. Never
hand-edit it in a PR; any manual change will be out of sync with the next automated update.
