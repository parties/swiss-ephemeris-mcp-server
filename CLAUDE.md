# CLAUDE.md — swiss-ephemeris-mcp-server

## This repository is public

Everything committed here, and everything filed on its issue tracker, is world-readable and
permanently archived. Assume anything you write is public the moment it leaves your hands.

## Hard rule: no personal data, anywhere

Never introduce real people's birth data or identities into this repo. This applies to **all** of:

- source code, test files, and fixtures
- code comments
- `README.md`, docs, and this file
- commit messages and branch names
- GitHub issues, pull requests, and comments on either

**Specifically forbidden:**

- A real person's birth date, birth time, birthplace, or resolved coordinates
- Names of real people attached to a chart — including first names alone (`// Dana's reference chart`)
- References to private chart repositories or their file paths (`charts/people/<name>.md`)
- Chart output that can be traced back to a specific person

Birth data deserves particular care because **date + time + place is effectively a unique
identifier for a living person** — and it is also exactly the input this server takes, which makes
it easy to paste a real chart in while debugging and never think about it again. Treat a birth
datetime the way you would treat an email address or a home address.

## Use the shared synthetic charts

Do not invent a new fake chart each time, and do not paste one in from a real chart you happen to
have open. Import from `test/fixtures/charts.js`:

```js
import { DAY_CHART, NIGHT_CHART, PARTNER_CHART, SOUTHERN_CHART, houseOf } from './fixtures/charts.js';
```

| Fixture | Datetime (UTC) | Location | Why it exists |
|---|---|---|---|
| `DAY_CHART` | `1990-01-01T12:00:00Z` | Greenwich | Sun in the 10th — unambiguous day chart |
| `NIGHT_CHART` | `1990-01-01T00:00:00Z` | Greenwich | Same place, 12h earlier — unambiguous night chart |
| `PARTNER_CHART` | `1995-07-04T00:00:00Z` | New York | Second person for synastry and transits |
| `SOUTHERN_CHART` | `2000-03-20T06:00:00Z` | Sydney | Southern hemisphere — catches latitude-sign errors |

The first two are the same location twelve hours apart, so they differ *only* by sect. Any
sect-dependent logic (Part of Fortune, sect rulers) needs both — a single chart exercises one
branch and silently passes.

Each fixture carries verified `expected` values (sect, Sun house, Part of Fortune longitude), so a
test can assert a concrete number instead of only re-deriving the formula it is meant to be
checking. Re-verify rather than blindly updating them if the ephemeris data or house code changes.

Need a case the fixtures do not cover — high latitude, a specific house system, a retrograde
station? Add a new fixture to that file with verified expectations. Do not inline one-off
coordinates into a test.

The `1985-04-12T23:20:50Z` datetime appearing in the tool schema descriptions is the established
placeholder for this project and is fine to keep.

## Editing a GitHub issue does not remove anything

GitHub retains the full edit history of every issue and comment body. On a public repo **anyone can
retrieve every prior revision**, via the "edited" dropdown in the UI or the GraphQL API:

```bash
gh api graphql -f query='
{ repository(owner:"parties", name:"swiss-ephemeris-mcp-server") {
    issue(number:N) { userContentEdits(first:20) { totalCount nodes { editedAt diff } } } } }'
```

So if personal data reaches an issue, **editing the body is not remediation** — it hides the text
from the rendered page and leaves it fully readable in history. There is no way to delete an
individual revision.

The only real remedy is to **delete the issue entirely and refile a clean one**, which requires
admin permission on the repo. If this happens:

1. Stop and tell the repo owner — do not quietly edit and move on.
2. Deleting renumbers nothing, but the old numbers are gone; fix any cross-references in other
   issues that pointed at them.
3. When refiling, get the body right on the first submission so the new issue has zero revisions.

The same reasoning applies to git history: a follow-up commit that removes personal data does not
purge it from earlier commits. Purging requires a history rewrite and force-push, which is a
decision for the repo owner, not something to do unprompted.

