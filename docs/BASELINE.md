# NightMonkey baseline tier: design

The baseline tier (`compiler/src/wasm/baseline/`) is the correctness
floor of the compiler. It is the deopt target of the MIR tier
(`docs/MIR.md`), and with `--pipeline baseline` it is the only compiled
tier.

## 0. Summary

- **A deliberately simple compiled tier.** Each JSOp is lowered straight
  to Wasm. Trivial ops (constants, stack manipulation, local/arg/rval
  access, jumps, return) are inline. Nearly everything else is one direct
  call to a runtime helper. A few ops have an inline fast path decided by
  the operands' tags, or by an inline cache, with the helper as the
  fallback (§3.1). There is no speculation and no deopt.
- **The whole frame lives in NightStack memory**: callee, this, args,
  locals, env, arguments object, new.target, rval, and the operand
  stack. No JS value is carried in SSA between ops. GC rooting is
  therefore trivial, and the program state at any pc is just "the frame,
  plus the static operand depth at that pc".
- **It shares the AOT stack and ABI.** Frames are built in place on the
  NightStack, bodies have the `night_abi_sig2` signature, and
  interpreter entry, calls, exceptions and generator resume use the
  common protocols (§1). Baseline bodies, MIR bodies and the interpreter
  call one another freely.
- **The frame format is the contract between tiers** (§2). A MIR exit
  writes a baseline frame and resumes baseline at a pc (§4). A MIR
  onramp reads a baseline frame at a loop header (§7). MIR and baseline
  are separate Wasm functions, so neither constrains the other's CFG.
- **Baseline supports every JSOp** except `ForceInterpreter` (§6). Its
  few remaining declines are properties of a script as a whole (§8). A
  script is compiled by MIR only if baseline also accepts it.

## 1. Runtime environment

What baseline shares with the MIR tier and the runtime:

- **NightStack** (`runtime/NightStack.h`): an upward-growing array of
  boxed Values, one per `JSContext`, in a region of
  `1 << Night_valueStackLog2` bytes aligned to its size. `[base, top)` is
  traced as roots, and updated, on every GC. Any helper that may GC
  takes `top` as its second argument, installs it with `SetNightTop`,
  and writes a boxed result to `*top`.
- **Headroom.** A body may use 64 KiB above its incoming actuals
  (`kNightStackHeadroomSlots`) without a check of its own: every entry
  reserves it. Compiled callers test it as "the last byte has the frame
  base's high bits", which the region's alignment makes a compare with
  no load of the limit.
- **Helper ABI**: the manifest is `runtime/NightHelperList.h`, whose
  signature strings are derived from the helpers' C++ types. The Rust
  mirror is `Helpers` in `compiler/src/wasm/translate.rs`. A throwing
  helper returns 1 on success and 0 with the exception pending on `cx`.
- **Body ABI**: `(cx, sp, argc, retval_out, script, new_target: i64) ->
  (err, eff)`.
  - `err` is 0 for ok and 1 for an exception. A MIR body entered by an
    onramp may also return `ERR_DEOPT` (2), which only baseline's onramp
    call sites can see (§7).
  - `eff` is always `FLAGS_ALL` from a baseline body, which is always
    safe.
  - The `script` parameter is not used: a raw script pointer does not
    survive a compacting GC. A body that needs its script re-derives it
    from the callee at `sp+0`. (An onramp call just passes the parameter
    through to the MIR body.)
- **Table placement.** The table entry for a script is an adapter with
  the C-visible single-result signature. The bodies sit in one
  contiguous block, and their adapters in another block in the same
  order, so each body is exactly `n_bodies` slots below its adapter
  (`wasm/mod.rs`). Direct calls rely on that offset.
- **Entry**: the script's `externalTierWord` holds its adapter's table
  index; 0 means the script is interpreted. `EnterNight`,
  `EnterNightGlobal` and `EnterNightResume` (`runtime/NightEntry.cpp`)
  build `[callee, this, args…]` at `frameBase()`.

## 2. The frame format (the inter-tier contract)

One layout, computed from the script alone (`FrameLayout::of(script)` in
`layout.rs`), shared by baseline, the MIR lowering, and the resume and
exit protocols. **No slot depends on what a code generator decided**, so
the tiers agree on it by construction.

