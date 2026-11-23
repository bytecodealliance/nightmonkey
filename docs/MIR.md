# NightMonkey MIR

MIR is NightMonkey's optimizing tier and the default pipeline
(`--pipeline mir`; `--pipeline baseline` is the alternative). The IR,
validator, printer/parser and optimizer are in `compiler/src/mir/`. The
builder (JSOps to MIR), inliner and lowering (MIR to waffle) are in
`compiler/src/wasm/mir/`.

Two companion documents:
- `docs/BASELINE.md`: the baseline tier, its frame format, and its side
  of exits and onramps.
- `docs/MIR-MEMORY.md`: memory optimization (LICM of reads, forwarding,
  scalar replacement, partial escape, loop-carried caching) and the data
  ops it rests on.

"Likelier" is the static analysis whose predictions (`LikelyFacts`)
MIR is built from. A prediction is never a proof: what MIR relies on is
established by a guard, or by a claim the runtime maintains.

## 0. Summary

- **MIR holds only optimized code.** The baseline tier is the deopt
  destination and the source of onramps back into MIR. Baseline keeps
  the whole JS frame in NightStack memory, and that frame format is the
  whole interface between the tiers. MIR and baseline are separate Wasm
  functions.
- **The IR is SSA over a CFG with typed blockparams.** Locals, args,
  `this` and the JS operand stack are SSA values. MIR code touches the
  NightStack only to root GC things, to lay out calls, and for the few
  slots kept current in the frame (§5.1).
- **Invariants are structural.**
  - Per-object facts live in the type of the object reference.
  - Global facts (fuses and the like) are *ghost values*: checking ops
    produce them, and the ops that rely on them consume them.
  - *Fences* say which types may not be live across them. *Weakening*
    is how code complies.
  - A validator checks all of this. There is no implicit flow typing.
  - Every kill is either predicted by the analysis or dynamic (a dirty
    edge), and the validator checks that too (§4.5).
  - The builder guards killable facts locally at each use. Guard folding
    and hoisting (§10) merge the guards afterwards.
- **A type is (representation × refinement).** "NaN-boxed, known int32"
  and "raw i32" are different types. Unboxing the former is infallible;
  unboxing an arbitrary Value is a fallible guard.
- **A fallible op is a terminator.** Its failure edge usually exits to
  baseline, but may run a slow path and merge back.
- **An exit carries the whole frame state.** An onramp reads the frame
  as `Val(⊤)` values and guards its way back to typed code.
- **MIR is the sole input to the backend.** Everything a lowering needs
  is in the op, its attachment, or a module table.
- **Accesses carry alias regions**, which supports classical load/store
  optimization without a functional memory model.
- **Lowering handles GC rooting.** It does not appear in MIR.
- **MIR has no reducibility invariant.** An onramp into a nested loop
  side-enters the loops around it. MIR declares its loops, and waffle's
  backend makes the lowered function reducible (§5.4).

## 1. IR structure

MIR is a separate IR from waffle's Wasm-level ops; it is lowered *into*
waffle.

- **Module tables** (`mir/module.rs`), referenced by id: atoms, layouts,
  snapshot objects, fuses, global bindings, natives, alias regions. A
  layout lists its fields in slot order, each with its claim. A slot the
  module does not describe is a `hole`, and a typed field with no slot
  prediction is listed by name only (`named`).
- **A `Func`** (`mir/func.rs`) holds blocks, values and instructions in
  entity arenas, plus roots, declared loops, the frame shape, and the
  frames of inlined callees. `inst_frame` says which frame each
  instruction runs in.
- **Blocks** have typed params, and a block's last instruction is its
  only terminator. A terminator's outputs are not instruction results: a
  successor edge passes each, per target param, as `EdgeArg::Out`. So an
  output exists only where the op succeeded, and weakening on an edge is
  a param of a weaker type.
- **Attachments** hold what the lowering needs that is neither an
  operand nor derivable from operand types: IC and call cells, a store's
  per-class field types, candidate call targets, the originating `Site`.
  Nothing after the builder reads `LikelyFacts`.
- **The text format** (`mir/print.rs`, `mir/parse.rs`) is used for pass
  and validator tests (`compiler/src/mir/tests/`). `--dump-mir` prints each
  built body.
- **The validator** (`mir/verify.rs`) runs after optimization. A script
  whose MIR fails it is compiled by baseline alone, with the reason
  `BUG: invalid MIR` in `--dump-tiers`. Such a decline fails no test:
  `.claude/skills/nm-bench/declines.sh` counts them. It checks:
  1. structure: one terminator per block, edge arity, roots, and every
     natural loop declared;
  2. dominance, over every root at once (a virtual super-root);
  3. subtyping on edges;
  4. operand types, and that a declared result type is a supertype of
     the op's rule;
  5. fences (§4.1);
  6. that every static kill is predicted (§4.5);
  7. that no raw pointer crosses a may-GC op (§4.4);
  8. the boundary: exits and onramp roots carry exactly the script's
     frame, and each loop has one preheader (§5).

## 2. Type lattice

### 2.1 Types

```
Type := Val(VSet)          boxed JS::Value, wasm i64
      | I32(IRange)        raw i32: JS number, int32-valued, never -0
      | Int(IRange)        raw i64: JS number, integral, |x| <= 2^53, never -0
      | F64(NumInfo)       raw f64: any JS number
      | Bool               raw i32 0/1
      | Obj(ObjInfo)       managed ref to JSObject
      | Str(StrInfo)       managed ref to JSString
      | Raw(RawKind)       interior pointer; not live across a may-GC op
      | W32 | W64          machine words; not JS values
      | Fact(FactKind)     ghost value: no runtime representation (§3)
```

```
VSet        := { tags: TagSet, num: NumInfo, obj: ObjInfo, str: StrInfo }
TagSet      ⊆ { undefined, null, boolean, int32, double, string,
                symbol, bigint, object, magic }
ObjInfo     := { kind: ObjKind, singleton: Option<SnapObj>,
                 layout: Option<LayoutClaim> }
ObjKind     := Any > Native > { Plain, Array, Function(Option<ScriptId>),
                                TypedArray(TaKind), Arguments, Env }
LayoutClaim := { keys: [lo,hi], types, slots, closed: bool,
                 state: Published | Prefix(S) | Constructing(S) }
```

- **`int32` and `double` in `TagSet` are tags.** An integral double can
  be double-tagged. "Is a number" is `{int32, double}`.
- **`magic`** covers the engine's magic values (the TDZ sentinel,
  element holes). They are not JS-visible, but a frame slot can hold
  one, so `Val(⊤)` includes it. Nothing unboxes a magic value;
  `guard.tags` can remove it.
