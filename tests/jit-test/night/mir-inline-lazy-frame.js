// Lazy inline frames (docs/MIR.md §5.5): an inlined callee's
// `inline.enter` writes only its callee slot. Its `this`, formals and
// locals hold whatever the stack held before (a dead frame's values, or
// stale pointers) until the frame's first GC point on the path makes
// them valid, and its exits write the whole frame. A GC that scanned the
// frame before then would trace those bits; an exit that left one
// unwritten would resume baseline on them.

// Leave object pointers all over the stack region the inline frames
// below overlay: a deep non-inlined call chain whose frames hold fresh
// objects, which die (and whose nursery is reused) once it returns. It is
// called from the same frame as `driver`, so its frames lie where
// `driver`'s inline frames go.
function scribble(n, a, b, c, d) {
  var o1 = { n: n }, o2 = [n, a], o3 = { a: a, b: b }, o4 = [c, d, o1];
  if (n > 0) {
    return scribble(n - 1, o1, o2, o3, o4) + 1;
  }
  return o1.n + o2.length + (o3.a === a) + o4.length;
}

// One inlined level: formals and locals live and dead across a GC in it,
// on a path that is not the callee's first op.
function leaf(x, y) {
  var t = { v: x };
  var u = y * 2;
  if (x % 3 == 0) {
    minorgc();
  }
  var w = [t, u];
  if (x % 5 == 0) {
    gc();
  }
  return w[0].v + w[1];
}

// Two inlined levels: a GC in the inner callee scans the outer's frame.
function mid(x, s) {
  var k = { s: s };
  var r = leaf(x, k.s.length);
  return r + k.s.length;
}

// A loop in the inlined callee that may GC: its entry edge makes the
// frame valid, not each iteration.
function loopy(n, tag) {
  var acc = [];
  for (var i = 0; i < n; i++) {
    acc.push({ i: i, tag: tag });
    if (i % 4 == 0) {
      minorgc();
    }
  }
  var t = 0;
  for (var j = 0; j < acc.length; j++) {
    t += acc[j].i;
  }
  return t;
}

// An exit after a GC point (its frame valid) and before one (not yet):
// a non-number x leaves for baseline inside the inlined callee.
function maybeExit(x, o) {
  var before = x + 1;
  if (o.gcFirst) {
    minorgc();
  }
  var after = before + 1;
  return after + o.k;
}

function driver(round, lo, hi) {
  var total = 0;
  for (var i = lo; i < hi; i++) {
    total += leaf(i, round);
    total += mid(i, "abc");
    if (i % 50 == 0) {
      total += loopy(9, i);
    }
    var x = i == 150 ? "z" : i;
    var r = maybeExit(x, { gcFirst: i % 2 == 0, k: 1 });
    total += typeof r == "string" ? r.length : r;
  }
  return total;
}

function expected(round, lo, hi) {
  var total = 0;
  for (var i = lo; i < hi; i++) {
    total += i + round * 2;
    total += i + 3 * 2 + 3;
    if (i % 50 == 0) {
      total += 36;
    }
    total += i == 150 ? "z111".length : i + 3;
  }
  return total;
}

for (var round = 0; round < 12; round++) {
  for (var lo = 0; lo < 200; lo += 10) {
    scribble(12, lo, round, "s", null);
    minorgc();
    assertEq(driver(round, lo, lo + 10), expected(round, lo, lo + 10));
  }
}
