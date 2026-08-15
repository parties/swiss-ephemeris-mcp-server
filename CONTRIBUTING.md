# Contributing

## Running the tests

```bash
npm test          # the gate: ~6m15s, self-terminating
npm run test:slow # everything, including the quarantine: ~2h, deliberately unbounded
```

**Budget six to seven minutes for `npm test`.** Measured on an M-series Mac, 2026-08-15: `6m15s`
wall clock, 398 tests, 382 pass, 16 skipped, exit 0. The slowest single test is ~82s (an eclipse
window search) — nothing here is instant, because almost every integration test shells out to
`swetest` for real ephemeris data rather than using a recorded fixture.

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
process from outside catches that shape. Both defaults are roughly 3× the measured figures above;
set either to `0` to disable it.

(`node --test` does exit `1` when a test is *cancelled* rather than failed, so a per-test timeout
surfaces as a red run with no extra handling. Beware measuring this through a pipe — `node --test … |
tail` reports `tail`'s exit status, not node's.)

### The pair-aspect quarantine

`test/find-events-pair-aspects.integration.test.js` is **skipped by default** and runs only under
`RUN_SLOW_TESTS=1` (`npm run test:slow`). It is not broken and it does not hang — it is
arithmetically enormous.

**Budget about two hours.** That is an estimate summed from measured parts, not an observed total:
the file has never once been seen to finish, with attempts abandoned at 42 minutes and at 1h56m
(the latter a full-suite run, with this file still outstanding). Because nobody knows the real
figure, `test:slow` sets **no** wall-clock bound (`TEST_WALL_CLOCK_MS=0`) — a cap pitched near an
unknown runtime just converts "slow" into "fails after N hours and tells you nothing". `npm test`,
the actual gate, stays bounded either way.

Measured directly against this implementation on an M-series Mac, 2026-08-15, by calling
`find_events` in-process with each test's own parameters:

| Configuration | Measured |
|---|---|
| 1 pair (Sun–Moon), 90yr progressed, majors — §9.1 | **5.2 min** (25 episodes) |
| the same with `include_minor` — §9.1/§6.1 | **12.7 min** (62 episodes) |
| default 10 pairs, 90yr progressed — §9.2 | **6.7 min** (109 episodes) |
| 3 slow pairs (Sun/Venus/Mars), 90yr progressed — §9.3 | **5.1 min** (1 episode) |
| default 10 pairs, 10yr progressed — §9.5 | **1.1 min** |
| default 21 pairs, 1yr transit — §9.6 | **3.0 min** (52 episodes) |

Two things follow, and both are counterintuitive enough to be worth stating before anyone estimates
this file again:

- **Cost tracks the window length, not the pair count.** Ten pairs over 90 years costs barely more
  than one (6.7 vs 5.2 min), and three pairs that between them yield a *single* episode still cost
  5.1 min. `swetest` is spawned per body per sample, so extra pairs over the same body set ride
  along nearly free — what you pay for is sampling a 90-year window at all. Estimating this file by
  counting pair-searches overstates it several-fold.
- **`include_minor` costs roughly 2.5× a majors-only search** (2.47× at 90yr, 2.29× at 10yr): four
  more aspect angles to detect and bisect.

Summing the file's 16 quarantined tests at these rates lands at **≈1.5–2 h uncontended**, which is
consistent with a contended full-suite run still going at 1h56m. The underlying number to attack is
process spawns: one Sun–Moon 90-year search costs **61,150 `swetest` invocations**, each one
synchronous.

So **a green `npm test` says nothing about `include_pair_aspects`.** If you touch the pair path in
`index.js` or `lib/event-search.js`, run `npm run test:slow` and budget the two hours. Whichever of
the two you ran, say which one when you report a result. SUP-387 tracks making this fast enough to
un-quarantine; the skip and this section go away together.

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