- **Element holes are not in element types.** A dense element load
  fails on a hole.
- **Invariant components** hold for the value's lifetime: tags, numeric
  info, `kind` (a JSClass never changes), `singleton`, a function's
  script, atom identity. **Killable components** are heap-dependent:
  `layout` and `Fact` values. Fences kill only these.

### 2.2 Subtyping and conversions

- **Subtyping** is within one representation only, and pointwise.
  Passing an arg to a blockparam of a supertype weakens it implicitly.
- **Conversions are explicit:** `box` (and `box.double`, which keeps the
  double tag), infallible `unbox.*` where the type proves the tag,
  widening (`i32.to_int`, `i32.to_f64`, `int.to_f64`), and fallible
  `guard.unbox.*`.
- A declared result type may be any supertype of the op's rule.
  `weaken` is the op whose only purpose is that.

### 2.3 Constructors

An object under construction carries the CONSTRUCTING sentinel in its
class word instead of an identity (§4.3), with the *early key* of the
layout being built. Its type is `Obj{K constructing(S)}`, where `S`
(`FieldSet`) is the set of K's fields added so far, in whatever order.
`prefix(S)` claims at least those fields.

- `Constructing(S) ≤ Prefix(T)` and `Published ≤ Prefix(T)` where the
  former's fields include `T`. Two different states join to the prefix
  of their intersection. A constructing type is **not** a subtype of the
  published one: a stamp guard would fail on it.
- The class word records the set's first 16 positions
  (`FieldSet::WORD_BITS`). A field past them is added only after all
  before it (`FieldSet::may_add`).
- The word's set may under-report (the generic add arm does not update
  it), which is safe: `guard.ctor` then fails and exits. Over-reporting
  would not be safe.

**Ops.**
- `guard.ctor K, S` establishes the state: the sentinel, the early key,
  SLOTS (and TYPES), the set `S`, and a slot span of exactly `S`'s. Every
  field is at its row's slot, so any other property would raise the
  span. The state is therefore exact.
- `init_field` adds a field not yet there, of a value guarded to the
  field's claim. It replays the site's add-transition row inline. An
  add ahead of other fields first stores undefined in the skipped slots,
  since the GC traces the span. The slow path
  (`night_runtime_init_field`) does a plain add that runs no JS, and the
  op fails (exits) unless the object ends in exactly the next state.
- A field already added is a typed `load_field`/`store_field`.
- `publish_layout`, once every field is there, stamps K. The claim is
  exact, so it also sets CLOSED where the layout allows (§4.3). It kills
  constructing claims, with a witness.
- `ctor.stamp` at a constructor's return does the same dynamically, for
  a `this` the builder did not track: a no-op unless `this` is still
  under construction for that layout and complete. `ctor.publish` does
  it before a call made during construction (`ctor_publish`), so that a
  method called on `this` finds a published object.

**Where a constructing `this` comes from.**
- *Inlined `new`.* `new_this` allocates from the constructor's
  `prototype`, running no code (`create_this` where that is not
  possible). `guard.ctor K, 0` restates what the allocation wrote; its
  failure is unreachable. The callee is built for that `this`
  (`callee_ctx`), with no entry guard.
- *With leading fields.* Where the constructor's bytecode starts with
  `this.f = <formal>` stores of its row's first fields
  (`ctor_formal_prefix`), `new_this.init` makes the object with those
  fields from the construct's arguments, and the body skips the stores
  (`prefill_pcs`). Nothing between those stores can observe `this`. The
  construct cell holds the final shape and the shapes of the prototype
  chain (at most two objects), which prove that the adds are plain. A
  miss goes to `night_runtime_new_this_init`; a non-plain add fails the
  op before the `new`.
- *Standalone.* A constructor compiled on its own guards its `this` to
  `constructing(0)` at its first add, which exits for a call without
  `new`.
- *Methods and wrappers.* A method called on a constructing `this`
  (directly, or by `.call`/`.apply`) is spliced built for that state. The
  caller keeps a boxed copy, hinted with the state the callee leaves
  `this` in (`this_out`, `ctor_hint`), and guards that state back at its
  next use. A wrapper constructor's forward exits where the target is
  not the resolved one (`CTOR_FWD_EXITS`).

A builder run's only constructing object is its own `this`. A fence
demotes it to a boxed, hinted object; a published-layout hint would be
wrong.

## 3. Global facts (ghost values)

`Fact(kind)` values have no runtime representation. Checking ops produce
them, ops that rely on them take them as operands, and the lowering
drops them. Since they are values, CSE and dominance come for free, and
fences kill them like any other type.

- `Fuse(id)`: from `check.fuse`. A global the runtime has fused (a
  primitive literal) becomes a constant.
- `Binding(id)`: from `check.binding` or `check.binding.write`. The
  binding's slot is resolved against the global's live shape (or its
  value fuse is armed), and for a write it is writable. `load_gname` and
  `store_gname` consume it. An unresolvable binding exits: once a
  syntactic global is resolved, the check holds. A read whose value fuse
  is armed takes the value from the fuse's cell.
- `BindingFn(id)`, a subtype of `Binding(id)`: from `check.binding.fn`.
  The binding holds a compiled function of the script the analysis
  predicts (`gname_fns`), so `load_gname` through it is that function,
  typed, and a call of it needs no callee guard.
- `NativeIntact(id)`: from `check.native`. A value is the pristine
  native; it backs the typed `Math` calls.

**Predicted functions.** `gname_fns` names a global whose every write
the analysis sees holds one scripted function. There is no code
invalidation, so each read tests a fuse: the binding's value-fuse word
has a state for "holds a compiled function of the predicted script"
(`NightIsCompiledFunctionOf`). A write of anything else leaves that
state. A major GC refreshes armed cells in place (`RefreshBindingCells`),
so a cell tested before a GC still holds the value after it. A call
kills binding facts: whether the callee writes the global is only a
prediction. `store_gname` kills fuse facts, and binding facts where the
binding has a predicted function.

A check's result is not reused for a later check across any op that may
run JS, clean edge or not: a fuse can blow, or the global's shape
change, without moving the stamp epoch.

## 4. Invalidation, weakening, and GC

### 4.1 Fences

- **Each op has a kill pattern** (`KillPattern`), computed from its
  opcode and operand types, over: layout claims as a whole, only their
  TYPES, CLOSED or constructing state, and each kind of fact. A pattern
  may be limited to claims overlapping a key range.
- **The rule:** no value whose type matches the pattern may be live
  across the fence.
