# Contributing

## Running the tests

```bash
npm test          # the gate: ~1m15s, self-terminating
npm run test:slow # everything, including the quarantine: ~26m, deliberately unbounded
```

**Budget a minute and a half for `npm test`.** Measured on an M-series Mac, 2026-08-16: `1m15s`
wall clock, 402 tests, 386 pass, 16 skipped, exit 0. The slowest single test is ~12s (a lunation
phase-set search) — nothing here is instant, because almost every integration test shells out to
`swetest` for real ephemeris data rather than using a recorded fixture. It was `6m15s` with an ~82s
slowest test before SUP-387 took the per-sample process spawns out of the event search.

`npm test` runs through `scripts/run-tests.mjs` rather than calling `node --test` directly, because
`node --test` alone cannot fail a hung run in this repo. Two independent bounds are needed
(SUP-385):

| Bound | Env var | Default | Catches |
|---|---|---|---|
| per-test | `TEST_TIMEOUT_MS` | `300000` | a test awaiting something that never settles |
| whole run | `TEST_WALL_CLOCK_MS` | `1200000` | a test that blocks without ever yielding |

The second is not redundant. `--test-timeout` is a timer *inside* the test process, so it only fires
when the event loop turns — and every `swetest` call in this repo goes through `execSync`
(`lib/ephemeris-series.js`), so a runaway search blocks the loop outright and that timer never runs.
Verified: a test that busy-loops for 20s passes clean under `--test-timeout=2000`. Only killing the
process from outside catches that shape. Set either to `0` to disable it.

Both defaults were pitched at roughly 3× the figures measured when SUP-385 set them, and SUP-387
then cut the suite by about 4× without moving them. That headroom is deliberate rather than
overlooked: these bounds exist to catch a hang, and a hang is unbounded — pitching them close to a
fast suite's real runtime buys nothing and starts failing runs on a contended or slower machine.

(`node --test` does exit `1` when a test is *cancelled* rather than failed, so a per-test timeout
surfaces as a red run with no extra handling. Beware measuring this through a pipe — `node --test … |
tail` reports `tail`'s exit status, not node's.)

### The pair-aspect quarantine

`test/find-events-pair-aspects.integration.test.js` is **skipped by default** and runs only under
`RUN_SLOW_TESTS=1` (`npm run test:slow`). It is not broken and it does not hang — it is
arithmetically enormous.

**Budget about 26 minutes.** That is now an observed end-to-end figure rather than an estimate:
before SUP-387 this file had never once been seen to finish, with attempts abandoned at 42 minutes
and at 1h56m against a ≈1.5–2 h guess summed from parts. `test:slow` still sets **no** wall-clock
bound (`TEST_WALL_CLOCK_MS=0`); `npm test`, the actual gate, stays bounded either way.

Per-test wall clocks from that run, as reported by `node --test` — the four longest, plus the two
figures the old table above them can be compared against:

| Test | Wall clock |
|---|---|
| §9.5 (Sun, Midheaven) excluded at either `angle_method` — two 90yr searches | 4.9 min |
| §9.3 Sun–Mars / Venus–Mars, majors **and** `include_minor` over 90yr | 3.8 min |
| §9.1/§6.1 eight_phase identity with `include_minor` — 90yr | 3.1 min |
| §9.5 North Node never pairs — 90yr | 2.7 min |
| §9.1 Sun–Moon majors — 90yr (was 5.2 min as a bare search) | 1.5 min |
| §9.2 default 10 pairs — 90yr (was 6.7 min) | 1.2 min |
| §9.6 transit rate, default 21 pairs, 1yr window (was 3.0 min) | 17.1 s |

### What SUP-387 actually changed, and what drives the cost

Measured with a counting shim ahead of the real `swetest` on `PATH`, `DAY_CHART`, this branch
against `origin/main` on the same machine in the same session. Spawn counts are exact; the wall
clocks quoted are from separate unshimmed runs (the shim inflates wall time ~1.7×, not spawns):

| `find_events` call | Spawns before | Spawns after |
|---|---|---|
| 1yr transit, aspects, pairs **off** | 11,510 | **1,490** (−87%) |
| 1yr transit + Mars–Jupiter pair | 13,030 | **1,539** (−88%) |
| 3yr progressed + Sun–Moon pair | 4,626 | **492** (−89%) |
| 6mo transit, all five event types | 1,663 | **185** (−89%) |
| 2yr progressed, angles + moving cusps | 1,108 | **263** (−76%) |

The first row unshimmed: **83.4 s → 10.5 s**.

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
