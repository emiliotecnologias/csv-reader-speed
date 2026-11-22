// solve.js — fast drop-in for make.fun's csv-reader 1.0.0
// Bounty: "Read broken CSV files faster" (csv-reader-speed-01-run-20261121)
// Dependency-free ES module. run(input) returns {columns, rows, errors}
// identical to the reference on every case; ranked on CPU time.
//
// Semantics (from the bounty brief):
//   - U+FEFF at the very start is dropped.
//   - A record ends at LF or CRLF; a line with no characters is no record.
//   - Outside quotes, a CR not followed by LF is dropped (stray_cr).
//   - A field opening with '"' runs to the next non-doubled '"'; '""' inside
//     is one quote; CRLF / lone CR inside read as LF.
//   - Text after the closing quote up to the next comma or line break is
//     appended as-is (quote_junk, reported when the field ends).
//   - A quote that never closes is a literal character; the text after it is
//     read again as unquoted (unterminated_quote).
//   - A quote inside an unquoted field is a literal character.
//   - Fields stay strings, never trimmed or converted.
//   - columns = first record when header is true, else null. rows = the rest
//     (every record when header is false), padded (short_row, with `fields`)
//     or cut (long_row, with `extra`) to the first record's width.
//   - Each error is {code, line, row} in the order met; short/long_row when
//     the record ends. line = 1-based line the record starts on, counting
//     every LF, CRLF and lone CR inside quotes. row = index in rows,
//     null for the header.
//
// Interpretation choices for underspecified corners (mirrored in naive.js):
//   - A stray CR counts as a character, so a line containing only a stray CR
//     still produces a record (keeps every error attached to a record).
//   - A stray CR outside quotes does not advance the line counter.
//   - Stray CRs in post-quote junk are dropped with stray_cr (outside-quote
//     rule); quote_junk fires when any raw junk characters follow the
//     closing quote. Error order: stray_cr(s) during the junk scan come
//     before quote_junk (reported at field end).
//   - unterminated_quote is reported when the fallback is decided, before
//     any errors met while re-reading the text as unquoted.
//   - No records at all => columns = null, rows = [].
//
// Speed strategy:
//   - One memchr-speed pre-scan notes whether the text contains '"' or '\r'
//     at all; when absent, whole classes of checks are skipped.
//   - Clean-record fast path: a physical line with no '"' and no stray CR
//     is split with String.split(',') — no per-field work at all.
//   - Unquoted fields are located with indexOf against a cached line bound
//     and extracted with slice (no per-character concatenation).
//   - Quoted fields jump between quotes with indexOf; segment conversion
//     (CRLF/CR -> LF) only runs when a segment actually contains a CR.
//   - Error arrays/objects are only allocated when an error actually occurs.