- **Where it applies** (`KillSite`):
  - a single-successor op is a fence at the op;
  - a terminator with an `ok_dirty` edge kills on that edge only;
  - another terminator kills on its `ok` edge;
  - a terminator's `err` edge is a fence edge too, except into a *throw
    block*: one with no params, only upcasts and constants, ending in a
    throw exit. Nothing in it relies on a killable component, so it may
    use pre-op values.

### 4.2 Weakening and the clean/dirty rejoin

- Before a fence op, `weaken v : T → T'` makes a new SSA value for use
  after it. On a fence edge, a param of the weaker type does the same.
- A generic op or call that can report its effect is a terminator with
  `ok_clean`, `ok_dirty` and `err` edges:
  - `ok_clean` is not a fence edge: every claim survives.
  - `ok_dirty` is a fence edge with the op's kill pattern.
  - `err` goes to a throw exit (§5.3).
- **The report is the stamp epoch**, which every demotion of a class
  word bumps. The lowering compares it before and after the helper or
  call; unmoved means no claim on an existing object was invalidated.
- **The builder's use** (`js_keep`, `dirty_exit`). Where the state at
  the next pc is this op's result on the current frame, `ok_dirty` exits
  there with the result, so the clean path keeps its facts unguarded.
  Where it is not, or there is nothing to keep, the op fences: the
  frame's `Obj` slots weaken to hints (`ObjHint`) and the next typed use
  guards again.
- The IR also supports re-guarding on `ok_dirty` and rejoining
  (`compiler/src/mir/tests/fence_rejoin.mir`).
- **Diamonds.** A typed access whose other arm is a generic op demotes,
  before the split, whatever that arm's fence would demote
  (`demote_for_generic_arm`). A fence on one arm alone would rename slots
  that uses after the join need.

### 4.3 Layout claims, stamp bits, and ICs

Every object has a 32-bit class word (`runtime/NightObjectWord.h`): the
identity (layout key + 1) in the low half, and validity bits above it.

| Component | Meaning | When it fails at a guard |
|---|---|---|
| identity (`keys`) | object has a layout in the range | exit, or the site's IC arm |
| `TYPES` | K's fields hold their claimed types (§4.6) | as identity |
| `SLOTS` | K's fields sit in their row's fixed slots | as identity, if guarded |
| `CLOSED` | no own property outside K's row | the method read's IC arm |
| `RANGES` | numeric ranges; no MIR claim rests on it | (stores drop it) |

While the sentinel bit is set, the low half is the set of fields added
(§2.3) and bits 18–29 are the early key. `guard.layout` masks the
sentinel in, because a set may equal an identity.

- **`guard.layout keys {types slots closed}`** is one masked compare of
  the word.
- **Where a failure goes.** A method's `this` is guarded once at entry
  and exits. A typed site reads through its IC on a miss, unless the
  receiver was already proven (`ObjHint`), in which case it exits.
- **Loads feed the claimed type out.** With `types`, `load_field` yields
  the field's claim; without it, any `Val`, guarded at its definition.
- **Stores expect the claimed type in.** `store_field` with `types`
  requires a conforming value, so it never clears TYPES and is not a
  fence for it.
- **SLOTS is optional in a claim.** If the type proves the slot,
  `load_field` becomes `load_slot` and `store_field` becomes
  `store_slot`: plain accesses with no other edge. Otherwise the op tests
  SLOTS itself and falls back to the IC. The IC arm reports dirty, and
  the access exits at the next pc with its result (`DIRTY_EXITS`).
- **TYPES is shallow.** It constrains what the parent's field holds and
  says nothing about a child object's own claims (§4.6). A child's
  layout is guarded at its first use.
- **Compiled stores never clear identity.** Only structural changes
  (dictionary mode, property change or removal, freeze, swap, object
  flags) do, and those happen in fences.
- **Unpredicted sites** use the data ops (`getprop.data` and others; see
  `docs/MIR-MEMORY.md`) where no known accessor has the name, else
  `js.getprop`/`js.setprop`. Both use inline-cache ladders.
- An unpredicted accessor site probes the accessor cache
  (`accessor.probe`) and calls, or inlines, the accessor.

**Rows and slot placement.** A layout's row lists its fields by slot.
The row of a constructor starts with the rows of its `.call`/`.apply`
delegates (its superclass constructors), wherever the calls sit
(`SUPER_FIRST`), so that subclasses share the base's fields at the same
slots and one range guard covers them all. Its own writes and init
delegates (`this.m(...)`) follow in order.

Construction order need not match the row. The engine hook
`shapeForAdd` (`docs/INTEGRATION.md`) lets the runtime choose the slot
of a new property, and `NightShapeForAdd` places a plain data property
in its row slot if that is a fixed slot and SLOTS still holds. For a
name the row lacks, the position comes from the rows that extend it,
where they agree. The resulting shape is *permuted*: slots may be holes
holding undefined. The visible property order is unchanged.
Consequences:
- A slot span covering the row does not prove every field is present.
  Every stamp gate counts properties on a permuted shape
  (`night_runtime_slots_covered`).
- Compiled add arms replay a permuted transition only where it skips no
  slot, except `init_field`, which fills the skipped slots.
- An add that deviates from the prediction clears SLOTS
  (`NightAddPropCheck`).

An object literal of a predicted layout is allocated with a fixed slot
per row field (`lit_nslots_in`): a field in a dynamic slot would clear
SLOTS on every allocation.

**Restamps.** A `restamp` at the return of an init delegate or fill
script advances an object from a prefix layout to its full one. Slots
stay put, so facts about the prefix stay true.

**CLOSED and predicted methods.** A predicted method read
(`method_sites`) is one whose receivers' rows all lack the name and
whose value is exactly one scripted function.
- CLOSED is set where an object holds exactly its row (`publish_layout`,
  and the stamp gates where SLOTS holds and the span is the row's
  length), and only for `closed_layouts`: layouts whose class the
  analysis never sees hold another property. Objects that grow by
  design would each clear the bit and bump the epoch.
- Any add to a CLOSED object clears it and bumps the epoch, since all
  its row is already there. SLOTS's clear takes CLOSED with it, so CLOSED
  implies SLOTS.
- `method.load` tests CLOSED and that the receiver's prototype is the
  one its method cell is armed for, and yields the function, typed
  `Function(script)`. On a miss, the runtime may arm the cell
  (`night_runtime_method_arm`); failing that, the read goes through the
  IC and guards the script, exiting after the read. Both arms join typed,
  so the call needs no callee guard.