## `npm test` does not run everything

`test/find-events-pair-aspects.integration.test.js` is quarantined behind `RUN_SLOW_TESTS=1`
(SUP-385): its 90-year progressed searches are the most expensive tests in the repo. A green
`npm test` (~20s) therefore says nothing about `include_pair_aspects`. Touching the pair path —
or the shared provider/root-finder seam under it in `lib/event-search.js` — means running `npm run
test:slow` and budgeting about 8 minutes for it. Say which of the two you ran when you report a
result. Details and per-test timings: `CONTRIBUTING.md`.

Note the cost is **not** specific to pair aspects, and an earlier version of this file said it was.
SUP-385 recorded "a single pair search over its 90-year window costs ~61,000 `swetest` spawns" and
"the cost is driven by the WINDOW, not the pair count"; SUP-387 re-measured against an
`include_pair_aspects: false` baseline and both are wrong. That 61,000 was the whole `find_events`
call, of which the pair branch was ~8% — the rest was the ordinary moving-to-natal `contacts[]`
search, which runs the same either way. What drives cost is the **sample count of the whole aspect
search**: window length, body count, target count and aspect count all multiply into it, and the
pair branch is a small minority of the total.

Five changes have since attacked that cost from different ends, and they compound: SUP-389 made
each spawn ~2.5× cheaper by dropping the `/bin/sh` wrapper (`lib/swetest-exec.js`); SUP-387 cut the
number of spawns ~8× by memoizing the provider seam and replacing the crossing refinement's
bisection ladder with a safeguarded Newton step; SUP-390 then batched the one bisection ladder
SUP-387 deliberately left alone — station refinement — behind a new optional seam method,
`samplesFrom(startJd, stepDays, count)`; SUP-391 removed the last non-refinement spawn, the
orb-interval midpoint probe in `findContacts`, for another 1.3–1.45×; SUP-393 halved the progressed
**frame** handshake — two whole `calculateEphemeris` charts (four spawns, of which one datum was
read and one entire call was dead) became two narrow `-po -house` reads in `lib/house-frame.js`,
worth 1.14–1.35× on spawns and 1.17–1.51× on wall clock, at the progressed rate only. Wall clocks
quoted anywhere against an older tree are stale in every direction — re-measure rather than scaling
them.

**The floor is now known, and it is the process, not the program (SUP-391).** A `swetest` spawn
costs ~1.79 ms on an M-series Mac, of which ~1.61 ms is spent before any ephemeris is touched (a
`swetest` given an unrecognised flag, which computes nothing, costs that much) and ~1.15 ms is what
`/usr/bin/true` costs. The Swiss Ephemeris work behind one position is **0.11 ms**. So: `swetest`
has no persistent mode to exploit and a free one would buy ~10%; nothing in the Node spawn API
(`execFileSync` vs `spawnSync`, env size, stdio shape) moves the figure at all; and after SUP-391
**90.7%** of a 1-year transit aspect call's spawns are crossing refinement running at 2.18 samples
per root against a floor of 2. Further sample-count work is worth single-digit percent. The only
remaining lever is deleting the process boundary — in-process libswe (**SUP-394**), which SUP-394
has now measured: **~160–410× on the sample cost and ~20× end to end**, not the 16× estimated here
(that figure divided by a *differenced* 0.11 ms that charges every sample for per-process setup).
It changes no **chart** figure — 119 longitudes, speeds, latitudes and declinations and 98 house
cusps across all seven fixtures came back identical below `swetest`'s own print quantum — but it
does move `find_events` **station timestamps**, because those refiners search on the printed
quantum and an in-process call's is ~10× finer rather than absent: libswe computes apparent speed
by its own finite differencing, leaving a ~1e-8 °/day noise floor. Of the four progressed stations
`docs/SUP-357-progressed-events-spec.md` §6.2 publishes at ±1 s, Mercury, Venus and Jupiter move to
clean single roots 13 s, 44 s and 8.0 min later; **progressed Pluto has no root to move to** — its
speed changes sign 61 times across a 26.7-minute band (`15:45:03Z .. 16:11:45Z`), so it can be
re-baselined to a band but not to ±1 s. That is a correction, not a regression — the current values
are a plateau edge — but it is a real re-baseline, and it is the expensive half. It also removes
an install-time toolchain requirement rather than adding one, because `swetest` is not vendored and
the README already tells users to `git clone && make` it. **The blocker is licensing, not engineering:** Swiss
Ephemeris is AGPL-3.0 unless you hold a paid Astrodienst professional licence, so linking it in
relicenses this package. That call is the repo owner's; do not start implementing until it is made.
Full spike: `docs/decisions/SUP-394-in-process-libswe.md`. Other measurements: `CONTRIBUTING.md`.