export function run(input) {
  const text = input.text;
  const header = !!input.header;
  const len = text.length;
  let pos = 0;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;
  const hasQuote = text.indexOf('"', pos) !== -1;
  const hasCR = text.indexOf('\r', pos) !== -1;
  let line = 1;
  const records = [];
  const errors = [];
  let width = -1;
  let bound = -1; // cached index of next '\n' at/after pos, or len; -1 = stale

  function getBound() {
    if (bound < pos) {
      const ni = text.indexOf('\n', pos);
      bound = ni === -1 ? len : ni;
    }
    return bound;
  }

  // Convert a quoted-field segment text[a..b): CRLF and lone CR read as LF,
  // each break advances the line counter. Returns the converted string.
  function convSeg(a, b) {
    const s = text.slice(a, b);
    const ri = s.indexOf('\r');
    if (ri === -1) {
      let p = s.indexOf('\n');
      while (p !== -1) { line++; p = s.indexOf('\n', p + 1); }
      return s;
    }
    let out = '';
    let seg = 0;
    const sl = s.length;
    for (let k = 0; k < sl; k++) {
      const c = s.charCodeAt(k);
      if (c === 13) {
        out += s.slice(seg, k) + '\n';
        line++;
        if (s.charCodeAt(k + 1) === 10) k++;
        seg = k + 1;
      } else if (c === 10) {
        line++;
      }
    }
    out += s.slice(seg);
    return out;
  }

  // Parse an unquoted field starting at pos.
  // Returns { value, term, contentLen }:
  //   term: 0 = comma, 1 = end of line, 2 = end of text
  //   contentLen: raw chars consumed for the field, excluding the
  //     terminator (the CR of a CRLF terminator excluded; stray CRs count)
  // Pushes stray_cr errors into recErr. Advances pos and line.
  function parseUnquotedRaw(recErr) {
    const start = pos;
    const b = getBound();
    const seg = text.slice(start, b);
    const ci = seg.indexOf(',');
    let fieldStr, term, contentLen;
    if (ci !== -1) {
      fieldStr = seg.slice(0, ci);
      term = 0;
      pos = start + ci + 1;
      contentLen = ci;
    } else {
      fieldStr = seg;
      term = b === len ? 2 : 1;
      pos = b === len ? len : b + 1;
      if (term === 1) line++;
      contentLen = seg.length;
      if (term === 1 && contentLen > 0 && seg.charCodeAt(contentLen - 1) === 13) contentLen--;
    }
    if (hasCR) {
      const ri = fieldStr.indexOf('\r');
      if (ri !== -1 && ri < contentLen) {
        let out = '';
        let s0 = 0;
        for (let k = ri; k < contentLen; k++) {
          if (fieldStr.charCodeAt(k) === 13) {
            out += fieldStr.slice(s0, k);
            recErr.push({ code: 'stray_cr' });
            s0 = k + 1;
          }
        }
        out += fieldStr.slice(s0, contentLen);
        return { value: out, term, contentLen };
      }
    }
    const value = contentLen === fieldStr.length ? fieldStr : fieldStr.slice(0, contentLen);
    return { value, term, contentLen };
  }

  // Parse a field that opens with '"' at pos.
  // Returns { value, term }.
  function parseQuoted(recErr) {
    const fStart = pos;
    const fLine = line;
    let i = pos + 1;
    let segStart = i;
    let parts = null;
    let closed = false;
    let closePos = -1;
    while (true) {
      const q = text.indexOf('"', i);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(convSeg(segStart, q));
        parts.push('"');
        i = q + 2;
        segStart = i;
      } else {
        closed = true;
        closePos = q;
        break;
      }
    }
    if (!closed) {
      recErr.push({ code: 'unterminated_quote' });
      line = fLine;
      pos = fStart + 1;
      const r = parseUnquotedRaw(recErr);
      return { value: '"' + r.value, term: r.term };
    }
    let value;
    if (parts === null) {
      value = convSeg(segStart, closePos);
    } else {
      parts.push(convSeg(segStart, closePos));
      value = parts.join('');
    }
    pos = closePos + 1;
    const r = parseUnquotedRaw(recErr);
    if (r.contentLen > 0) {
      value += r.value;
      recErr.push({ code: 'quote_junk' });
    }
    return { value, term: r.term };
  }

  while (pos < len) {
    const recLine = line;
    let fields = null;
    let recErr = null; // allocated lazily; null = no errors yet
    let hasChars = false;

    // ---- clean-record fast path ----
    const b = getBound();
    const ls = text.slice(pos, b);
    let lsEnd = ls.length;
    if (b !== len && lsEnd > 0 && ls.charCodeAt(lsEnd - 1) === 13) lsEnd--; // CRLF
    let clean = !hasQuote || ls.indexOf('"') === -1;
    if (clean && hasCR) {
      const firstCR = ls.indexOf('\r');
      clean = firstCR === -1 || firstCR === lsEnd;
    }

    if (clean) {
      if (lsEnd === 0) {
        // Empty line: no record. (b < len here: pos < len and ls is "" or "\r".)
        pos = b + 1;
        line++;
        continue;
      }
      fields = (lsEnd === ls.length ? ls : ls.slice(0, lsEnd)).split(',');
      hasChars = true;
      pos = b === len ? len : b + 1;
      if (b !== len) line++;
    } else {
      fields = [];
      recErr = [];
      let done = false;
      while (!done) {
        let value, term;
        if (pos < len && text.charCodeAt(pos) === 34) {
          hasChars = true;
          const r = parseQuoted(recErr);
          value = r.value;
          term = r.term;
        } else {
          const r = parseUnquotedRaw(recErr);
          value = r.value;
          term = r.term;
          if (term === 0 || r.contentLen > 0) hasChars = true;
        }
        fields.push(value);
        if (term !== 0) done = true;
      }
    }

    if (hasChars) {
      const isHeader = header && records.length === 0;
      const row = isHeader ? null : (header ? records.length - 1 : records.length);
      if (width === -1) {
        width = fields.length;
      } else if (fields.length < width) {
        if (recErr === null) recErr = [];
        recErr.push({ code: 'short_row', fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        if (recErr === null) recErr = [];
        recErr.push({ code: 'long_row', extra: fields.slice(width) });
        fields.length = width;
      }
      if (recErr !== null) {
        for (let e = 0; e < recErr.length; e++) {
          const er = recErr[e];
          const out = { code: er.code, line: recLine, row };
          if (er.fields !== undefined) out.fields = er.fields;
          if (er.extra !== undefined) out.extra = er.extra;
          errors.push(out);
        }
      }
      records.push(fields);
    }
  }

  let columns = null;
  let rows;
  if (header) {
    if (records.length > 0) { columns = records[0]; rows = records.slice(1); }
    else rows = [];
  } else {
    rows = records;
  }
  return { columns, rows, errors };
}

export default run;