- Arming finds the holder of a tenured compiled function on a chain of
  native, tenured, resolve-free prototypes, and marks the property
  constant through the holder's `ObjectFuse`. The engine hook
  `objectFuseInvalidated` unarms the cells when the property is written,
  deleted or redefined, when the name is added to a prototype below the
  holder, or when a prototype on the chain changes. A major GC zeroes
  every cell.
- Where the method's own `this` claim covers the site's layouts, the
  receiver is guarded to that claim first, exiting before the read. The
  inlined method is then built for a typed `this` with no guard of its
  own (`ThisObj`).

### 4.4 GC

- **GC is below MIR's abstraction level.** `Obj`, `Str` and `Val` are
  managed and may be live across anything.
- **`Raw` values may not be live across a may-GC op** (validated).
- **Rooting happens during lowering**, only at may-GC ops and only for
  what is live across them:
  - Each managed value that may be live across a may-GC op gets a home
    slot in the rooting area. Values never live at once share a slot: in
    SSA two values interfere iff one is live at the other's definition,
    so greedy coloring in dominance order is exact.
  - The lowering tracks where each managed value is: in a register (a
    waffle value), in its slot, or both. Before a may-GC op, each live
    value not yet in its slot is stored, boxed. An SSA value never
    changes and the GC updates the slot in place, so it stays stored.
  - After the op, register copies are dropped and reloaded at the next
    use.
  - At a block entry, locations are decided from the edges already
    lowered. A value that may cross a may-GC op before a back edge
    enters only in its slot, so a loop stores it once. Where a loop can
    GC only off its expected path (`gc_only_off_path`), values stay in
    registers and the exceptional edge reloads them. This is only a
    placement choice.
- **A GC scan covers the slots up to the highest one in use** (at least
  what the enclosing cycle needs). Every scanned slot must hold a valid
  Value, so a slot that may hold stale bits is cleared before the first
  scan that covers it on each path. A loop that may GC has its slots
  cleared on its entry edges.
- **Retention.** A slot that holds a dead value is not cleared, so the
  value may outlive its last use within the activation. Conversely,
  baseline keeps a local's value alive until the local is overwritten.
  MIR matches this with *retaining stores*: the builder puts
  `frame.store`s of the managed locals before each may-GC op
  (`retain_locals`), and the lowering emits one only where the op can GC
  and the frame does not hold the value already.
- **Limitation.** Retention is not exact across an exit at a pc where
  the local is dead: the exit leaves the frame slot as the last
  retaining store left it. Exact retention would need dead home slots
  cleared.

### 4.5 Fences versus predictions

**The invariant.** At each bytecode boundary, MIR's state is at least as
strong as the prediction in the components that define the tier: tags,
object-ness, typed-array kind, and class at loop headers. Tags and kinds
are invariant, so only killable components can go dead. Two things can
weaken them:

1. **A predicted kill, then a local re-guard.** The prediction also says
   the component may be invalidated. It is dead until the next use,
   whose guard (§8) re-establishes it or exits.
2. **Forbidden: a kill that contradicts the prediction.** MIR would then
   run weakened for a scenario the prediction excludes.

**Rule: every kill is either predicted or dynamic.** A static kill needs
a **prediction witness** that covers it. Otherwise the op must report
dynamically, putting the kill on `ok_dirty`. When reality contradicts the
prediction, code leaves MIR; it does not absorb the contradiction as a
silent weakening.

A witness is a validator-only side table of what each op may invalidate.
The validator checks every static kill against it, so passes that add
fences are checked too. Lowering and optimization never read witnesses.

### 4.6 Field type claims: what `TYPES` can guarantee

**The claim.** Each field of a layout carries its full predicted tag set
(`layout_field_types_in`): every primitive class plus object-ness, or no
claim where an unknown value may flow in. Under a set TYPES bit on a
valid stamp, a load's result has that type with no check.

**Why a child's layout is not in the claim.** A child's identity is
wiped by structural changes to the child, which never touch the parent.
Keeping the parent's claim sound would need child-to-parent backlinks.
Only a child's immutable components (kind, script, singleton) could be
claimed. *Limitation:* they are not; a loaded object is an `Obj` of no
known kind until a guard, and a function-valued field's script comes
from a guard or from `method.load`.

**Maintenance.** TYPES stays set only if every writer conforms:
- **Engine stores** clear TYPES and RANGES on every store
  (`kStoreClearMask`). The engine does not know which field it writes.
  SLOTS is untouched: a value store moves no slot.
- **Compiled stores to a known field** carry each expected class's
  claim (`field_types`) and keep TYPES iff the value conforms, by its
  type or its tag. A nonconforming value on a published object goes to
  the engine, which clears the bit and bumps the epoch, so the op
  reports dirty. On an object under construction the bit is cleared
  inline: no guard can have passed on it. A store with no known field
  drops TYPES.
- **Helper stores** keep TYPES where the value conforms: the compiled
  store vouches for it (MIR by `field_types`, baseline by
  `field_classes`), or the helper checks the claim (`NightStoreConforms`).
  A vouched store keeps the bit only where it runs no JS (`PlainStore`
  and the replays).
- **Element stores** owe the array stamp's claims only on arrays. Array
  keys are the top of the key space (`array_key_min`).
- **Stamps.** Allocations seed TYPES, and stamps and restamps keep it,
  for any layout with a typed field (`layout_types_bit`, shared by the
  MIR and baseline tiers, so an object built in either carries the same
  bit). A snapshot object is stamped with a row of its constructor that
  it matches exactly, with TYPES iff every field conforms.

A demotion is permanent until a restamp, so an object written once by a
nonconforming path fails its `types` guards from then on.

## 5. The MIR/baseline boundary: exits, onramps, throws

State at a pc is the baseline frame plus the static operand depth
(`docs/BASELINE.md`). The MIR body is the script's table entry; the
baseline body is a second function.

**Boundary rule.** A value crossing from MIR is any boxable
representation, boxed on the way out. A value crossing into MIR is
`Val(⊤)`, and knowledge of it is re-established by ordinary MIR guards.

### 5.1 Exits

```
exit pc, this, [args…], [locals…], rval, [stack…]
```

- **The arity is fixed by the script:** all formals, all locals, the
  rval, and the operand depth at `pc`.
- **The frame is not written through.** Formals, locals and the rval
  stay in their own representations, and an exit writes every slot live
  at its pc. Dead slots are `const.val dead` and stay as the frame has
  them. Exceptions, kept current in the frame:
  - formals that a mapped `arguments` aliases (`write_through`);
  - the env slot;
  - retaining stores (§4.4), which are not complete.
- **The env slot is not an operand.** The entry writes it: the callee's
  environment, or the one `env_setup` makes. A scope's entry stores the
  new environment (`env.set`) and its exit restores the parent
  (`env.pop`), so baseline finds the current one after any exit or
  throw.