| Offset | Slot | Present |
|---|---|---|
| `sp+0` | callee (global script: `PrivateGCThingValue(script)`) | always |
| `sp+8` | this | always |
| `sp+16+8i` | actuals, `i < max(argc, nargs)`: the caller builds these; the body pads formals with `undefined` | always |
| `vp+L+8j` | locals `j < nlocals`, `L = 16 + 8·nargs` | always |
| `vp+E` | env chain, `E = L + 8·nlocals` | `has_env`: the script has env ops, or ops whose helpers read the chain (`needs_env`) |
| next | arguments object | `has_args_obj`: an `Arguments` op or a mapped arguments object |
| next | new.target | `has_new_target` |
| `vp+R` | rval | always |
| `vp+R+8` | resume word, an int32 Value (§4) | always |
| `vp+R+16` | onramp backoff, an int32 Value (§7) | always |
| `vp+O+8k` | operand stack `k < depth(pc)`, `O = R + 24` | always |

`vp` is `sp + 8·max(0, argc−nargs)` if the script reads actuals past its
formals (`Arguments`, `Rest`, `GetActualArg`, mapped arguments:
`reads_actuals`), else `sp`. The optional slots exist only where the
script uses them because a slot nothing reads would cost every entry a
store: the GC scans the whole frame, so each slot must hold a valid
Value. That the presence depends only on the bytecode is what keeps it
part of the contract.

**State at pc.** The frame together with `depth(pc)`, the static operand
depth computed by a forward pass over `nuses`/`ndefs` (`StackDepths`),
fully describes execution at a bytecode boundary:
- every slot below `vp+O+8·depth(pc)` holds a valid boxed Value;
- the env slot holds the env chain in effect at `pc`;
- the rval slot holds the current rval.

This is what a MIR exit writes and what a MIR onramp reads. Magic values
(TDZ, element holes, generator-closing) are ordinary Values here. MIR's
type for a frame slot, `Val(⊤)`, includes them (MIR.md §2.1). A MIR body
does not write its locals through to the frame as it runs: it keeps the
frame valid for the GC and writes its state when it exits (MIR.md §5.1).

**GC invariant.** At every may-GC call the published `top` is at least
`vp+O+8·d`, where `d` is the current depth including the op's inputs
(they stay rooted until the result is stored). The prologue initializes
every slot below the operand stack before the first helper call. After
such a call nothing loaded before it is reused: a moving GC updates the
rooted slots, not SSA copies.

**Frame bound.** Nothing checks a body's own frame against the headroom,
so a script whose frame exceeds 48 KiB (`MAX_FRAME_BYTES`) is declined.

## 3. Codegen

### 3.1 Per-op shape

For each bytecode basic block there is one waffle block with no block
params. Each op:
1. loads its inputs as i64 from the operand slots it consumes;
2. calls its helper as `helper(cx, top = vp+O+8·depth_before, inputs…,
   immediates…)`;
3. on a zero return, branches to its pc's exception landing (§3.3);
4. copies the result from `*top` into its operand slot.

A leaf helper, which cannot GC or throw, skips the `top` argument and
the test. Fully inline ops are constants (boxed immediates), the stack
manipulations, `Get`/`Set` of locals, args and rval (a mapped formal goes
through the arguments object), a few tag tests, `Goto`, `TableSwitch`,
`Return`/`RetRval`, and the no-ops.

**Fast paths.** Some ops have an inline fast path that decides from the
operands' tags alone, with the op's ordinary helper call as the
fallback. A fast path uses no analysis facts and carries no state
between ops, like the inline cases of SpiderMonkey's portable baseline
interpreter, so the tier stays non-speculative. They exist because a
boxed helper call for every `Add` or `Lt` is far slower than even an
interpreter's inline int32 case.
- **ToBoolean** in `JumpIfFalse`/`JumpIfTrue`/`And`/`Or`/`Case`/`Not`:
  int32, boolean, undefined, null and double.
