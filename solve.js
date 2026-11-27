// solve.js — a fast drop-in for makefun-diff 1.0.0.
//
// For an input { old, new } of two texts, run(input) returns exactly the
// patch string makefun-diff 1.0.0 returns: the header line
// "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then one hunk
// per group of nearby change runs, each hunk holding up to three kept lines
// of context around every run, deletions listed before insertions, and a "%"
// line after any line that ends its text without a newline. The edit script
// is Myers's greedy search with make.fun's tie-break (a deletion wins over an
// insertion when both reach the same point into the old text), run after the
// common prefix and the common suffix of what is left are trimmed.
//
// This module finds the reference's script, step for step, but without the
// reference's per-path objects: each case's lines are interned to small
// integers once, the search runs on typed arrays, and the V rows the
// backtrack needs are kept in one flat buffer. The forward search makes the
// same choice at every (d, k) as the reference, and the backtrack re-derives
// each choice from the stored rows, so the script — and therefore the patch
// — is identical on every input.

/**
 * The edit distance of A[a0..a1) into B[b0..b1), by the forward search alone:
 * rolling rows, no trace, so no backtrack. Rows store a count plus one, zero
 * meaning no path.
 */
function myersD(A, B, a0, a1, b0, b1) {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0) return m;
  if (m === 0) return n;
  const As = A.subarray(a0, a1);
  const Bs = B.subarray(b0, b1);
  const W = 2 * (n + m) + 3;
  const off = n + m + 1;
  let prev = new Int32Array(W);
  let cur = new Int32Array(W);
  let x = 0;
  let y = 0;
  while (x < n && y < m && As[x] === Bs[y]) {
    x++;
    y++;
  }
  prev[off] = x + 1;
  if (x === n && y === m) return 0;
  for (let d = 1; d <= n + m; d++) {
    cur.fill(0);
    for (let k = -d; k <= d; k += 2) {
      const xds = prev[off + k - 1];
      const xis = prev[off + k + 1];
      const delX = xds !== 0 && xds - 1 < n ? xds : -1;
      const insX = xis !== 0 && xis - 2 - k < m ? xis - 1 : -1;
      const x0 = delX >= insX ? delX : insX;
      if (x0 < 0) continue;
      let y0 = x0 - k;
      const lim = n < m + k ? n : m + k;
      let x1 = x0;
      let y1 = y0;
      while (x1 < lim && As[x1] === Bs[y1]) {
        x1++;
        y1++;
      }
      cur[off + k] = x1 + 1;
      if (k === n - m && x1 === n) return d;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return n + m;
}

/** The edit distance of one gap between two anchors: nothing when the sides match, else the search. */
function gapCost(A, B, a0, a1, b0, b1) {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0) return m;
  if (m === 0) return n;
  if (n === m) {
    let eq = true;
    for (let t = 0; t < n; t++) {
      if (A[a0 + t] !== B[b0 + t]) {
        eq = false;
        break;
      }
    }
    if (eq) return 0;
  }
  return myersD(A, B, a0, a1, b0, b1);
}

/**
 * An upper bound on the edit distance of A[a0..a1) into B[b0..b1), from the
 * lines unique to both sides: their longest increasing run can all be kept
 * at once, and each gap between two of them costs its own edit distance, so
 * keeping the anchors and paying every gap is one edit script, and no script
 * costs less than the least. `distinct` is the count of line bodies interned.
 */
function patienceBound(A, B, a0, a1, b0, b1, distinct) {
  const ids = 2 * distinct;
  const cntA = new Int32Array(ids);
  const cntB = new Int32Array(ids);
  for (let i = a0; i < a1; i++) cntA[A[i]]++;
  for (let j = b0; j < b1; j++) cntB[B[j]]++;
  const posB = new Int32Array(ids).fill(-1);
  for (let j = b0; j < b1; j++) if (cntB[B[j]] === 1) posB[B[j]] = j;
  // The new positions of the unique lines, in old order.
  const seq = [];
  const seqA = [];
  for (let i = a0; i < a1; i++) {
    const id = A[i];
    if (cntA[id] === 1 && cntB[id] === 1) {
      seq.push(posB[id]);
      seqA.push(i);
    }
  }
  // Their longest increasing run, with each element's predecessor.
  const U = seq.length;
  const tails = [];
  const tailIdx = [];
  const prevIdx = new Int32Array(U).fill(-1);
  for (let i = 0; i < U; i++) {
    const v = seq[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo === tails.length) {
      tails.push(v);
      tailIdx.push(i);
    } else {
      tails[lo] = v;
      tailIdx[lo] = i;
    }
    if (lo > 0) prevIdx[i] = tailIdx[lo - 1];
  }
  const anchors = [];
  let cur = tailIdx.length ? tailIdx[tails.length - 1] : -1;
  while (cur >= 0) {
    anchors.push(cur);
    cur = prevIdx[cur];
  }
  anchors.reverse();
  let cost = 0;
  let pa = a0;
  let pb = b0;
  for (const ai of anchors) {
    const i = seqA[ai];
    const j = seq[ai];
    if (i > pa || j > pb) cost += gapCost(A, B, pa, i, pb, j);
    pa = i + 1;
    pb = j + 1;
  }
  if (pa < a1 || pb < b1) cost += gapCost(A, B, pa, a1, pb, b1);
  return cost;
}

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/** The kinds a run of the edit script can be. */
const KEEP = 0;
const DEL = 1;
const INS = 2;