- **Resume rule:** an exit to an op's own pc is allowed only if no
  observable part of the op has happened. Otherwise it targets the next
  pc, with the op's result on the stack.
- **One exit hub per frame shape**, where the shape is each operand's
  representation, dead ones omitted. An exit branches to its hub with
  the resume word and raw operands; the hub boxes them once. Exit code
  grows with distinct shapes, not with exits.
- **The hub** writes every live operand, new.target, the resume word
  (pc, and mode continue or throw) and the onramp backoff. If the
  activation entered MIR at the function entry, it calls the baseline
  body with `ARGC_RESUME_BIT` and returns its result. If it entered by an
  onramp, it returns `ERR_DEOPT` to its baseline caller, which resumes
  itself. A JS frame therefore never uses more than three native frames.
- **Stack overlap.** MIR's rooting slots and callee frames lie above
  baseline's fixed frame and locals, overlapping its operand slots. MIR
  never reads those while it runs: an onramp reads them before anything
  is spilled, and an exit writes every one below its depth.
- **Liveness pruning.** Backward liveness over the bytecode decides
  which of `this`, formals, locals and rval are dead; a dead slot has no
  block param. Consequently a dead local does not keep its object alive
  in MIR (`tests/jit-test-excludes-mir.txt` lists the tests that depend
  on it).
- Exits need no parent-frame chain (§5.5) and no virtual-object recipes:
  a replaced object is rebuilt on the exit edge with ordinary allocation
  ops.

### 5.2 Onramps and loop preheaders

- **Onramp roots exist only at loop headers** (and function entry, and
  generator resumes). Elsewhere, code rejoins within MIR.
- **MIR declares its loops**: header and preheader, from the bytecode
  loops. A loop's body is every block that reaches a latch without
  passing through the header, which is well-defined even where the CFG
  is irreducible. The validator requires that the preheader `P` jumps
  only to the header and is its only predecessor from outside.
- **`P`'s params** are the frame state at the header pc, typed with the
  state there, class claims included. It is not weakened to ease
  reentry. LICM hoists to `P`.
- **An onramp root `O`** is another root of the CFG. Its params are the
  frame state, all `Val(⊤)`. It guards each up to `P`'s param type and
  jumps to `P`; a failing guard exits at the header with `O`'s own
  params.
- **Which headers get one.** Every outermost loop, whose root costs no
  duplication. An inner loop's root side-enters the loops around it, so
  it gets one only if its outermost enclosing loop spans at most
  `--mir-inner-onramp-bytes` bytecode bytes (default 400) and the
  function has no inlined callees: duplicating inlined code can pass
  Wasm's function size limit.
- **Lowering.** Baseline calls the MIR body with its own `sp` and
  `ARGC_ONRAMP_BIT`, the header named in the resume word. The MIR entry
  dispatches to `O`, which loads its params from the frame.
- **Progress:** a failure in `O`, or in a guard hoisted to `P`, exits at
  the header with the backoff set, and baseline runs iterations before it
  tries again. There is no livelock.
- **Function entry** is the same construct at pc 0: a root taking the
  callee, `this` and the formals, with guards from `arg_types`.

**Generators and async functions.** A yield (`InitialYield`, `Yield`,
`Await`) is `gen.suspend`, a terminator with an exit's operands. The
lowering writes the frame (a dead local as undefined, so an out-of-scope
binding is not kept alive), saves it into the generator as baseline's
`gen_suspend` does, and returns the yielded value.
- Each yield's landing is a `Resume { index, pc }` root: the frame as
  `Val(⊤)`, guarded up to the types at the yield. A miss exits at the
  landing.
- The body's entry recognizes a resume by its generator-closing magic
  `this` (`EnterNightResume`), dispatches on the resume index, restores
  the frame (`gen_restore`), pushes `[sent value, generator, resume
  kind]` and enters the root. An index with no root (a yield in catch
  code) goes to baseline's dispatch with the descriptor untouched.
- A resume's path re-enters its loop at the header past the preheader.
  The validator allows that for blocks a `Resume` root reaches, and the
  loop passes leave such loops alone.

### 5.3 Throws

- **Any op that can throw has an `err` successor.** Those of one
  bytecode op share one throw block, ending in `exit.throw` with the
  state from *before* the op, which dominates every throwing point in
  it. The block needs no params.
- It lowers like `exit`, with the resume word in mode throw. Baseline
  runs its own landing for the pc: iterator closes, env unwinding, then
  the handler or the error return.

Try/catch is thus supported, and MIR has no exceptional control flow.
Catch code runs in baseline.

### 5.4 Reducibility

MIR has no reducibility invariant. The lowering emits the CFG as it is,
and waffle's backend reducifier duplicates the partial first iteration
from a side entry up to the enclosing loop's header, where the copy
rejoins the original. The steady-state loop exists once. §5.2's onramp
policy bounds the cost.

### 5.5 Inlining

- **Splicing** (`wasm/mir/inline.rs`). The callee `K` is built
  standalone by the same builder, then its blocks are copied into the
  caller, renaming values and remapping module entities. The entry
  root's params become the call's operands, onramp roots are dropped,
  `return`s become edges to the continuation, and throws (nothing in `K`
  catches) become edges to the call's throw block.
- **The inline frame** is space for a baseline-format frame of `K`, at a
  fixed offset above the caller's. It is not kept current while MIR
  runs; it holds only what the GC needs, and exits write it whole.
- **An exit inside `K` finishes `K` in baseline** (`exit.inline`). The
  frame's hub writes the frame and resume word and calls `K`'s own entry
  with `ARGC_RESUME_BIT`, which a MIR main body forwards to its baseline
  body. The caller then continues in MIR, as after a call: `ok_clean`
  where the epoch did not move, else `ok_dirty`, or `err`. No caller
  state is lost, and no multi-frame deopt is needed.
- **Eligibility is a property of the script alone** (`inline_eligible`):
  at most `INLINE_MAX_BYTECODE` bytes, no generator or async body, no
  class constructor, no mapped formals, no handler or close, and no
  environment of its own. So no compile of `K` needs to know who inlines
  it, and its baseline body accepts a resume at every op.
- **Guards.** The callee is compared by script (`guard.script`): a
  function class, the script slot, and a compiled script, with a cell
  that learns only callees that passed the whole test. A miss runs the
  ordinary call; a site may chain several targets. A callee whose type
  proves its script (§3, §4.3, a known closure) needs no guard.