- **Arithmetic**: an int32 arm, then a number arm on the operands as
  doubles, then the helper.
  - `Add Sub Mul` get both arms. The int32 arm is overflow-checked, and
    `Mul` also bails on a −0 product.
  - `Div` gets the number arm only.
  - `Mod` gets the int32 arm only, for a non-negative dividend and a
    positive divisor. Double `%` is fmod, which Wasm lacks.
  - The bitwise ops and shifts get the int32 arm only. `Ursh` bails when
    the result is 2³¹ or more.
  - `Inc Dec Neg` get both arms; `BitNot` gets the int32 arm.
  - `Pos` and `ToNumeric` are the identity on a number.
  - A number-arm result is boxed as `NumberValue` boxes it: an integral
    double (but not −0) becomes an int32, and NaN is canonicalized.
- **Compares.** `Lt Le Gt Ge` get an int32 arm and a number arm.
  `Eq Ne StrictEq StrictNe` decide inline when both tags are equal and
  are int32, boolean, undefined, null or object. With one tag, loose and
  strict equality are both identity of the value. Two numbers otherwise
  compare as doubles.
- **`GetElem`** on an object and an int32 key: an in-bounds, non-hole
  dense element of a native object.
- **`GetProp`** probes the site's property inline cache through the
  module's shared, out-of-line `night_ic_get` (own and holder ways, then
  the megamorphic table). A miss calls `night_runtime_get_prop_ic_miss`,
  which does the generic get and fills the site's ways. The cache is
  runtime state, but only as a memo of the generic lookup.
- **`SetElem`** is a helper call. `night_runtime_set_element` has an arm
  for an in-bounds overwrite of a non-hole, non-frozen dense element.
  Inlining it would need the GC barriers in Wasm, which is not worth it
  for this tier.

Each fast path is a diamond with its own slow block. Both arms leave
their result in the frame and rejoin at a block with no params, and the
slow path sees exactly the frame the plain lowering sees.

Baseline does not cache operands or locals in SSA across ops. Such a
cache must empty at every call and block boundary, so it saves few
loads, and it would cost the invariant that the frame alone is the state
(write-back points, isolation of the fast-path arms, GC safety of cached
values).

### 3.2 Immediates and helpers

- **Every JSOp lowers to a direct call to one NightMonkey helper**, or
  is inline. There is no dispatch table, no function-pointer
  indirection, and no decoding at runtime. The compiler decodes
  immediates (atom ids, gcthing indices, scope indices, counts) and
  passes them as constants. Names are AtomTable ids resolved at compile
  time.
- **Where a helper takes a cache or cell index** that baseline does not
  use, it gets the documented "none" value (`init_prop` takes
  `u32::MAX`; `new_object`, `new_array` and `lambda` take `cell = 0`).
- **A helper that needs the script** (for a gcthing index, for example)
  gets it derived from the callee at `sp+0`, for the reason in §1.

### 3.3 Exceptions

The handler for each throwing pc is static, found by the try-note walk
that mirrors the interpreter's `ProcessTryNotes`. Each throwing op's
error edge goes to a landing for its pc and depth that:
1. closes the for-in and destructuring iterators the walk passes, inline
   (`end_iter`, `close_iter_for_exception`);
2. pops the environments the handler does not see. Their number is
   static too: the scope notes at the throwing pc against those at the
   handler's `Try`;
3. for a catch, jumps to the handler block, whose depth is the try
   note's `stack_depth`;
4. for a finally, pushes `[exception, stack, true]` via
   `get_exception_for_finally`, then jumps to the handler;
5. with no handler, returns `(1, FLAGS_ALL)`.

Error edges only go from inside a try range to its handler, so they stay
reducible. Outside generators each throwing pc has its own error-return
block rather than a shared one: a block with a predecessor per helper
call makes dominator construction quadratic on a large body.

In a generator, a forced `.return()` is a pending generator-closing
magic. It passes over catches and runs only finallys, so a catch edge
tests for it at runtime (`gen_is_closing`), and the error return turns
it into a normal return of rval (`gen_closing`).

### 3.4 Calls

A callee's frame is built in place at the operand slots
(`frame_base = vp+O+8·(depth−need)`), whichever way it is called.

- **Ordinary calls** (`Call`, `CallContent`, `CallIgnoresRv`) classify
  the callee with `call_classify` (no call cell). A compiled callee that
  fits the stack is entered by a sig2 `call_indirect`, with no C++
  re-entry; anything else goes through `night_runtime_call`. The direct
  path bounds JS recursion by the NightStack rather than by native
  frames: each trip through C++ costs several of those.
