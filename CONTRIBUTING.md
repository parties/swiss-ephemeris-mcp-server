# Contributing

## Running the tests

```bash
npm test          # the gate: ~35s, self-terminating
npm run test:slow # everything, including the quarantine: ~11m, deliberately unbounded
```

**Budget under a minute for `npm test`.** Measured on an M-series Mac, 2026-08-16: `36.5s` wall
clock, 407 tests, 391 pass, 16 skipped, exit 0. The slowest single test is ~5.4s — nothing here is
instant, because almost every integration test spawns `swetest` for real ephemeris data rather than
using a recorded fixture.

Two changes cut that figure and they compound, so any older absolute number in this file's history
is stale in both directions. **SUP-389** stopped routing every spawn through `/bin/sh`: back to
back on one machine the suite went `7m39s` → `2m56s`. **SUP-387** then took most of the spawns out
of the event search entirely. Read these as machine-specific — a `6m15s`/398-test figure in this
file's history was the same pre-change suite on a quieter machine.

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

**Budget about 11 minutes.** That is now an observed end-to-end figure rather than an estimate:
before SUP-387 and SUP-389 this file had never once been seen to finish, with attempts abandoned at
42 minutes and at 1h56m against a ≈1.5–2 h guess summed from parts. Measured 2026-08-16 on the tree
carrying both changes, twice on an M-series Mac: `10m56s` and `10m44s` end to end, 407 tests, 407
pass, 0 skipped, exit 0. `test:slow` still sets **no** wall-clock bound (`TEST_WALL_CLOCK_MS=0`);
`npm test`, the actual gate, stays bounded either way.

Per-test wall clocks from that run, as reported by `node --test` — the longest few:

| Test | Wall clock |
|---|---|
| §9.5 (Sun, Midheaven) excluded at either `angle_method` — two 90yr searches | 113.6 s |
| §9.3 Sun–Mars / Venus–Mars, majors **and** `include_minor` over 90yr | 97.4 s |
| §9.1/§6.1 eight_phase identity with `include_minor` — 90yr | 76.7 s |
| §9.5 North Node never pairs — 90yr | 70.9 s |
| §9.5 retrograde is per body, not per relative rate — 90yr | 56.2 s |
| Ascendant × Midheaven eligible but not default — 90yr | 46.8 s |
| §9.1 Sun–Moon majors — 90yr | 33.3 s |

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

**The quarantine stays, and here is the arithmetic rather than a preference.** SUP-387 set out to
make this file cheap enough to un-quarantine. It got `test:slow` from never-finishing to 11 minutes,
which is a budget a CI job could carry — but deleting the skip does not add 11 minutes to a CI job,
it adds them to `npm test`, turning the gate everyone runs before every commit from 36 seconds into
roughly 11 minutes. It would also leave the default `TEST_WALL_CLOCK_MS` (20 min) with 1.8×
headroom instead of the current 33×, so an ordinary slow morning on a contended machine would start
failing honest runs.

The remaining cost is process spawn, and the only thing left that removes it is removing the spawn
itself — a persistent `swetest` or libswe bindings — which is its own ticket, not a shorter window
here. Where 11 minutes *does* pay off is CI: `test:slow` is now a plausible separate job, which it
was not at 26 minutes and certainly not at two hours. That belongs to SUP-386, which tracks this
repo having any test job at all.

So **a green `npm test` still says nothing about `include_pair_aspects`.** If you touch the pair
path — or the shared provider/root-finder seam under it in `lib/event-search.js` — run `npm run
test:slow`. Whichever of the two you ran, say which one when you report a result.

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