- **Context.** A callee build depends on the closures the call passes
  for its formals, the construction state or proven layout of its
  `this`, and where it is inlined (`callee_ctx`). A caller keeps its
  `Obj` facts across a splice in which every kill exits; a callee with a
  fence demotes them.
- **Admission** (`admit`), in order:
  - nesting depth 8 below a call site in a loop, else 4;
  - `MAX_INLINE_SITES` (8) spliced targets per function, nested ones
    included, counted depth-first;
  - no splicing into a function that uses `arguments` (other than
    forwards that elide it), mapped formals or actuals, nor at a site in
    a catch or finally range;
  - fuel: past 25,000 MIR instructions only callees of at most 160
    bytes, up to 60,000;
  - at most `MAX_INLINE_TARGETS` (4) targets; a target's bytecode at
    most 150 bytes, 200 in a loop, or 500 at a polymorphic site;
  - no loop-bearing callee under a loop;
  - for a construct, one target whose transitive cost
    (`splice_closure_cost`) is at most `CONSTRUCT_CLOSURE_CAP`.
- **Constructs.** `new F(…)` of a site's one constructor checks that the
  callee is that script's function and a constructor (`fn.is_ctor`),
  makes `this` (§2.3) and splices the body. The result is the body's
  value if an object, else `this`.
- **`T.apply(this, arguments)` and `T.call(…)`** with the pristine
  builtin inline their resolved targets over the frame's actuals or the
  call's arguments.
- A callee that reads its actuals gets them all in its frame
  (`InlineFrame::argc`).
- **Stack layout.** Caller frame, rooting area, inline frames, then real
  calls' frames. An inline frame overlays the rooting slots that no
  value live in its region has.
- **What `inline.enter` writes** (`Fixed`). The GC scans the frame up to
  its top, below the fixed slots `K` never reads while MIR runs. A
  construct, or a callee reading its arguments object or new.target,
  gets all the fixed slots; one that sets its environment, the env slot;
  any other, none.
- **Lazy frames** (`LAZY_INLINE_FRAMES`). For a frame that nothing reads
  from memory while MIR runs, `inline.enter` writes only the callee
  slot. The first GC point on a path in the frame, or in a frame inlined
  into it, sets `this`, the formals and the locals that hold no retained
  value to undefined (`materialize`); live values are rooted in home
  slots anyway. `unmat` tracks which frames are still unset along each
  path (a union at merges). A loop that may GC has them set on its entry
  edges. An exit sets only its ancestors' frames, since the hub writes
  its own. Covered by `tests/jit-test/night/mir-inline-lazy-frame.js`.

## 6. Effects and memory

- **Every op has an effect summary** (`Effects`), computed from its
  opcode and operand types: regions read and written, may-GC, may-run-JS,
  may-throw, and its kill pattern.
- **Alias regions** (`mir::module::Region`):
  - `Field { name, keys }`: a named field of objects of those layouts.
    `keys: None` is a named access on an unproven receiver and overlaps
    every `Field` of that name.
  - `Elements(root)`, `ArrayLength(root)`: by array class region, proven
    by the receiver's stamp. `None` overlaps every one of that kind.
  - `TypedArrayData(kind)`, `TypedArrayLength`.
  - `Global(binding)`, `Env(slot)`.
  - `FrameEnv`: the frame's current environment. Only this frame's scope
    ops write it, so `Unknown` does not cover it, and environment reads
    hoist past calls.
  - `Unknown`: every other region.
- **An access gets a specific region only when the receiver's type
  proves it.** The same SSA ref is must-alias. Otherwise two accesses may
  alias only if their regions overlap.
- **Two kinds of fence.** An unknown-alias store (or may-run-JS op)
  clobbers all remembered memory. An unknown-alias load blocks only
  dead-store elimination and sinking across it. These are separate from
  §4's type fences.
- **A clean edge protects types, not memory.** It says only that the
  epoch did not move, and a getter can write a field without moving it.
  Memory knowledge does not cross a generic op; precise effects come
  from typed ops and the data ops (`docs/MIR-MEMORY.md`).
- **Effect word.** Every MIR and baseline body returns `FLAGS_ALL`.
  Clean versus dirty comes from the stamp epoch (§4.2) instead.
- **Limitation:** only arrays with an element claim are stamped
  (`array_stamp_in`), so other arrays' accesses get wildcard regions.

## 7. Opcode set

The set is the `Opcode` enum in `mir/ops.rs`, with mnemonics in
`mir/print.rs`. **(T)** marks terminators. Those with `fail` leave before
anything observable; those that can throw have `err`.

- **Constants:** `const.val`, `const.i32`, `const.f64`, `const.bool`,
  `const.str`, `const.obj`.
- **Conversions:** `box`, `box.double`, `unbox.*`, `i32.to_int`,
  `i32.to_f64`, `int.to_f64`, `weaken`.
- **Guards and checks (T):** `guard.unbox.*`, `guard.tags`, `guard.kind`,
  `guard.layout`, `guard.ctor`, `guard.singleton`, `guard.script`,
  `guard.range`, `int.to_i32`, `f64.to_int_exact`, `check.fuse`,
  `check.binding`, `check.binding.write`, `check.binding.fn`,
  `check.native`, `method.load`, `accessor.probe`.
- **Control (T):** `jump`, `br`, `switch`, `switch.str`, `return`, `exit`,
  `exit.throw`, `exit.inline`, `gen.suspend`, `unreachable`.
- **Numeric:** `i32.{add,sub,mul,rem}.ovf` (T; `mul` fails on -0, `rem` on
  a zero divisor or -0), the `.wrap` forms, `int.*`, `f64.*`,
  `i32.{and,or,xor,shl,shr}`, `i32.ushr`, `to_int32`, compares, `math.*`.
- **Generic JS ops:** `js.*`, lowered to inline arms over the runtime's
  helpers. Most are (T) with clean/dirty edges and kill everything on
  the dirty one. `js.rt.*` are the operations with no inline form, over
  baseline's helpers; with them the builder covers nearly all JSOps.
- **Split ops (T):** `getprop.data`, `setprop.data`, `getelem.data`,
  `setelem.data`, `prim.*`: the generic op where it runs no user code,
  failing where it would (`docs/MIR-MEMORY.md`).
- **Objects:** `load_field`/`store_field` (T), `load_slot`/`store_slot`,
  `init_field` (T), `publish_layout`, `ctor.stamp`, `ctor.publish`,
  `restamp`, `stamp.fresh`, `create_this`, `new_this`, `new_this.init`,
  `lit.new`, `lit.init`, `load_elem`/`store_elem` (T; `store_elem` may
  also append), `load_ta`/`store_ta` (T), `length.{array,string,ta}`,
  `object.lit`.