- **Construct, iterator and spread calls** go through
  `night_runtime_construct`, `night_runtime_call_iter` and
  `night_runtime_spread_call`.

### 3.5 Generators and async

A generator resume lands through the same dispatch as a MIR exit (§4).
- **Suspend:** `gen_suspend` saves the locals, the live operands and the
  env chain in the generator object, under the yield's resume index, and
  the body returns.
- **Resume:** `EnterNightResume` enters the body with
  `this == JS_GENERATOR_CLOSING`, which no call can pass, and stages a
  descriptor (resume index, resume kind, generator, sent value) over the
  locals. The body reads all of it, initializes the fixed slots,
  restores with `gen_restore`, writes `[value, generator, kind]` at the
  landing's depth, sets the resume word and routes to the landing.
- A MIR exit of a resumed activation still has the magic `this` in its
  frame. It comes with `ARGC_RESUME_BIT`, which takes precedence.

The saved state does not include the actuals or the arguments object, so
a generator that reads those after its first suspend is declined (§8).
The frontend normally reads them in the prologue and keeps the results
in bindings.

### 3.6 Class words

Baseline runs code whose objects MIR later guards, so it must keep up
the class-word protocol (`DESIGN.md` §6), or every layout guard would
miss. It stamps what it allocates (literal and array sites), seeds and
stamps constructed objects (`night_runtime_construct`'s slot count and
early word; `ctor_stamp` at a layout constructor's return), restamps
(`ctor_restamp`) where the analysis placed a restamp, and vouches for
the stored type at property sets: where the receiver's class word names a
class that types the field and the value is of that type, the set tells
the engine to keep the object's TYPES claim (`vouch_types`). These
depend on static layouts, but nothing baseline computes depends on
them being right.

## 4. Resume at a pc, reducibly

Three things enter a baseline body at a pc other than 0: generator
resume, a MIR exit, and a MIR throw exit. A direct edge from the entry
to a pc inside a loop would be a side entrance, making the CFG
irreducible. Instead, **resume dispatch goes through the loop headers.**
- A loop header `H` whose loop contains a resume target gets a dispatch
  block `H_d`, which becomes the loop's header. The loop's entry and
  every back edge go to `H_d`.
- `H_d` loads the frame's resume word and compares it with the targets
  inside its loop:
  - no match runs `H`'s own code;
  - a target directly in `H`'s loop body goes to that target's landing;
  - a target inside a child loop `H'` goes to `H'_d`.
- A landing block clears the resume word to `u32::MAX` ("not resuming",
  which no encoded word equals) before it enters the target, so later
  iterations find no match. A fresh frame holds 0, which names pc 0 and
  hence no target inside a loop.
- The resume entry does the same at the top level: it goes to the
  target's landing, or to the outermost enclosing loop's `H_d`.

Every added edge runs from a loop header to a block its loop already
contains, so the header still dominates its loop and every retreating
edge still targets a header. **The CFG is reducible by construction**,
and the target being in memory means back edges carry no arguments. The
cost is one load and the target compares per iteration of a loop that
contains targets. `build_body` checks the property
(`verify_reducible`); a violation declines that one script with a `BUG:`
reason.

- **The resume set is static input.** It holds the generator landings
  and the resume words of the MIR body's exits and throws: MIR is built
  first, and the baseline compile is given its exit set (`resumes`). A
  script that MIR callers may inline (`inline_eligible`) accepts a
  resume at every reachable op, in both modes, because an exit inside an
  inlined copy finishes the call in this body (MIR.md §5.5).
- **The resume signal** fits within the sig2 ABI:
  - `argc` carries `ARGC_RESUME_BIT` (`0x4000_0000`), and the body skips
    its prologue;
  - the frame's resume word holds the pc and a mode (`ResumeWord`):
    `Continue` lands on the pc's block, `Throw` on the pc's exception
    landing, with the exception pending;
  - a generator resume has its own signal (§3.5).

  A resume word outside the set is a compiler bug and traps.
- **Canonical numbers.** MIR may leave an integral double in a frame
  slot as a double. The resume entry boxes the formals, locals and rval
  as baseline would, since it passes them on to callees whose MIR entries
  guard int32 formals.

## 5. Integration

- **Code**: `compiler/src/wasm/baseline/`: `layout.rs` (`FrameLayout`,
  `StackDepths`, the resume word, ABI bits), `mod.rs` (`build_body`, the
  gates) and `codegen.rs` (one exhaustive `match` over `JSOp`, plus
  exceptions and resume). It shares `Helpers` and `AtomTable` with MIR.
- **Pipeline**: `Options::pipeline`, `--pipeline baseline|mir`, default
  `mir`.
  - `baseline`: baseline only; a script it declines is interpreted.
  - `mir`: MIR plus baseline. A script the MIR builder declines compiles
    as baseline alone, and one baseline declines is interpreted.
- **Driver**: `translate_for_pipeline` in `wasm/mod.rs` picks a tier per
  script. Either tier returns an ordinary `Outcome::Compiled`. Under MIR
  the script's table entry is the MIR body's adapter, and its baseline
  body is an *extra body* (`Outcome::Compiled`'s `extra_bodies`): placed
  after the adapter block, and only ever called directly, through
  patched call sites in both directions.
- **Coverage** (`wasm/tier.rs`):
  - `--dump-tiers` reports which tier compiled each script and every
    decline with its reason, then a summary.
  - `--strict-coverage` fails the compilation if a script is interpreted
    for any reason but `ForceInterpreter`, or if any tier declined one
    with a `BUG:` reason. That is how a test lane proves it ran compiled
    code.
- **In-process options**: `NIGHT_OPTIONS` is passed by
  `scripts/inproc-shell.sh.in` to the shell's `--night-options`, and on
  to the in-process batch. `Options::apply_flag` parses it, as it does
  the CLI's flags. A failed in-process batch leaves every script
  interpreted, unless `NIGHT_INPROC_STRICT` is set (as the test wrapper
  does), when it aborts.

## 6. Covering every JSOp

Baseline supports all 242 JSOps except `ForceInterpreter`, which by
definition means "run in the interpreter". `codegen.rs` matches on
`JSOp` with no wildcard, so an op the engine adds fails to compile until
it is classified.

The ops whose helpers exist only for baseline's sake each get the
interpreter's case for the op, with the frame state it reads from the
interpreter's registers passed in (the env chain, the script, the pc
offset): `BigInt`, `NonSyntacticGlobalThis`, `SetIntrinsic`, `EnvCallee`,
the eval ops, `DynamicImport`, `ImportMeta`, `GetImport`,
`AddDisposable`, `TakeDisposeCapability`, `CreateSuppressedError` and
`Resume`. `DebugCheckSelfHosted` is a no-op.

- **Direct eval.** A script that calls eval is compiled like any other;
  the eval'd code runs in the interpreter, since the compiler is AOT
  only. `NightDirectEval` (`runtime/NightOpsInterp.cpp`) is the
  direct-eval path of the engine's `EvalKernel`, taking the caller's
  script, pc and env as arguments, without the eval cache and the JSON
  fast path. A non-strict direct eval can add bindings, but only to the
  environment object, which baseline keeps in its frame slot, so no
  baseline invariant is at stake.
- **Environments.** A script whose activation environment is its
  callee's own loads it inline (`env_is_plain`). Otherwise the prologue
  calls `NightEnvSetup`, which mirrors the interpreter's function
  environment initialization, named-lambda environments included.

## 7. MIR on top

- **Separate Wasm functions.** The MIR body and the baseline body are
  independent functions sharing the frame format (§2). The MIR body is
  behind the script's table entry. There is one MIR function per script,
  however many roots it has.
- **Exit.** A MIR exit completes the baseline frame: `this`, args,
  locals, rval and operand stack, boxed, as far as they are live and not
  already there, and the resume word. Then it does one of two things:
  - if MIR was entered at function entry, it calls the baseline body
    with `ARGC_RESUME_BIT` and returns its result;
  - if MIR was entered by an onramp, it returns `ERR_DEOPT` to that
    baseline caller, which resumes itself.

  So a JS frame never uses more than three native frames (MIR, the
  baseline it exited to, the MIR that baseline onramped into).
  `exit.throw` is the same, with resume mode `Throw`. An exit from an
  inlined callee (`exit.inline`) finishes the callee through its own
  table entry, with `ARGC_RESUME_BIT`, which the callee's MIR body
  forwards to its baseline body.
- **Onramp.** At a loop header with a MIR onramp root, after its resume
  dispatch, baseline may call the MIR body.
  - The call uses the ordinary sig2 signature with baseline's own `sp`,
    so both tiers share one frame. `argc` carries `ARGC_ONRAMP_BIT`
    (`0x2000_0000`), and the resume word names the header. The MIR
    body's entry tests the bit and dispatches on the word to the root,
    which guards the frame up to the loop's types and enters the loop's
    preheader.
  - A normal return is baseline's own return; an error is an error
    return.
  - On `ERR_DEOPT` the MIR exit has rewritten the frame and the resume
    word, and baseline routes by that word, among the words that root
    reaches. Those are pcs inside the loops around the header or after
    it. For each, it jumps to the dispatch block of the innermost
    surrounding loop that contains the word's pc (a back edge to that
    loop's header), or else along the word's route from outside every
    loop. The entry's resume dispatch would not do: it is also entered
    from the function entry, so a loop reaching it would have a second
    entry. The per-root word set is what excludes, say, an entry-guard
    exit at pc 0.
- **Backoff.** The frame's backoff slot says how many more header visits
  baseline makes before it tries an onramp. Every MIR exit sets it to
  `ONRAMP_BACKOFF` (32), so baseline makes progress between attempts:
  the progress rule of MIR.md §5.2, which rules out livelock.

  An attempt that exits at the header it entered made no progress.
  Typically the root's guards refused the frame (a local that is now a
  double where the loop was built for int32), and the frame is unlikely
  to change back. Baseline then doubles the wait instead, up to 1024
  times the base: the slot's low 16 bits count down, and the bits above
  count the consecutive attempts that made no progress.
