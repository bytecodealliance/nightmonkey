// MIR for a sloppy script with no formals that reads `arguments` (a mapped
// arguments object with nothing to map): scheme runtimes' variadic list
// builders. `arguments.callee` and element writes see one object.
function Pair(car, cdr) { this.car = car; this.cdr = cdr; }
function list() {
  var res = null;
  var a = arguments;
  for (var i = a.length - 1; i >= 0; i--) res = new Pair(a[i], res);
  return res;
}
function len(l) { var n = 0; while (l !== null) { n++; l = l.cdr; } return n; }
function self() { return arguments.callee; }
function bump() {
  arguments[0] = arguments[0] + 1;
  arguments[arguments.length] = 5;
  return arguments[0] * 10 + arguments.length;
}
for (var n = 0; n < 40; n++) {
  assertEq(list(), null);
  assertEq(len(list(1, 2, 3)), 3);
  assertEq(list(1, 2, 3).cdr.car, 2);
  assertEq(self(), self);
  assertEq(bump(1, 2), 22);
}
// An exit mid-loop (a double and a string reach `a[i]`).
assertEq(list(1.5, "s", 3).cdr.car, "s");
assertEq(list(1.5).car, 1.5);

// With a call object too (a closure over a local): the arguments object
// records the activation's call object, not the callee's environment,
// and survives a GC.
function withEnv() {
  var a = arguments;
  var k = 3;
  var f = function () { return a.length * k; };
  if (a.length > 2) gc();
  return f() + (a[0] | 0);
}
for (var n = 0; n < 60; n++) {
  assertEq(withEnv(), 0);
  assertEq(withEnv(1, 2), 7);
}
assertEq(withEnv(1, 2, 3), 10);

// With formals: a mapped `arguments` object aliases them both ways, the
// formals are read and written through it, and baseline (after an exit or
// before an onramp) sees the same.
function alias(a, b) {
  arguments[0] = a * 2;
  b = b + 1;
  return a * 100 + arguments[1] * 10 + arguments.length;
}
function loopAlias(n, s) {
  for (var i = 0; i < n; i++) {
    s += arguments[2] | 0;
    n = n;                        // a formal write inside the loop
  }
  return s;
}
for (var k = 0; k < 60; k++) {
  assertEq(alias(1, 2), 200 + 30 + 2);
  assertEq(alias(3, 4, 5), 600 + 50 + 3);
  assertEq(loopAlias(10, 0, 3), 30);
}
assertEq(loopAlias(30000, 0, 1), 30000);   // an onramp
assertEq(alias(1.5, "x"), NaN);            // an exit: a double, a string
assertEq(alias(1, "x"), NaN);

// A formal written on one branch only and read after the join: its frame
// slot is dead on the writing path and live on the other (testharness.js's
// `Test.prototype.step`).
function step(fn, o) {
  if (fn.skip) return;
  if (arguments.length === 1) {
    o = this;
  }
  try {
    return fn.apply(o, Array.prototype.slice.call(arguments, 2));
  } catch (e) {
    return String(e) + typeof o;
  } finally {
    step.n = 1;
  }
}
// The same with a formal that has a narrow type on the other path.
function joinInt(a, b) {
  if (arguments.length === 1) {
    b = 3;
  }
  var s = 0;
  for (var i = 0; i < 4; i++) s += b;
  return s + a;
}
function q(x) { return this.q + x; }
function thrower() { throw 1; }
for (var m = 0; m < 60; m++) {
  assertEq(step(q, {q: 1}, 5), 6);
  assertEq(step.call({q: 7}, function () { return this.q; }), 7);
  assertEq(step(thrower, 2), "1number");
  assertEq(step(thrower), "1object");
  assertEq(joinInt(1, 2), 9);
  assertEq(joinInt(1), 13);
}