That paragraph was about the transit rate, and the progressed rate had one structural exception left
when it was written: the progressed **frame** was not sample-count work at all but four spawns of
pure overhead per uncached frame, ~40% of a progressed call. SUP-393 took it, and there is no
equivalent left — after it, a progressed frame is two spawns and every one of them computes
something the caller reads. So the floor argument now holds at both rates.

**SUP-390 is also the cautionary tale about scaling an estimate instead of re-measuring.** It was
filed predicting ~5× on `find_events` from "~24 bisection iterations, one spawn each". By the time
it was implemented SUP-387 had landed, and a fresh call-site attribution showed the crossing
refinement was already down to **2.15 samples per root** — at the floor, nothing left to batch. The
remaining ladder, `refineStationJd`, was 15% of a 1-year transit call and 6% of a 3-year progressed
one. Batching it is a real 4.3× on a station-heavy request and about 1.1× on a mixed one; the 5×
never existed by the time anyone could collect it. If a perf ticket here quotes a figure, check
what landed since it was written before you budget against it.

Note also that **no CI job runs tests at all** in this repo (SUP-386 tracks fixing that). A green
check on a PR here means the PR *title* linted. Whoever reviews is relying on your quoted local run.

## Commit and PR title conventions

Full human-oriented explanation: `CONTRIBUTING.md`. Reference block for agent use:

- **Format:** [Conventional Commits](https://www.conventionalcommits.org/), enforced by
  `commitlint.config.js` (`extends: ['@commitlint/config-conventional']`) — type, optional scope,
  colon, space, lowercase description, no trailing period. Example: `fix(houses): correct Placidus
  calculation near polar latitudes`.
- **PR title must independently satisfy the same convention.** It is CI-checked
  (`.github/workflows/pr-title-lint.yml`), and because this repo merges with a merge commit whose
  subject is the PR title (repo setting `merge_commit_title=PR_TITLE`), the PR title *is* the merge
  commit subject on `main` — that's the string semantic-release reads to pick the next version and
  the string that becomes the changelog entry. A conventional local commit message does not make
  the PR title conventional; set both.
- **If the local hook (`.husky/commit-msg`) rejects a commit:** fix the message and recommit. Do
  not reach for `git commit --no-verify` — this repo merges with merge commits, so **every branch
  commit lands on `main` verbatim**; nothing squashes a sloppy message away later. The hook skips
  local feedback only, not the PR-title CI gate.
- **`CHANGELOG.md` and the `version` field in `package.json` are generated by semantic-release.**
  Never hand-edit either; a manual edit will be overwritten by the next release run or conflict
  with the bot's `chore(release):` commit.

## Check before you commit or file

```bash
git ls-files | grep -v node_modules | xargs grep -nE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'
```

Every hit should be either one of the synthetic charts above or the `1985-04-12` placeholder.
Anything else is a real birth time until proven otherwise.

Run the same check against issue text before submitting it, and prefer getting it right the first
time over filing and editing.