/**
 * One text's lines, interned against a table shared by both texts of a case.
 * A line is its body plus whether it ends in "\n": the last line of a text
 * that does not end in one has no newline, every other line has one, so a
 * line's id is its body's id doubled, plus one when it carries a newline.
 * Two lines share an id exactly when they are the same code units.
 */
function tokenize(text, table) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const bare = parts[last] !== '';
  const n = bare ? parts.length : last;
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const body = parts[i];
    let pid = table.get(body);
    if (pid === undefined) {
      pid = table.size;
      table.set(body, pid);
    }
    ids[i] = pid * 2 + (i === n - 1 && bare ? 0 : 1);
  }
  return { ids, parts, bare, n };
}

/**
 * The edit script of A[a0..a1) into B[b0..b1), as runs [kind, count] in
 * order. The forward search keeps, for each d and each diagonal k, the
 * furthest old-line count a path of d edits reaches on k, in one flat buffer
 * where row d starts at d*d and holds 2d+1 entries, each the count plus one
 * (zero meaning no path); the backtrack then walks those rows from the end,
 * re-deriving at each step whether the reference's search deleted or
 * inserted there, and how far its snake ran. `dub` is an upper bound on the
 * edit distance: a path that has made d edits on diagonal k needs at least
 * |n - m - k| more to reach the far diagonal, so a diagonal past the bound
 * cannot be on a least-cost path, and the search skips it; a diagonal the
 * least path uses is never skipped, and its sources are never skipped either,
 * so the script the search finds is the reference's. With no bound the
 * search runs whole.
 */
