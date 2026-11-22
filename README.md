# csv-reader-speed — make.fun bounty entry

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/emiliotecnologias/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/emiliotecnologias/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

Entry for the make.fun bounty **"Read broken CSV files faster"**
(`csv-reader-speed-01-run-20261121`): a faster drop-in for make.fun's own
csv-reader 1.0.0 that answers exactly as it does on every case.
$100 USDC pool, 10 places × $10, deadline **Mon 23 Nov 2026, 02:42 UTC**.
A reward needs a CPU time faster than csv-reader 1.0.0 (the house baseline)
in the final heat at 95% confidence.

## Files

| File | Purpose |
|---|---|
| `solve.js` | **The parser.** Dependency-free ES module; `run(input)` returns `{columns, rows, errors}`. |
| `main.ts` | **The driver the harness runs.** Reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`. |
| `naive.js` | Straightforward char-by-char implementation of the same spec — correctness oracle + speed baseline. |
| `test.mjs` | 42 hand-written edge cases with expected outputs + 20,000 fuzz cross-checks (naive vs solve). |
| `bench.mjs` | Generates large clean/broken/quote-heavy CSVs, verifies identical output, times both parsers. |

## How to run

- Entry (as the harness does): `node main.ts` — reads `/input/cases.json`,
  writes `/output/answers.json`. Outside a container, set
  `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` to stand in for `/input` and
  `/output`.
- Tests: `node test.mjs` · Benchmark: `node bench.mjs` (Node 22+).

## Contract

- Input: `{ text, header }` — CSV text (may be "broken"), header flag.
- Output: `{ columns, rows, errors }` — JSON-identical to csv-reader 1.0.0.
  - `columns`: first record when `header` is true, else `null`.
  - `rows`: remaining records (all records when `header` is false), padded
    with `""` or cut to the first record's width.
  - `errors`: `{code, line, row}` in the order met (`short_row` adds
    `fields`, `long_row` adds `extra`); `line` is the 1-based line the
    record starts on (counting breaks inside quotes); `row` is the index
    in `rows`, `null` for the header.
- Error codes: `stray_cr`, `quote_junk`, `unterminated_quote`, `short_row`,
  `long_row`.
- Pure function: no caching between calls, no I/O, no dependencies.

## Parser approach (solve.js)

- One memchr-speed pre-scan notes whether the text contains `"` or `\r`
  at all; when absent, whole classes of checks are skipped.
- **Clean-record fast path:** a physical line with no `"` and no stray CR
  is split with `String.split(',')` — no per-field work.
- Unquoted fields are located with `indexOf` against a cached line bound
  and extracted with `slice` (no per-character concatenation).
- Quoted fields jump between quotes with `indexOf`; segment conversion
  (CRLF/CR → LF) only runs when a segment actually contains a CR.
- Error arrays/objects are allocated only when an error actually occurs.
- `main.ts` turns V8's incremental marking off before importing solve.js,
  the same tuning the house baseline runs with.

## Semantics implemented

- U+FEFF at the very start dropped. Records end at LF or CRLF; a line with
  no characters is no record.
- Outside quotes, a CR not followed by LF is dropped (`stray_cr`).
- A field opening with `"` runs to the next non-doubled `"`; `""` inside is
  one quote; CRLF / lone CR inside read as LF.
- Text after the closing quote up to the next comma or line break is
  appended as-is (`quote_junk`, reported when the field ends).
- A quote that never closes is a literal character; the text after it is
  read again as unquoted (`unterminated_quote`).
- A quote inside an unquoted field is a literal character.
- Fields stay strings, never trimmed or converted.

Interpretation choices for underspecified corners are documented in
`solve.js` comments (stray CR counts as a character and does not advance
the line counter; stray CRs in post-quote junk are dropped with
`stray_cr` before `quote_junk` fires; `unterminated_quote` is reported
before errors met while re-reading; no records ⇒ `columns = null`,
`rows = []`).

## Verification

- `node test.mjs` — **20,042 checks, 0 failures** (42 hand-written cases
  against expected outputs for both implementations + 20,000 fuzz cases
  cross-checked naive vs solve).
- Practice set (kit `practice/input` → `main.ts` → compare with
  `practice/reference/expected.json`): **6/6 cases identical** to
  csv-reader 1.0.0's answers.
- `node bench.mjs` — outputs identical on every generated input;
  solve.js measured **1.3×–1.9× faster** than the naive char-by-char
  baseline across clean / broken / quote-heavy workloads (4–44 MB inputs;
  absolute numbers vary with machine load).

## License

MIT — see `LICENSE`.
