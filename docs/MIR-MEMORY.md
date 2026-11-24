# MIR memory optimizations: LICM, alias analysis, escape analysis, SROA

This document extends MIR.md §6 (effects and memory) and §10 (the
optimizations). It covers how MIR names memory, and the passes that
remove, forward, hoist and cache memory operations and allocations. The
code is in `compiler/src/mir/`: `opt.rs`, `mem.rs`, `pea.rs` and
`promote.rs`, over the effect summaries in `ops.rs` and the regions in
`module.rs`.

## 0. Summary

Three properties of the IR make these passes effective:

1. **Memory ops are typed and precise where a type proves them.** A
   field access through a receiver whose type proves the slot is a plain
   load or store of one location, not a terminator (§1.1). Literal and
   constructor allocations are ops of their own that write nothing that
   exists (§4, §6).
2. **Generic fallbacks have precise effects.** The common case of a
   property, element or arithmetic op runs no user code. It is a separate
   op with that promise, and an operand that breaks it exits to baseline
   (§9).
3. **A clean edge protects types, not memory.** A generic op takes its
   `ok_clean` edge when no class word was demoted. But a getter that
   writes a field conformingly demotes nothing, so memory knowledge
   never crosses a generic op, clean or not. Precision about memory has
   to come from the typed and split ops.

## 1. Abstract locations

An access touches a set of abstract locations (`Region`, MIR.md §6),
computed by `effects` from the op and its operand *types*, never from
predictions:

| location | accessed by | notes |
|---|---|---|
| `Field{name, keys}` | `load_slot`, `load_field`, `store_slot`, `store_field`, `init_field`, `lit.init` | per field name and range of layout keys; an unproven receiver has no keys and overlaps every class. `getprop.data` and `setprop.data` use that form |
| `Elements(root)` | `load_elem`, `store_elem`, `elements_ptr` | `root` is the receiver's elements region, if its layout proves one |
| `ArrayLength(root)` | `length.array`; a `store_elem` that may append | an overwriting `store_elem` changes no length |
| `TypedArrayData(kind)`, `TypedArrayLength` | typed-array ops | |
| `Global(binding)` | `load_gname`, `store_gname` | |
| `Env(slot)` | `env.load`, `env.store` | |
| `FrameEnv` | `env.current`, `env.set`, `env.pop` | the frame's own current environment. Only this frame's scope ops write it, so `Unknown` does not cover it |
| `Unknown` | generic ops, calls | every location but `FrameEnv` |

Two accesses may alias only if their locations overlap
(`Region::overlaps`). Beyond that, objects are told apart only by
freshness: an object allocated after a value was defined is not that
value (§3.1), and an allocation that has not escaped is reached only
through values derived from it (§5).

