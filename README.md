[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/rayarvan77/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/rayarvan77/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

# A faster drop-in for makefun-diff 1.0.0

This is my entry for the [make.fun](https://make.fun) bounty
"Diff two texts faster, 27 November 2026": a program that answers every case
with exactly the patch `makefun-diff 1.0.0` would return, but in a fraction of
its CPU time.

## What it does

`run(input)` in `solve.js` takes `{ old, new }`, two texts, and returns
makefun-diff's patch of the old text into the new one as one string: the
header line `makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I`, then
one hunk per group of nearby change runs, each hunk showing up to three kept
lines of context around every run, deletions before insertions, and a `%`
line after any line that ends its text without a newline. Identical texts
give the header line alone.

The edit script is Myers's greedy search with make.fun's tie-break — a
deletion wins over an insertion when both reach the same point into the old
text — run after the common prefix and the common suffix of what is left are
trimmed. `main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## How it gets faster

The reference keeps a whole path object per search step, with a linked list
of components behind it, and compares lines as strings. This entry keeps the
same search, but on cheaper ground:

- **Lines become small integers.** Each case's lines are interned once
  against a table shared by both texts, so a line is its body's id doubled,
  plus one when it carries a newline. Comparing two lines is then one
  integer comparison, and a line that ends its text without a newline still
  differs from the same body with one.
- **The search runs on typed arrays.** The furthest point each diagonal
  reaches is kept in one flat buffer, one row per edit count, each entry the
  count plus one (zero meaning no path). No object is allocated per step.
  The script is recovered by walking those rows back from the end,
  re-deriving at each step whether the search deleted or inserted there.
- **Diagonals no least-cost path can use are skipped.** The lines unique to
  both texts have a longest increasing run that can all be kept at once, and
  each gap between two of them costs its own edit distance, so keeping those
  anchors and paying every gap is one edit script — an upper bound on the
  least distance. A path that has made `d` edits on diagonal `k` still needs
  at least `|n - m - k|` more to reach the far diagonal, so any diagonal
  past the bound cannot be on a least-cost path. The search skips those,
  which cuts roughly half its steps on the practice set, where the bound
  comes out equal to the least distance. If the script the search finds
  ever came out longer than the bound, the search runs whole instead.

## Results on the practice set

All four practice cases match makefun-diff's answers exactly, and the entry
runs about four to five times faster than the house baseline on this machine
(roughly 85 ms per case against roughly 400 ms per case). It was also checked
against the reference on forty freshly drawn cases, forty-two hand-built edge
cases (empty texts, bare endings, CRLF, swaps, moved blocks, repeated lines)
and four hundred random small diffs, with no difference anywhere.

## Layout

- `solve.js` — the entry: `run(input)` returns the patch string.
- `main.ts` — the driver: reads `/input/cases.json`, writes
  `/output/answers.json`.

No dependencies, no network, no secrets. Node 22 runs it as it is.