function myersRuns(A, B, a0, a1, b0, b1, dub) {
  const n = a1 - a0;
  const m = b1 - b0;
  const maxEdit = n + m;
  const kEnd = n - m;
  const bound = dub === undefined ? Infinity : dub;
  // A count plus one fits a Uint16 while the texts stay under 65534 lines,
  // which halves the rows' traffic; longer texts fall back to Int32.
  const wide = n >= 65534 || m >= 65534;
  let cap = 1024;
  let trace = wide ? new Int32Array(cap * cap) : new Uint16Array(cap * cap);
  const grow = () => {
    const next = wide ? new Int32Array(cap * 2 * cap * 2) : new Uint16Array(cap * 2 * cap * 2);
    next.set(trace);
    trace = next;
    cap *= 2;
  };

  // d = 0: the snake from the start, on diagonal 0.
  let x = 0;
  let y = 0;
  while (x < n && y < m && A[a0 + x] === B[b0 + y]) {
    x++;
    y++;
  }
  trace[0] = x + 1;
  if (x === n && y === m) return [];

  // The forward search: for each d, the diagonals a least-cost path can be
  // on, in steps of 2. Only k = n - m can reach both ends, so only that
  // diagonal is tested.
  let D = -1;
  for (let d = 1; d <= maxEdit; d++) {
    if (d + 1 > cap) grow();
    const rowStart = d * d;
    const prevStart = (d - 1) * (d - 1);
    let klo = kEnd - (bound - d);
    let khi = kEnd + (bound - d);
    if (klo < -d) klo = -d;
    if (khi > d) khi = d;
    if (((klo + d) & 1) !== 0) klo++;
    if (((khi + d) & 1) !== 0) khi--;
    if (klo > khi) continue;
    // k = -d: only the insertion from diagonal -d + 1 can reach it.
    if (klo === -d) {
      const xis = trace[prevStart];
      const k = -d;
      let x0 = -1;
      if (xis !== 0) {
        const xi = xis - 1;
        if (xi - k - 1 < m) x0 = xi;
      }
      if (x0 >= 0) {
        let y0 = x0 - k;
        const lim = n < m + k ? n : m + k;
        while (x0 < lim && A[a0 + x0] === B[b0 + y0]) {
          x0++;
          y0++;
        }
        trace[rowStart] = x0 + 1;
        if (k === kEnd && x0 === n) {
          D = d;
          break;
        }
      } else trace[rowStart] = 0;
    }
    const kloM = klo < -d + 2 ? -d + 2 : klo;
    const khiM = khi > d - 2 ? d - 2 : khi;
    for (let k = kloM; k <= khiM; k += 2) {
      const j = k + d;
      // The (d-1)-paths this diagonal extends: the deletion's from k-1, the
      // insertion's from k+1. A move past either text's end is no candidate.
      // The deletion's result is xd + 1 old lines, the insertion's xi; the
      // deletion wins the tie, and -1 is no candidate at all.
      const xds = trace[prevStart + j - 2];
      const xis = trace[prevStart + j];
      const mk = m + k;
      const delX = xds !== 0 && xds - 1 < n ? xds : -1;
      const insX = xis !== 0 && xis - 2 - k < m ? xis - 1 : -1;
      const x0 = delX >= insX ? delX : insX;
      if (x0 < 0) {
        trace[rowStart + j] = 0;
        continue;
      }
      // From the step's point, follow every run of equal lines as far as it goes.
      let y0 = x0 - k;
      const lim = n < mk ? n : mk;
      let x1 = x0;
      let y1 = y0;
      while (x1 < lim && A[a0 + x1] === B[b0 + y1]) {
        x1++;
        y1++;
      }
      trace[rowStart + j] = x1 + 1;
      if (k === kEnd && x1 === n) {
        D = d;
        break;
      }
    }
    if (D >= 0) break;
    // k = d: only the deletion from diagonal d - 1 can reach it.
    if (khi === d) {
      const xds = trace[prevStart + 2 * d - 2];
      const k = d;
      let x0 = -1;
      if (xds !== 0 && xds - 1 < n) x0 = xds;
      if (x0 >= 0) {
        let y0 = x0 - k;
        const lim = n < m + k ? n : m + k;
        while (x0 < lim && A[a0 + x0] === B[b0 + y0]) {
          x0++;
          y0++;
        }
        trace[rowStart + 2 * d] = x0 + 1;
        if (k === kEnd && x0 === n) D = d;
      } else trace[rowStart + 2 * d] = 0;
    }
    if (D >= 0) break;
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // The backtrack: from (n, m) at D, re-derive each step from the stored rows.
  // The previous point shares the step's new line (a deletion) or its old line
  // (an insertion), which bounds the snake walked back, so it can never run
  // past the step it belongs to.
  const ops = [];
  x = n;
  y = m;
  let k = n - m;
  for (let d = D; d >= 1; d--) {
    const prevStart = (d - 1) * (d - 1);
    const prevLen = 2 * d - 1;
    const jd = k + d - 2;
    const ji = k + d;
    const xds = jd >= 0 && jd < prevLen ? trace[prevStart + jd] : 0;
    const xis = ji >= 0 && ji < prevLen ? trace[prevStart + ji] : 0;
    const xd = xds - 1;
    const xi = xis - 1;
    const canDel = xds !== 0 && xd < n;
    const canIns = xis !== 0 && xi - k - 1 < m;
    let del;
    if (canDel && (!canIns || xd >= xi - 1)) del = true;
    else if (canIns) del = false;
    else throw new Error('makefun-diff: the search ended without reaching both ends');
    let px;
    let py;
    if (del) {
      px = xd;
      py = xd - k + 1;
    } else {
      px = xi;
      py = xi - k - 1;
    }
    let keep = 0;
    while (x > px && y > py && A[a0 + x - 1] === B[b0 + y - 1]) {
      x--;
      y--;
      keep++;
    }
    if (keep > 0) ops.push([KEEP, keep]);
    if (del) {
      ops.push([DEL, 1]);
      x--;
    } else {
      ops.push([INS, 1]);
      y--;
    }
    k = del ? k - 1 : k + 1;
  }
  let keep = 0;
  while (x > 0 && y > 0 && A[a0 + x - 1] === B[b0 + y - 1]) {
    x--;
    y--;
    keep++;
  }
  if (keep > 0) ops.push([KEEP, keep]);

  // Into forward order, merging runs of one kind.
  const runs = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const [kind, count] = ops[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += count;
    else runs.push([kind, count]);
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, parts, i, n, bare) {
  return i === n - 1 && bare ? `${op}${parts[i]}\n%\n` : `${op}${parts[i]}\n`;
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const table = new Map();
  const oldT = tokenize(input.old, table);
  const newT = tokenize(input.new, table);
  const a = oldT.ids;
  const b = newT.ids;
  const n = oldT.n;
  const m = newT.n;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  // The middle's edit distance is bounded by the patience bound, which the
  // search uses to skip diagonals no least-cost path can be on. A script
  // longer than the bound would mean the bound or the pruning failed, so the
  // search then runs whole; a least-cost script can never be longer than a
  // script that exists.
  let midRuns;
  let midD = 0;
  const dub = patienceBound(a, b, prefix, n - suffix, prefix, m - suffix, table.size);
  try {
    midRuns = myersRuns(a, b, prefix, n - suffix, prefix, m - suffix, dub);
    for (const r of midRuns) if (r[0] !== KEEP) midD += r[1];
    if (midD > dub) throw new Error('makefun-diff: the search missed a shorter script');
  } catch {
    midRuns = myersRuns(a, b, prefix, n - suffix, prefix, m - suffix);
  }
  for (const r of midRuns) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === r[0]) last[1] += r[1];
    else runs.push([r[0], r[1]]);
  }
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DEL) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', oldT.parts, at, n, oldT.bare));
      for (let i = 0; i < c.dels; i++) out.push(written('-', oldT.parts, c.o + i, n, oldT.bare));
      for (let i = 0; i < c.ins; i++) out.push(written('+', newT.parts, c.p + i, m, newT.bare));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', oldT.parts, at, n, oldT.bare));
  }
  return out.join('');
}