- **Globals and environments:** `load_gname`, `store_gname`,
  `global.object`, `env.current`, `env.parent`, `env.load`, `env.store`,
  `env.set`, `env.pop`, `env.callee`.
- **Frames, arguments, iteration:** `frame.store`, `frame.callee`,
  `frame.new_target`, `inline.enter`, `args.*`, `iter.*`.
- **Calls (T):** `call`, `call.iter`, `call.eval`, `construct`,
  `js.apply_fwd`. A call of a proven script goes to its body with no
  classify (`js_call_proven`); others classify the callee, with direct
  arms for likely targets.

The IR defines some ops the builder does not emit, some of which the
lowering does not take: `call_direct`, `call_native`, `new_object`,
`new_array`, `elements_ptr`, `str.char_code_at`, `const.obj` and
`guard.singleton`.

## 8. JSOps to MIR

The builder (`wasm/mir/build.rs`) is a function of (JSOps, facts) that
produces a MIR body or declines (§11). It interprets the bytecode
abstractly, with the operand stack and locals as SSA values.

- **Slot types** (`Ty`). Each frame slot is a raw `I32`, `F64` or `Bool`,
  a `Val` with tags, `Obj` (layouts proven by a dominating guard),
  `ObjHint` (proven before a fence), `Ctor`, `Native` (elements
  addressable), `Ta(kind)`, `Fn` (a known closure), or `Dead`.
- **Block entry types come from a fixpoint.** The builder runs over the
  script, recording the types that reach each block; where they are
  wider than the block's entry types, those widen and it runs again. The
  run where nothing widens is the result, so the type policy exists once,
  in the emitting code. Within a run a block joins all its forward
  edges, so only back edges call for another run.
- **Local-first guarding for killable components.** Every op that needs
  a layout or fact guards it immediately before, unless the operand's
  slot type proves it. The builder does not reason about which earlier
  guards still hold. Guard folding and hoisting do that, and the
  validator checks the result.
- **One rule for every object-typed value**, whatever its source: its
  type is what is proven. The predicted class is not in the type; each
  use that needs it guards.
- **Guard-at-defs for tags.** Formals, and the results of generic reads
  and calls, are guarded to the analysis's claim. A failing result
  exits at the *next* pc with the unguarded value on the stack.
- **Int-first speculation.** A number claim without a double history is
  int32 for formals, elements, names and closure variables
  (`SPECULATE_INT_FIRST`). Fields and call results are not: their claims
  miss doubles too often.
- **Numeric ops** take the int32 path (checked) if both operands are
  int32, the f64 path if both are numbers, else `prim.*` or `js.*`.
- **Elements.** Accesses predicted on arrays, with int32 keys, are
  `load_elem`/`store_elem` on a `Native` receiver, and those on one
  typed-array kind are `load_ta`/`store_ta`. The generic op serves holes
  and out-of-bounds indices, or an exit where no typed array can reach
  the site (`ELEM_LOAD_EXITS`). A loop-invariant receiver is guarded at
  the loop's entry. Clamped and Uint32 arrays are generic.
- **Constant keys.** An element access whose key is a non-index string
  constant is built as the property access of that name.
- **`length`** is `length.string` for a proven string, and for a
  receiver with array evidence `guard.kind Array`, `length.array`,
  `int.to_i32`.
- **Narrowing.** A type test that a branch consumes narrows the value on
  the side it proves (`fuse_test`). `x instanceof C` makes `x` an object
  on the true side (`narrow_instanceof`); a primitive that answers true,
  through a custom `Symbol.hasInstance`, exits at the branch.
- **`arguments`.** The object is not made where it feeds only
  `T.apply(this, arguments)` forwards at proven sites, or where it is
  read only for its length and elements (`compute_args_reads`: no formal
  written or closed over, uses straight-line). An exit while it is
  elided makes it first. A mapped object is made at entry, before
  anything can exit, and formals are then read and written through it.
- **Environments** are read through the frame's env slot (§5.1). Direct
  eval is `call.eval` over the frame's environment.
- **`switch` over string constants** (three or more cases) is
  `switch.str`.
- **Witnesses** are attached to every op with a static kill (§4.5).

## 9. MIR to waffle

For each script (`wasm/mir/mod.rs`):

1. Build, optimize and verify the MIR (`prebuild`, which depends only on
   the analysis, so scripts run in parallel).
2. Compile baseline with MIR's exit and throw pcs, and its onramp
   headers, as the resume set.
3. Lower MIR (`wasm/mir/lower.rs`) into its own function. The entry
   block forks on a resume (forwarded to baseline, for inline-eligible
   scripts), an onramp or a generator resume, else enters the entry
   root. Blocks are lowered in reverse postorder.
4. Emit. waffle's backend reducifies the body (§5.4).

**Inline arms.** Each covers a helper's common case; anything else takes
the helper. Those whose correctness rests on an invariant:
- *Property gets* probe the IC's first way inline, then the module's
  shared probe (`night_ic_get`), then the miss helper, which fills the
  ways. Rows may hold a proven absence. A primitive receiver is keyed by
  a pseudo shape, and own-property tests have rows of their own.
- *Property adds* replay a transition row (`set_ic_trans`): the old
  shape and every recorded prototype hop must match, and the add must
  not falsify a class-word bit. A CLOSED receiver goes to the helper.
  Named adds use the site's row; `obj[atom] = v` uses a global table
  keyed by shape and atom (`elem_add_arm`).
- *Stores* run the incremental pre-barrier and generational
  post-barrier inline and call the runtime only when they fire.
- *Closure variables* (`env_slot`): an environment is non-extensible and
  made with as many fixed slots as fit, so a slot is fixed below
  `MAX_FIXED_SLOTS` and dynamic above.
- *For-in* (`iter_from_shape`) starts from the iterator the shape
  caches, if it is initialized and not active, there are no dense
  elements on the object or its prototypes, and the recorded prototype
  shapes still hold. The iterator is linked into the compartment's
  active list, and a nursery object gets the whole-cell barrier.
- *Regexps.* A non-global, non-sticky `exec`/`test` runs the AOT matcher
  from compiled code (`regexp_no_match`). Only a failed match is final,
  since it changes nothing; a match is redone by the leaf.
- *Concatenation* past the inline-string limit makes a rope in the
  nursery (`rope_concat`), while the zone allocates strings there.
- *`load_elem` followed by an unbox* tests the unbox's tag first
  (`load_elem_unboxed`): a hole never has that tag.
- *Equality, ToBoolean, typeof* are decided by tag, class and pointer
  where that suffices, under the emulates-undefined fuse where needed.

