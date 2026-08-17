# SUP-394: In-process libswe — measurement, and why the decision is a licensing one

## Status

**Measured and recommended; blocked on one call that is the repo owner's, not an engineer's.**

The engineering question this ticket was filed to answer is settled, and it came out better than
the ticket predicted on every axis it named. The blocker that remains is not packaging, not
numeric drift, and not build tooling — it is that linking libswe into this package changes what
the package distributes, and therefore what licence it can carry.

## What was measured

A spike, per the ticket's own suggested first step: install one candidate, call `swe_calc_ut`
against the vendored `.se1` files, diff it against `swetest` across every fixture chart, and time
it. Candidate: [`sweph`](https://github.com/timotejroiko/sweph) 2.10.3-7 — N-API bindings to
Swiss Ephemeris **2.10.03**, the same version as the vendored `swetest`. M-series Mac,
2026-08-16, Node 24.

### 1. The numbers do not move. At all.

119 body longitudes (Sun through Pluto, true Node, mean Apogee, Chiron, Ceres, Pallas, Juno,
Vesta) and 98 house cusps / Ascendants / MCs, across all seven fixtures in
`test/fixtures/charts.js` — `DAY_CHART`, `NIGHT_CHART`, `PARTNER_CHART`, `SOUTHERN_CHART`,
`WHOLE_SIGN_EDGE_CHART`, `NODE_DIVERGENCE_CHART`, `POLAR_CHART` — computed both ways and diffed:

| Quantity | Compared | Max abs difference |
|---|---|---|
| Body longitude | 119 | 4.957e-8° |
| True obliquity | 7 | 4.970e-8° |
| House cusps, Ascendant, MC (Placidus) | 98 | 1.335e-8° |

`swetest` prints 7 decimal places, so its own output quantum is 1e-7°. **Every difference above is
below the precision `swetest` is capable of printing** — the worst case,
`WHOLE_SIGN_EDGE_CHART` Vesta, prints `91.0911068` on both sides. This is not "close agreement";
it is the same library at the same version reading the same data files, and the residual is the
decimal rounding of the printed column.

This is the figure the ticket said the decision turns on, and the answer is **zero figures move**.
The "expensive half" — re-verifying every `expected` and every published figure in `docs/` — is
not expensive. For bodies and houses it is a diff that already passes.

**The one exception is eclipses.** `lib/ephemeris-series.js` reaches eclipses through
`swetest -solecl` / `-lunecl` and `lib/swetest-parse.js` parses the resulting text blocks. The
library equivalents (`sol_eclipse_when_glob`, `lun_eclipse_when`, and the `*_how` calls for
magnitudes) return the same quantities, but the type strings the parser currently reads
(`"penumb. lunar eclipse"` and friends) are `swetest`'s own display layer, not library output.
That path is a port with real re-verification behind it, not a drop-in. It is the only one.

### 2. The speedup is ~160–410×, not 16×.

The ticket's 16× came from dividing the 1.79 ms spawn by the 0.11 ms of "ephemeris work" that
CONTRIBUTING.md derived *by differencing two `swetest` invocations*. That differencing charges
each sample for work that is per-process, not per-position: opening and mapping the `.se1` file,
`swe_set_ephe_path`, and output formatting. A resident library pays those once.

Measured directly, same machine, same data files:

| Unit | Spawned `swetest` | In-process | Ratio |
|---|---|---|---|
| 1 body, 1 instant | 2.24 ms | 0.0054 ms | **411×** |
| 17 bodies, 1 instant (the `calculate_planetary_positions` call) | 2.89 ms | 0.041 ms | **70×** |
| 1 house frame (`-po -house`, per `lib/house-frame.js`) | 2.49 ms | 0.0089 ms | **278×** |

The in-process figure is not a memoisation artifact: every one of 20,000 calls per row returned a
distinct longitude, and the cost was re-measured across JD step sizes from 1e-5 days (adjacent
refinement samples) to 16 days (a 876-year sweep that forces constant segment reloads):

| JD step between calls | 1e-5 d | 0.01 d | 1 d | 16 d |
|---|---|---|---|---|
| ms/call (Mars) | 0.0057 | 0.0070 | 0.0081 | 0.0137 |

Worst case — deliberately defeating segment locality — is 0.0137 ms, still **163×** under a spawn.
First call in a fresh process, including opening the file, is 0.027 ms.

**End to end**, the canonical call in CONTRIBUTING.md (1 year, transit rate, `aspect` only, pairs
off, `DAY_CHART`) is 888 spawns and 1,883 ms wall. At 2.02 ms/spawn that is ~1,794 ms of process,
95% of the wall clock; the same 888 samples in-process cost ~7 ms. The call becomes bounded by
Node startup and JS, landing somewhere under 100 ms — call it **~20× end to end**, and after that
the profile is a different program with different hot spots.

That also collects what section 4 of the ticket anticipated: `test:slow` at 7m41s is almost
entirely spawn, so it gets cheap enough to un-quarantine, and the synchronous `execFileSync` that
forces `scripts/run-tests.mjs` to carry an external wall-clock kill (SUP-385) stops being
synchronous-and-unkillable.

### 3. Packaging gets *better*, not worse. The ticket had this backwards.

The ticket assumed native bindings "need a C/C++ toolchain at install time, which breaks `npx`
for anyone without one". The status quo is worse than that already:

> ```bash
> git clone https://github.com/aloistr/swisseph.git /tmp/swisseph && cd /tmp/swisseph && make && cp swetest /usr/local/bin/
> ```
> — README.md, "Prerequisites for Local Development"

**`swetest` is not vendored.** `lib/swetest-exec.js` resolves it off `PATH`, and the server exits
at startup if it is not there. Today, running this package at all requires the user to have a C
toolchain and to build Swiss Ephemeris by hand, out of band, before `npx` will work. The repo
vendors only the 2.1 MB of `.se1` data.

`sweph` ships prebuilt N-API binaries for `darwin-arm64`, `linux-x64`, `linux-arm64` and
`win32-x64`. Installing it into a scratch project took **3 seconds and compiled nothing** — no
`build/` directory, `node-gyp-build` resolved a prebuild. N-API means those prebuilds stay valid
across Node major versions.

So for every platform in that list, in-process bindings **remove** an install-time toolchain
requirement that exists today. Two gaps worth naming rather than discovering later:

- **No `darwin-x64` prebuild.** Intel Macs fall back to a `node-gyp` compile — i.e. exactly the
  status quo, no worse.
- **No musl prebuild**, and the Dockerfile is `node:18-alpine`. Not a problem in practice: that
  image already installs `build-base gcc g++` and already git-clones and `make`s Swiss Ephemeris,
  so the fallback compile has everything it needs — and the clone-and-make layer would *go away*.
  One concrete catch: the image runs `npm ci --omit=dev --ignore-scripts` (added to dodge husky),
  and `--ignore-scripts` would also skip `node-gyp-build`. That needs an `npm rebuild sweph` or a
  different husky workaround.

### 4. And that is where it stops, because of the licence.

Swiss Ephemeris is dual-licensed by Astrodienst AG. `sweph`'s own terms, from its README:

> Starting from version `2.10.1` and later, this library is licensed under `AGPL-3.0`.
> […] If you own a **professional licence** for the Swiss Ephemeris, you may use any version of
> this library under `LGPL-3.0`.

LGPL — the option that would let the server stay permissive — is gated behind a paid professional
licence from Astrodienst. Absent that, in-process libswe is **AGPL-3.0**. This is not specific to
`sweph`: `swisseph` (mivion) and `swisseph-wasm` are the same library under GPL-family terms, and
there is no permissive route to Swiss Ephemeris. Native vs WASM does not move this at all — which
is why the native-or-WASM question the ticket leads with turns out not to be the decision.

Why this changes with in-process and not before: today the package distributes **no** Swiss
Ephemeris program code. It shells out to a separate binary that the user installs themselves —
the textbook separate-works case. Linking libswe into the process and shipping it in the npm
tarball makes the published package a combined work, and AGPL §13's network clause is aimed
squarely at software of exactly this shape: a server.

Note what this does *not* change: every user already has to build and run AGPL-licensed `swetest`
to use this server at all. Nobody escapes the Swiss Ephemeris licence today; they just satisfy it
by hand. The change is to what **this repo distributes**, not to what its users run.

## Recommendation

**Adopt `sweph` and relicense the package AGPL-3.0**, unless there is a reason to keep it MIT that
is worth ~20× and the manual `swetest` prerequisite.

The engineering case is not close. It is faster than the estimate by an order of magnitude, it
changes no published number, it deletes a build-from-source step from both the README and the
Dockerfile, and it retires the SUP-385 test machinery. The cost is a licence change on a public
personal tool that is already unusable without AGPL software installed alongside it.

The alternatives, so the trade is explicit:

| | Perf | Install UX | Licence cost |
|---|---|---|---|
| **A. `sweph`, relicense AGPL-3.0** | ~20× | improves — prebuilts, no toolchain | server becomes AGPL; network users get a source offer under §13 |
| **B. `sweph` + Astrodienst professional licence, use under LGPL-3.0** | ~20× | improves | money, plus LGPL dynamic-linking compliance; package stays permissive |
| **C. Stay on `swetest`** | none — this repo's perf work is finished either way | unchanged: user builds Swiss Ephemeris by hand | none |

MIT → AGPL is available even though this repo is a fork of
`ducrouxolivier/swiss-ephemeris-mcp-server`: MIT is GPL-compatible, so the inherited code can be
redistributed inside an AGPL combined work as long as its MIT notice is retained. It is not a
question of whether it *can* be done.

**This is a repo-owner call, not an engineering one, and it is the only thing standing between the
measurement above and the implementation.** No implementation work should start until it is made —
the whole point of filing SUP-394 as a decision was to avoid building first.

## Noticed while measuring, unrelated to the decision

`package.json` declares `"license": "MIT"` and lists `"LICENSE"` in `files`, but **no `LICENSE`
file exists in the repo** — `git ls-files` has no match and GitHub reports no detected licence.
The published tarball therefore claims a licence it does not carry. Separately, `vendor/swisseph/`
ships 2.1 MB of Astrodienst `.se1` data under that same MIT label. Both predate this ticket and
are filed separately; neither is resolved by, or blocks, the decision above.

## Reproducing

The spike is three files against a scratch `npm install sweph`, not committed: a diff harness that
runs the repo's exact `swetest` argv (`-p0123456789tADFGHIo -fPZSBDl- -g, -head` and
`-house<lon>,<lat>,P -fPZSBD -g, -head`) against `calc_ut`/`houses` for each fixture, and two
timing harnesses. One trap worth recording, because it cost a measurement pass: benchmarking with
`execFileSync('swetest', …)` rather than an absolute path reports **35 ms/spawn** instead of
2.24 ms — a bare binary name makes Node search `PATH` on every call. `lib/swetest-exec.js` already
resolves the absolute path once, which is why the repo does not pay this; a benchmark that skips
that step measures something the server never does.