Disambiguation by class (`Field` of one key range against another) is
sound because a receiver's layout claim holds at each access that uses
it (the validator's fence rule), and an object changes its class word
only through ops that write `Unknown` or kill the claim.

**Effects per edge.** An op's writes are stated per successor role
(`mem::writes_on`). On a clean edge (and for a non-terminator) they are
the op's summary. A dirty or err edge reports that the engine ran
something the summary does not cover, so it writes `Unknown`, except
that a `store_field` whose receiver proves the slot only demoted TYPES
on its dirty edge: a type kill, not a memory write. A generic op writes
`Unknown` on every edge.

**Exits and throws** resume baseline, which may read anything. Their
effect summary does not say so, since nothing in MIR follows them. A
pass that removes or delays a store must itself treat each exit as a
reader of every location.

A GC moves objects but changes no value a load returns, so a may-GC op
reads and writes nothing on that account.

### 1.1 Canonical memory ops

- `load_slot name` is `load_field` through a receiver whose type proves
  the layout and SLOTS, with the field at one slot in every layout of
  the claim (`slot_of`). It is not a terminator: it cannot miss, GC,
  throw, run JS or kill anything. It reads its `Field` location and its
  result has the field's claimed type. `opt::canon_loads` rewrites every
  such `load_field` into `load_slot` and a jump to `ok_clean`. This is
  what lets LICM hoist field loads and value numbering merge them.
- `store_slot name` is the same for a `store_field` whose receiver also
  proves TYPES and whose value conforms to the field's claim: nothing
  can demote. `opt::canon_stores` makes them.
- Both drop the retaining `frame.store`s the builder placed before the
  original op for its GC point, since the slot form has none.
- `lit.new`, `new_this` and the other allocation ops may GC but write
  nothing that exists. `lit.init` and `init_field` write the `Field`
  location of the object under construction.

## 2. LICM

`opt::licm` moves a non-terminator op in loop `L` to the end of `L`'s
preheader when:

1. its operands are defined outside `L` (or already hoisted);
2. it writes nothing, cannot GC, throw or run JS, and kills nothing;
3. nothing in `L` writes a location it reads, counting only the edges
   that stay in `L`;
4. it belongs to the preheader's frame: an inlined callee's
   frame-relative ops stay where that frame exists.

Such an op is safe to run where `L` would not have reached it: a
`load_slot`'s receiver type proves the slot exists. A loop whose body
the preheader does not dominate (an onramp into a nested loop, a
generator's resume) is left alone.

Not hoisted: constants, and `box`, `box.double` and `weaken`. They cost
next to nothing in place, mostly feed exits and slow paths, and hoisted
would only lengthen live ranges.

Chains hoist link by link through the fixpoint (§7): a loop-invariant
`this` hoists its layout guard (`hoist_guards`, MIR.md §10.2), then
`this.arr` (`load_slot`), then the array's kind guard, then
`length.array` (if nothing in the loop changes a length), then its
`int.to_i32` guard. `i < this.arr.length` becomes a compare against a
preheader value.

**Managed values** are hoisted too. A hoisted object is live across the
loop, so the lowering may spill and reload it around may-GC ops there.
The reload replaces the load it hoisted, and what hoisting enables past
it (guards, further loads) is the point.

**Read diamonds.** A typed read with a by-name fallback is a guard that
does not exit: `guard.layout` to a `load_slot` or to a `getprop.data`,
rejoining. No single op of it can move, but the whole computes one
invariant value. `opt::hoist_reads` moves a single-entry region like
that to the preheader, with the `box`/`weaken`/`unbox` chain of its
receiver. The region may hold only guards, `getprop.data` and quiet
reads of nothing the loop writes, and no kill in the loop may end what it
proves. Its exits become the loop's entry exit. Failing there when the
loop might not have read the field is sound, since baseline then runs
the loop. Only a region every iteration passes is moved: a read under a
condition (`if (o) s += o.x`) may be one whose receiver fails it on
every entry.

## 3. Alias analysis and forwarding

### 3.1 Memory versions (last writer)

`mem::mem_vn` runs one forward dataflow over the CFG, per location the
function's numbered reads touch:

- **State:** location -> version. A version is a writer instruction, a
  merge (`Phi(block)`), or `Entry`.
- **Transfer:** a write of locations `W` sets every tracked location
  overlapping `W` to the writer, per edge (§1).
- **Meet:** equal versions stay; different ones become the block's
  `Phi`. A block's entry is recomputed from its predecessors' edges each
  time, never merged into its previous entry. A block with one
  predecessor thus keeps that predecessor's versions even when they came
  from a loop header's `Phi`, and reads within one iteration match.
- **Clobber walk:** each store's replaced version is recorded. A load
  through receiver `r` whose version is a slotted store through a fresh
  allocation made after `r` was defined asks for the version before that
  store. The allocations are the `lit.new`, `create_this` and generic
  literal and array ops, closures, arguments objects and rest arrays.

Receivers are compared by `mem::root`: a value up to `unbox`, `box`,
`weaken` and guard outputs.

### 3.2 Loads: value numbering, forwarding

- **Redundant loads:** `load_slot`, `load_field`, `getprop.data`,
  `load_elem`, `length.array` and `length.ta` are keyed by op, operand
  roots and the versions of what they read. A repeat whose first
  occurrence dominates it is replaced by it. The terminators among them
  are numbered by their clean or `ok` output.
- **Store-to-load forwarding:** a `load_slot` or `load_field` whose
  version is a slotted `store_field`, `store_slot` or `init_field`, or a
  `lit.init`, through the same root and name takes the stored value, if
  its type is a subtype of the load's result. §3.4 then cleans up.
- A `Phi` version is not forwarded through: no load-phis are made.

`opt::gvn` separately merges the pure ops and the global, environment
and `load_slot` reads by availability. A may-GC op ends the availability
of managed values there, since keeping one across it would root it,
which is dearer than recomputing.

### 3.3 Dead stores

There is no dead-store elimination. An exit observes every store before
it, and nearly every pair of stores to one location has a guard, hence
an exit, between them. Removing the first store would require sinking a
copy of it onto each exit edge between the two. The same holds for
`frame.store`s of loop-carried locals.

What exists is the special case of objects that do not escape (§5, §10)
and of locations a loop carries (§11), which place their write-backs at
exits, and `opt::sink_to_exits`, which moves a pure value that only
exits use (a `box`, the global object) onto their paths.

### 3.4 Cleanups that forwarding exposes

- `fold_unbox`: `unbox(box x)` and `unbox(weaken(box x))` are `x`.
- `fold_guards` (MIR.md §10.1): a guard on a value whose type proves it
  folds.
- `fold_ints`: a checked int32 op that cannot overflow becomes
  unchecked, and one whose result range is a single value becomes a
  constant.

`let o = {x: 123}; return o.x + 2;` becomes `return 125`: the load
forwards `box 123`, the unbox of the box folds, the guard folds by type,
and the add folds.

## 4. Typed literal allocation

At a literal site the analysis stamps (`lit_stamps_in`):

- `lit.new n` is the allocation: the lowering's inline nursery
  allocation from the site's alloc cell, falling back to
  `night_runtime_new_object`. It is followed by `stamp.fresh`, which
  writes the class word of the site's layout with SLOTS. Nothing can
  have read the old word, and the claims it seeds hold vacuously.
- `lit.init name` is an `InitProp` of that literal: the site's
  add-transition replayed inline, falling back to the helper. The inits
  land at the layout's slots by construction. It writes `Field` of the
  site's key.

Neither is a fence: an allocation changes no existing object, and the
new one is not reachable by anything else yet.

Other literals use the generic `js.rt.newobject` and `js.rt.initprop`,
which write `Unknown`. A property added to a literal after the literal
expression (`var o = {}; o.x = …`) is an ordinary property store, not an
init.

## 5. Escape analysis and scalar replacement

`mem::sroa` removes a `lit.new` object that does not escape.

### 5.1 Allocations

Candidates are `lit.new` allocations whose result has a stamp and at
least one `lit.init`, each field initialized once. Each candidate is
planned on its own against one snapshot per round (CFG, uses), then
every plan that does not collide with another is applied, until no
candidate remains. Planning per round rather than per object keeps
functions with hundreds of literals tractable.

### 5.2 Aliases and the escape check

The object's *aliases* are the values derived from it: guard outputs,
`unbox`, `box`, `weaken`, and block params. A param is an alias only if
every edge into its block passes an alias; an object that meets any
other value, or reaches a root's param, is not replaced.

The uses that do not escape it are its inits and stamp, `load_slot`,
`store_slot` and slotted `store_field` through it, guards that its
allocation proves (its tag, a plain or native kind, its layout without
TYPES), conversions, retaining `frame.store`s, and the operands of
`exit`, `exit.throw` and `exit.inline`. Every other use escapes it:
calls, generic ops, returns, stores of it into anything (including
another literal), identity compares, `gen.suspend`, and `inline.enter`.

The check is **optimistic**: it assumes the object does not escape, so
its guards pass, and uses that only their failures reach do not count.
If none of the rest escapes it, the assumption holds.

Counting `inline.enter` as an escape is what makes `exit.inline`
harmless here. `exit.inline` returns to MIR after running baseline, so
baseline must not get a reference to an object that stays virtual
afterwards. Only an object of the callee's own frame can be an operand
of that frame's `exit.inline`, and what follows belongs to the caller,
past the object's life.

### 5.3 Replacement

- A forward dataflow gives each field its value at each point: not yet
  added, one value, or conflicting values.
- Loads become the field's value; inits, stores, conversions, retaining
  stores and the allocation are deleted; guards become jumps to their
  `ok` edge.
- There are no field params at merges. A field with conflicting values
  where a load or an exit needs it declines the object.

### 5.4 Rematerialization at exits

Each exit that holds the object as an operand rebuilds it first, in
blocks before the exit: `lit.new`, `stamp.fresh`, and `lit.init` of the
fields added so far (which must be a prefix of the layout), one rebuild
for all the operands that held it, so identity is kept. These are
ordinary allocation ops, which the validator accepts; exits have no
recipe operand kind. The err edges of a rebuild's ops (OOM) are
`unreachable`.

Every exit in the object's live range gets its own rebuild, so a
function with many literals and many exits grows accordingly.

## 6. Constructed objects

- **`new_this(callee, proto)`**: an inlined `new F()` of a layout
  constructor that is its own new.target allocates `this` from
  `F.prototype`. The prototype is read first, by name (`getprop.data`,
  whose fail exits before the `new`). `new_this` is an allocation with
  ok and err edges, not a fence: the generic `create_this`, used
  elsewhere, reads `.prototype` generically and writes `Unknown`. The
  site's construct cell serves it inline when `proto` is the cell's
  prototype, else `night_runtime_new_this`.
- **`new_this.init`** also adds the first fields, where the constructor
  starts by storing formals into them in layout order: the object as
  that many `init_field`s would leave it. It fails, before anything
  observable, where an add would not be plain (a setter or read-only
  property of the name on the prototype chain).
- **Forwarding wrapper constructors** (`this.initialize.apply(this,
  arguments)`, the target resolved per inlined copy): another target, or
  an `.apply` that is not the builtin, exits instead of forwarding
  generically, so no generic op sees the object under construction.

`sroa` and `pea` do not handle constructed objects, only `lit.new`.

## 7. Pass order

`opt::optimize` runs the passes to a fixpoint, after a first pass of
integer narrowing. Each round:

1. `canon_loads`, `canon_stores`: guards folded in the previous round
   prove more receivers;
2. `forward_params`: a loop's invariants reach its body through params
   until forwarded;
3. integer demand narrowing, `fold_guards`, `mem_vn`, `sroa`,
   `fold_unbox`, `fold_ints`, `gvn`, `licm`, `hoist_guards`,
   `hoist_reads`;
4. `forward_params`, `thread_jumps`.

When a round changes nothing, `pea` (§10) runs once, then the fixpoint
again, then `promote` (§11) once, and the fixpoint again. Each of the
two runs once because neither may take its own output as input: `pea`
would virtualize its own materializations, and `promote` would count its
own write-backs and reloads as accesses. `sink_to_exits` runs last.

## 8. Rules for passes

- **No substitution may extend a killable type past a fence.** A value
  whose type has killable components (a layout claim) may not replace a
  later one: a fence in between may have ended the claim, and boxing is
  how the builder drops it across one. `gvn`, `fold_unbox` and
  `mem_vn`'s value numbering all test `killable_components`.
- **A pass cannot add an exit at an arbitrary point**, since it has no
  frame state there. The exception is a loop's preheader, for which the
  loop declaration keeps the entry state (`LoopDecl`'s `entry`). Every
  other op a pass inserts must be infallible, or have failure edges that
  are provably `unreachable`.
- **Loops entered past their preheader** (an onramp root into a nested
  loop, a generator's resume) have no place to hoist to; every loop pass
  checks that the preheader dominates the body.
- **Invalid MIR is a silent decline.** The validator runs after
  `optimize`, and a function that fails it falls back to baseline with a
  `BUG: invalid MIR` reason. Tests still pass, so check
  `--strict-coverage` (which treats it as an error) or
  `--dump-tiers`.

## 9. Generic fallbacks with precise effects

A generic op's summary is `Unknown`, because on operands nothing proved
it may run code. Split, the common case is an op of its own that runs no
code, with precise effects. A case that would run code takes a `fail`
edge, an exit before the op, for baseline to do it; a case that demoted
a claim takes the dirty edge, an exit after it. This follows MIR's rule
that its facts are fixed and an event that would end them leaves for
baseline: running user code is baseline's.

| op | does | `fail` | effects (clean edge) |
|---|---|---|---|
| `getprop.data` | own or prototype data property, absence, pure builtin lengths | getter, proxy, resolve hook, null/undefined | reads `Field{name}` of any class, `Global` of that name, for `length`/`byteLength` the array and typed-array lengths |
| `setprop.data` | overwrite of a writable data property, add with nothing on the chain, writable array length | setter, read-only, non-extensible, the global, an object Watchtower watches | writes `Field{name}` of any class; for `length`, lengths and elements |
| `getelem.data` | elements (dense, typed arrays, arguments, string chars), names by primitive keys, absence | getter, proxy, resolve hook, object key, null/undefined | reads anything, writes nothing |
| `setelem.data` | with an int32 key: element overwrite, append, sparse add, a number to a typed array | setter or read-only element, frozen, non-extensible, arguments, a value needing conversion | writes elements, array lengths, typed-array data |
| `prim.*` | arithmetic and compares on primitives, and on objects whose conversion is Object.prototype's own (a pure runtime check) | an object with its own conversion | none (may GC) |
| `js.box_this` | the global `this`, or a primitive's wrapper | (none) | an allocation |

- **Getter names.** Which names may reach a getter is static
  (`getter_names`): the modeled accessors, literal and class accessors,
  the name passed at every `defineProperty`-shaped call, and the
  builtins' accessors. A property site of such a name keeps the generic
  op, where an exit could be frequent. A missing name is not unsound,
  only an exit.
- **The set ops need a dirty exit** (a point after the op to exit to);
  where a site has none, or an element key is not known to be int32, the
  generic op is used.
- **Dense elements.** An out-of-bounds or hole access at a dense element
  site exits, so no generic op rejoins and memory knowledge survives
  it. Stores first try the runtime's no-JS append
  (`night_runtime_elem_grow`), so growth does not exit. This is only
  where no typed array can reach the site: if the program references a
  typed-array constructor (`elem_poly_sites`), the analysis may have
  taken a typed array for an array, which would miss on every execution,
  so a miss rejoins through the data op instead.

**Runtime side.** The helpers (`night_runtime_get_prop_pure`,
`night_runtime_set_prop_pure`, `night_runtime_get_elem_pure`,
`night_runtime_set_elem_pure`, `night_runtime_to_primitive_pure`) use
pure lookups (`GetPropertyPure`, `LookupPropertyPure`). Stores use the
engine's own set behind those checks, comparing the object's class word
before and after for a demotion of TYPES, SLOTS, the closed claim or the
class. RANGES, which no MIR claim reads, may drop as on every engine
store.

Two rules for such a helper:
- **It must accept every case a program commonly hits.** A refusal is an
  exit, and a common one is an exit at every execution. Examples that
  must not be refused: arrays' `addProperty` hook (the engine's own
  length bookkeeping), an index past a string's end (which reaches
  `String.prototype`'s resolve hook), and `==` on plain objects. Exit
  storms are visible in `--mir-exit-census`; tests pass regardless.
- **It must keep every fast path of the generic helper it replaces,**
  including the IC's populate paths and cached replays. Otherwise the
  site's inline caches stop being filled.

## 10. Materialize once, then cache: partial escape

An object rebuilt at an escape is real from then on. Baseline or a
callee may carry the reference anywhere, identity is observable
(`===`), and every later escape must hand over the same reference. So an
escape from which MIR continues (a call, an `exit.inline`) cannot
rebuild an object that MIR then goes on treating as virtual. It can be
virtual up to its first escape, and after that memory can be cached
where the effect summaries allow. `pea` does the first and `promote`
(§11) the second.

**`pea` (`mir/pea.rs`)** handles a `lit.new` object that `sroa` cannot
replace because it escapes somewhere. The escapes are as in §5.2,
except that `exit.inline` is one, and `inline.enter` is not (it is a
frame slot, which the callee's exits overwrite).

- The object is virtual until, on each path, its first escape. In the
  virtual part loads are the values last stored, guards pass, and exits
  that do not return rebuild the object as `sroa`'s do.
- At the first escape it is materialized: `lit.new`, `stamp.fresh`,
  `lit.init` of the fields' current values. Then
  `guard.unbox.obj`/`guard.kind`/`guard.layout`, with `unreachable` fail
  edges, give a typed view. They are asserts: the object was just made
  with that layout.
- From there every block of the real part carries the value and the view
  as params. A virtual edge into a real block materializes on the edge.
- The view stays typed until an op or a fence edge kills a component of
  it: the call the object escaped into may reshape it. Before that op a
  `weaken` gives the view no kill can touch, and a real block that any
  such path reaches carries that instead.

It declines an object
- whose fields differ by path where a value is needed (no field params);
- that escapes before every field is added;
- that meets another value at a param;
- with nothing to gain, as when it escapes right after its inits.

Materialization is at the first escape on a path, so an object whose
escape is *inside* a loop it is virtual in is materialized on the loop's
entry edge. Delaying that would need a maybe-null reference carried as a
param, and a check, which needs frame states the IR does not keep. `pea`
examines at most 64 allocations per function, since each attempt scans
the whole function.

## 11. Loop-carried caching

**`promote` (`mir/promote.rs`)** caches a location in SSA across a loop.
The locations are env slots (through an environment object from before
the loop) and fields (through an object from before the loop, with a
receiver from before it that proves the slot and TYPES, whose claim
nothing in the loop kills). The loop must both read and write the
location.

- The preheader loads the value, and every block of the loop carries it
  as a param; `forward_params` prunes the params whose incoming values
  agree. Reads are the carried value; writes replace it.
- A dirty value is written back before any op that may read or write the
  location, by its effects, including every exit, and on edges leaving
  the loop.
- The value is reloaded after any op that may write the location, and on
  the edges of terminators that write it.
- An access through a differently typed view of the object stays a
  memory op, with a write-back before it and a reload after.
- Cost rule: those barriers, not counting exits, must be fewer than the
  accesses they replace.

The loop may be entered only through its preheader: an onramp into its
body would have no cached value.

Stores that cannot become `store_slot` (polymorphic receivers, a
receiver without TYPES) are not promoted, so most of what it caches is
env slots.