- **Reducibility.** MIR has no reducibility invariant.
  - An onramp into a nested loop is a side entrance into every
    enclosing loop: the inner preheader lies inside the outer loop's
    body.
  - The lowering emits the MIR CFG as it is. waffle's backend reducifier
    then duplicates the partial first iteration from the side entry to
    the enclosing loop's header, where the copy rejoins the original.
  - Whichever block the reducifier picks as header, the steady-state
    loop exists once. The choice only decides which fragment of one
    iteration is duplicated, which is a code-size question.
  - MIR still declares its loops (header and preheader, from the
    bytecode loops) for LICM, guard hoisting and the validator's
    preheader rule. A loop body is every block that reaches a latch
    without passing through the header, which is well-defined even with
    side entries.
- **Onramp policy.** Every outermost loop gets an onramp root, since it
  needs no duplication. An inner loop gets one only when its outermost
  enclosing loop spans at most `--mir-inner-onramp-bytes` of bytecode
  (default 400; 0 for outermost loops only), and only in a function with
  no inlined calls, which make the loops bigger than their bytecode
  says.

## 8. Limits

A script baseline declines, it leaves interpreted:
- it contains `ForceInterpreter` (the one decline strict coverage
  allows);
- it has over 1 MiB of bytecode (`MAX_BASELINE_BYTECODE`). Code size is
  linear in bytecode, but a multi-megabyte function becomes millions of
  blocks in one Wasm function, and waffle's backend validation is
  quadratic on long block chains;
- its frame exceeds 48 KiB (§2);
- it is a generator or async function that reads its actuals, or a
  mapped formal, after its first suspend (§3.5);
- it needs an environment, and its body scope is neither a Function nor
  a Global scope;
- its stack depths are not consistent, or a `BUG:` check fails.

The MIR tier declines more scripts, by op coverage and size (MIR.md
§11); such a script is compiled as baseline alone.

Other limitations:
- The module ops compile, but module scripts never reach the compiler:
  the module loader does not call the hook that registers a script
  (`docs/TODO`).
- Baseline does not run `validate()` on its bodies, because waffle's
  backend does so on every function. An invalid body therefore fails the
  whole batch instead of declining alone.
- Compiled frames are not visible to frame introspection
  (`Debugger.Frame`, `fun.arguments`) or to the decompiler's error
  messages. The tests that need those are listed in
  `tests/jit-test-excludes-baseline.txt`; `tests/jit-test-excludes-mir.txt`
  adds those that need a dead local to keep its object alive.
