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