**Cells and rows hold raw GC pointers and are not traced.** A major GC
drops or refreshes them all. This is the whole invalidation strategy for
moved or reused addresses, and every fill path refills lazily.

**Diagnostics.** `--mir-stress N` makes every exiting guard also fail on
each Nth guard executed. `--mir-exit-census` counts exits, the guards
behind them, IC misses and slow paths; `--value-census`,
`--block-census` and `--root-census` count executed Wasm values, MIR
blocks and rooting stores. `--dump-tiers` reports the tier and decline
reasons of each script.

## 10. Optimizations that must work

Local-first guarding (§8) is acceptable only because guards fold (§10.1)
and hoist (§10.2). The optimizer is `mir::opt::optimize`: a fixpoint over
the passes below and those of `docs/MIR-MEMORY.md`, then `pea` and
`promote` once each (with the fixpoint again after either), then
`sink_to_exits`. `forward_params` and `thread_jumps` clean up between
passes. Textual tests are in `compiler/src/mir/tests/`, end-to-end ones
in `tests/jit-test/night/`.

### 10.1 Guard folding (GVN on guards)

`opt::fold_guards`.

- **The problem.** Guards are terminators, so merging two is *branch
  folding*, not value numbering.
- **Guard identity:** the kind, the static params, and the operand up to
  `unbox`.
- **The condition.** A guard `G2` is redundant given `G1` if `G1`'s
  output implies `G2`'s and could legally be used at `G2`: it dominates,
  and no fence on any path between kills its type. That is the
  validator's condition for the value being live there (§4.1), so the
  rewrite, a `jump` to `G2`'s `ok` block, validates by construction.
- **Implementation:** an available-guards forward dataflow. Gen is a
  guard's `ok` edge; kill is fences, by pattern, which covers kills on
  paths that merely rejoin; meet is intersection.
- **Implication is checked**, not assumed. `check.binding` folds only
  into a check that implies it (`BindingCheck::implies`). A stronger
  output goes on weakened to the folded guard's type, since an op's rule
  need not be monotone in its operands. `check.fuse` and `check.binding`
  are dropped at any op that may run JS, and `method.load` at any op
  that may run JS, write or kill.
- **Joins carry facts through param types.** If every predecessor
  passes a value carrying the fact, the param's type carries it.
- **Type-based folding.** A guard that its operand's type proves becomes
  a `jump`.

### 10.2 Guard hoisting into the preheader (LICM for guards)

`opt::hoist_guards`. A guard inside a loop moves to `P` when:
- its operand is loop-invariant;
- no fence in the loop kills its fact (a kill on an edge leaving the
  loop does not count; `check.fuse` and `check.binding` also need no JS
  in the loop);
- it runs on every iteration (its block dominates the latches), which
  avoids speculating a conditional guard.

The last two are judged on the loop as it would be with every candidate
hoisted, as a greatest fixpoint. A hoisted guard fails to an exit at the
loop header with the loop's entry state (`LoopEntry`), which is correct
because nothing in `P` has done observable work of the iteration. The
in-loop guard becomes a jump. Since onramps enter through `P`, hoisted
guards run on every onramp.

A loop whose preheader does not dominate its body (a side entry by an
inner onramp or a resume) is left alone. `method.load` is not hoisted:
its type is not killable. `opt::hoist_reads` hoists an invariant read
diamond as a whole, and `opt::licm` hoists pure ops and reads
(`docs/MIR-MEMORY.md`).

### 10.3 Fences and rejoins

The canonical case is `loop { a.x; f(); a.x }`
(`compiler/src/mir/tests/fence_rejoin.mir`):
- the first guard on `a` hoists to the preheader;
- the second folds on `f`'s `ok_clean` edge;
- on `ok_dirty`, the re-guard runs, and the join stays as strong as the
  clean path.

A loop containing a static fence keeps its post-fence guard in the loop.

### 10.4 Box, unbox and weaken cleanup

`opt::fold_unbox` folds `unbox(box x)` to `x`, through `weaken`s.
`opt::sink_to_exits` makes a value that only exits use (a `box` whose
type no fence can weaken, or `global.object`) in those exits, so the hot
path does not.

### 10.5 Memory: forwarding, RLE, DSE

Store-to-load forwarding and redundant-load elimination are
`mem::mem_vn`, over the regions of §6. With scalar replacement, partial
escape and loop-carried caching, they are described in
`docs/MIR-MEMORY.md`. Dead-store elimination is not done.

### 10.6 Numeric

- **Ranges.** `narrow_ints` gives each int32 param the hull of what its
  edges pass (an optimistic fixpoint with widening), and `fold_ints`
  removes the checks that ranges prove.
- **Onramps.** A loop param fed by an onramp has no range, however
  narrow the loop's entry path makes it. `onramp_ranges` guards the
  onramp's value (`guard.range`) into the range of the *header* param it
  becomes, back edges included. The preheader param's range would be
  wrong: it is the loop counter's start value, and every onramp would
  fail.
- **Truncation demand.** `trunc_demand` rewrites `.ovf` to `.wrap` where
  only ToInt32 sees the result. A bound on the exact sum's magnitude
  keeps it under 2^53, so ToInt32 of the double sum is the wrapping sum.
  A product is unchecked only where its range fits int32 (its -0 is 0
  there).
- **Exits recompute wrapped values.** An exit needs a value exactly, so
  `recover_at_exits` replaces a wrapped operand by its exact value,
  recomputed in doubles just before the exit. `trunc_demand` can then
  ignore exits that can be served this way.
- **Representation selection** is the builder's entry-type fixpoint: an
  int32 local stays an `I32` block param.

## 11. v1 scope

A script is compiled by baseline alone (it is *declined*) when it is:

- a global (top-level) script;
- over 32 KiB of bytecode, or past 60,000 MIR instructions after
  inlining (`MAX_MIR_INSTS`). A MIR script carries two bodies, so size
  bounds protect compile memory and Wasm's function size limit;
- a generator or async body that reads its actuals past its formals (a
  resume re-enters with none);
- one whose MIR fails the validator (`BUG: invalid MIR`), or that the
  lowering cannot take (`lowering: …`). Both are bugs.

The builder also declines, by name, any op it has no case for, and a few
operand shapes, such as an `InitElemInc` or `GetActualArg` index that is
not int32.

A script that is not inline-eligible (§5.5) is not declined; it is only
never spliced.

Known limitations, described in place: retention across exits (§4.4),
the object component of field claims (§4.6), wildcard regions for
unstamped arrays (§6), and dead-store elimination (§10.5).
