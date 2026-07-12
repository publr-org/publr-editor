# PublrEditor

**Standalone block editor, rebuilt from scratch — incrementally.** The
previous POC lives in `../editor/` and stays as the reference implementation
(its `CONTRACT.md` is still the wire-contract spec); this repo re-grows the
editor one confirmed feature at a time on the architecture settled in
`.claude/thoughts/visual-builder/007`.

## Current scope

Canvas + contenteditable over a **block tree** (`data-pb-children` slots, not
just a flat list). **36 core blocks** (`src/blocks/`, one file per block) —
the full client-side core block set (epic #333): text (heading,
paragraph, list + list-item, quote, pullquote, code, preformatted, verse,
table, details, math), media (image, video, audio, cover, gallery, file,
media-text, icon), design (button/s, separator, spacer, columns + column,
accordion + accordion-item, group/row/stack/grid — the containers carry the
group's tagName as a tag carrier), widgets (embed, social-links +
social-link, custom html). The experimental form family is deliberately
not shipped (story #370).
Five carrier kinds (text, rich, tag, image, link), island-carried settings
(`data-pb-settings`) with sidebar controls (toggle-group, toggle, select,
text, number), slot policies (allowedChildren + childTemplate, same-type
Enter-split). Undo/redo, block multiselection + group delete, and
group/ungroup (⌘G / ⇧⌘G). A **shipped inline-chrome module** (`attachInlineChrome`) supplies
the floating toolbar, slash picker, and `+` inserter; a list/tree view exists.
Two demos: the full builder shell (`demo.ts`) and the **embed showcase**
(`fields-demo.ts`) — N independent editor instances, one per field: the
PublrInlineEditor use case (`../.claude/thoughts/template-fields/`).

**Not built yet — the policy/locking spine** (`allowedBlocks`, per-block locks
`editable`/`movable`/`removable`, `contentOnly`/`fixed` presets, the
template-authoritative guardrail). The "locked field editor" cannot lock
anything yet; that spine is the current focus (Shortcut epic #289, Phase A).
What the editor already proves:

- **HTML wire contract v0** — input and output are annotated HTML
  (`data-pb-*`); un-annotated markup survives as opaque `raw-html` blocks
  (permissive upcast). Authored classes on typed blocks round-trip.
- **Global runtime registration** — `registerBlock(type, def)` is the one
  public path for Publr core, plugins, and the devtools console alike. Hard
  validation per definition; live registry; `unregisterBlock` included.
  The API's global home is **`window.Publr.Editor`** (attached by the entry
  module onto the object PublrJS already claims — no clash-prone globals of
  our own; same target for the IIFE build). Editor instances are the host's
  business; the demo exposes its one as `Publr.editor`.
- **The render is the schema.** A definition is just `{ label, render }`.
  Registration probes `render({})`: the `data-pb-*` carriers in the output
  are the field declarations, and the values read back are the defaults —
  one source of truth, so declared-vs-rendered drift (a round-trip-law bug
  class) is unrepresentable. Conformance rule: render must tolerate absent
  fields. Explicit declarations return only for non-derivables (settings,
  UI metadata like tag options/placeholders) when those features land.
- **Per-block `render(fields)`** in the definition — the renderer is the
  downcast body; the editor dispatches (no monolithic render switch).
- **`commit()` choke point** — every model mutation flows through one
  function. This is the attachment point for undo/redo.
- Enter splits blocks at the caret; **Backspace at a block's start merges it
  into the previous block** (rich→rich keeps markup, rich→text strips,
  text→rich escapes; caret lands at the join; empty blocks just remove;
  before an unmergeable raw block it selects it — the second Backspace
  deletes). Mid-text backspace stays native. Typing syncs DOM → model.
- **Debug tracing** — `?debug` in the demo URL, `createEditor({ debug: true })`,
  or `Publr.editor.debug = true` from the demo console: every commit (with its coalescing
  outcome + stack depths), undo/redo, and load is one `console.log` line
  prefixed `[publr-editor]`. `editor.history` also exposes
  `undoDepth`/`redoDepth` alongside the flags.
- **Undo/redo** — snapshot history `{structuredClone(model), selection}`
  recorded at `commit()`; typing coalesces per (block, field) in a 500ms
  window, structural ops get one entry each; `editor.history` is a PublrJS
  reactive store (`canUndo`/`canRedo` — the demo buttons bind via `effect`);
  native browser undo is disowned (Cmd+Z/Cmd+Shift+Z/Ctrl+Y +
  `beforeinput historyUndo/historyRedo` intercepted); undo re-derives the
  canvas from the restored model and puts the caret back at its exact
  character offset in the right carrier (undo of a split lands on the split
  point; offsets are measured over text content so they survive re-renders,
  clamped when the restored text is shorter).

- **Block multiselection** — a native selection crossing a block boundary
  promotes to whole-block selection: the contiguous run
  between the endpoints — raw-html blocks in the middle included — highlights
  as blocks (`.pbe-selected`, native text highlight hidden inside), and
  Backspace/Delete removes the run in ONE history entry. `editor.selection`
  is a reactive `{ blocks: [ids] }` store. Because a native drag can never
  leave the contenteditable island it starts in, multiselection is a
  **gesture**: drag from one block into another (the canvas becomes one
  editing host for the duration, so the native drag can span), Shift+click —
  always block-level: it extends a contiguous run from the caret's block or
  the last explicitly selected one, and with no such anchor selects the
  clicked block whole — or **Cmd/Ctrl+click to toggle individual blocks —
  non-contiguous selections are fully supported** (the id list is the source
  of truth; delete works on any subset). Keyboard multiselect (Shift+arrows)
  is a later, deliberate feature. `editor.destroy()` detaches the
  document-level listeners.
- **Floating block toolbar** (shipped via `attachInlineChrome`,
  `src/chrome-inline.ts`) — hovers above the caret's block or
  a single selected block: move up/down (`editor.moveBlock`, caret follows,
  undoable), bold/italic via the **in-house formatting engine**
  (`src/format.ts` — no execCommand: rich content flattens to per-character
  mark sets + opaque atoms, toggling is set arithmetic, serialization
  re-emits canonical nested HTML; one undo entry, selection restored over
  the span, `editor.formatState()` drives button highlights), and text alignment
  written as **authored classes** (`text-left/center/right` — JIT-compiled in
  production, stubbed in demo CSS) so it rides the wire contract with zero
  new vocabulary. Now an optional batteries-included module built entirely on
  public editor APIs (`selection.active`, `moveBlock`, `setClasses`,
  `getBlock`) — the layering proof that hosts and plugins can build chrome;
  tree-shaken away when unused. Drag-and-drop deliberately deferred.
- **Slash command on the PublrJS dropdown contract** — empty default blocks
  show a ghost prompt ("Type / to choose a block", editor-stamped, never
  serialized); "/" opens a dropdown that is nothing but MARKUP
  (`data-p-store="local:dropdown"` + `data-p-on/-show/-bind/-portal` +
  `data-publr-part`) wired by core `publr.js`, with a ~70-line `dropdown`
  store factory registered by the demo (portal, positioning via
  `publr-position.js`, focus nav, first-letter type-ahead, dismiss). No
  design-system assets. Picking calls `editor.replaceBlock(id, type)` (one
  undo entry). Runtime gotchas that cost time: `data-p-show` toggles the
  `hidden` CLASS; `data-p-bind` writes boolean true as an EMPTY attribute
  value (don't read aria-expanded to test openness). Open question flagged:
  core ships the `local:` factory mechanism but no built-in factories —
  standard component stores may belong in publr-js itself.
- **Raw blocks are opaque, not untouchable** — clicking a raw-html block
  selects it as a block (its only interaction surface: no carriers, nothing
  to caret into); Backspace/Delete removes it, Escape or clicking editable
  content deselects, and a real block-spanning selection overrides it.
  Content-level editing of raw blocks stays off-limits by design.
- **InnerBlocks / block tree** — a block type opts into children by rendering a
  `data-pb-children` slot (`acceptsChildren` on the derived definition);
  `cast.ts` upcasts/downcasts children recursively (content that lands in a slot
  degrades to raw-html, never breaks the container), and `tree.ts` holds the
  traversal (`flattenBlocks`/`locateBlock`/`pathToBlock`). The `group` block is
  the first container; ⌘G wraps a multi-selection into one, ⇧⌘G unwraps
  (empty-group ghost handling included). Per-container `allowedBlocks` and
  scoped policy are the _next_ step, not done — nesting is structural only so far.
- **Sidebar block settings — the element switcher (#327, first Phase C slice)** —
  definitions accept `description` + `settings[]`: DECLARED editor-UI metadata,
  the non-derivables 007 reserved (a carrier declares that a field exists, not
  which values it may take). One control kind so far — `toggle-group` — with two
  bindings: `field` writes through the new `editor.setField(id, field, value)`
  (heading's `level`, H1–H6: one undo entry per pick, caret survives the
  in-place re-render, no-carrier fields refused to protect the round-trip law);
  `transform: true` makes the options block TYPES applied via
  `editor.transformBlock(id, type)` — the block keeps its id and position,
  fields carry over by name, authored classes and children ride along (refused
  when the target can't take the children; contrast `replaceBlock`, which mints
  a fresh block). Group/Row/Stack/Grid are SEPARATE registered types (each will
  grow its own layout settings) joined by one shared transform setting; the
  variants' layout rides the render's baseline classes — zero new wire
  vocabulary. Chrome: selecting a block (canvas or tree) auto-opens the sidebar
  Block tab, deselecting falls back to Document — only selection TRANSITIONS
  switch, so a manual tab pick sticks; the panel is a block card (icon, label,
  description) plus settings rendered declaratively from chrome state
  (`$blockSettings`, one template per control kind; option buttons carry the
  primitive + target in their dataset). Toolbar formatting is deliberately NOT
  mirrored in the sidebar.
- **Icons: shared Publr UI set** — canonical UI artwork comes from the pinned
  [`@publr/icons`](https://github.com/publr-org/publr-icons) repository.
  `src/icons.ts` is only a compatibility adapter; social/brand artwork remains
  separate in `src/blocks/social-icons.ts` and `assets/social-icons/`.
  Definitions and setting options declare an icon NAME
  (`icon: "heading"`), chrome resolves it: imperative layers inline `iconSvg()`
  (toolbar indicator, slash picker, "+" inserter), the declarative shell
  mounts a `<symbol>` sprite once (`mountIconSprite`) and binds
  `<use href>` via `iconRef()` — PublrJS has no HTML-injection binding, so the
  bindable-attribute sprite is the declarative path. No icon → letter badge.
- **Embed layer (`attachInlineChrome` + `fields-demo.ts`)** — the
  batteries-included path: register blocks, `createEditor` per field, attach the
  shipped chrome, adapt the value. `fields-demo.ts` mounts N independent editors
  on one page (content/history/selection scoped per canvas; `editor.destroy()`
  detaches), each seeding from a `<template>` and publishing
  `editor.serialize({ pipeline: "data" })` — the CMS-submittable value. This is
  the multi-instance PublrInlineEditor case; the field-level _locking_ it's meant
  to enforce is the missing policy spine above.

## Layout

```
src/index.ts      public entry — re-exports only
src/carriers.ts   wire-contract primitives: carrier vocabulary, escaping, scoping
src/registry.ts   global block registry + the probe (render({}) → derived fields)
src/patterns.ts   global pattern registry — named block compositions, validated by expansion
src/cast.ts       upcast / downcast — annotated HTML ⇄ block model
src/format.ts     inline formatting engine — per-char mark sets + atoms, no execCommand
src/history.ts    snapshot stacks + coalescing + reactive flags (model-agnostic)
src/selection.ts  block multiselection — selectionchange mirror + reactive ids
src/tree.ts       block-tree traversal (flatten / locate / path) for nesting
src/editor.ts     createEditor — canvas, events, the commit() choke point
src/chrome-inline.ts  attachInlineChrome — shipped floating toolbar + slash + "+" inserter
src/icons.ts      thin adapter over the pinned @publr/icons UI package
src/demo.ts       full builder demo shell (registers the core blocks via the public API)
src/fields-demo.ts    embed showcase — N independent editors, one per field
src/*.css         demo/chrome styles (styles.css, chrome.css, fields.css)
vendor/publr/     vendored PublrJS .js — DO NOT EDIT (../scripts/vendor-publr.sh);
                  the *.d.ts files beside them are editor-local typings, not vendored
tests/            vp test — Vitest browser mode, real Chromium
```

## Run

```bash
npm install
npx playwright install chromium-headless-shell   # once, for vp test
npm run dev      # vp dev — demo shell at the printed URL
npm run test     # vp test — Vitest browser mode (real Chromium)
npm run build    # vp build — dist/publr-editor.js (ESM) + dist/publr-editor.iife.js (window.Publr.Editor)
```

**Manual QA** lives at `/manual.html` (same dev server): a collapsible sidebar
of human-driven tests — one per block, plus feature scenarios and, over time,
one repro per reported issue. Each test is a markdown file under
`tests/manual/` whose ` ```html ` fence seeds a pristine demo shell
(`/?fixture=<group>/<name>` — shareable). Format and conventions:
`tests/manual/README.md`.

No Python anywhere. **Source is strict TypeScript** — `npm run check`
(`vp check`) runs format + lint + full type-check (enabled via
`lint.options.typeCheck` in `vite.config.ts`); the vendored runtime is typed
by editor-local `vendor/publr/*.d.ts` declarations. Toolchain is **Vite+**
(`vp`, v0.2.x beta, MIT) — the unified Vite/Vitest/Oxlint/Oxfmt CLI from
VoidZero. One devDependency family, one `vite.config.ts`; `vp test` (Vitest
browser mode) is the intended home for the contract test suite as features
land. `npm run lint` / `npm run fmt` are wired and free.

## Constraints

- **One easily embeddable JS file** is the product (`npm run build`).
- **PublrJS is the only runtime dependency** (vendored via
  `../scripts/vendor-publr.sh` — never edit `vendor/publr/`), used for chrome
  state only (the history store); the canvas stays an uncontrolled
  contenteditable surface, never reactively rendered. KNOWN ISSUE for the
  packaging step: vendored publr.js auto-hydrates on import and claims
  `window.Publr` — bundle-vs-host runtime coexistence must be settled before
  embedding the editor in a page that runs its own PublrJS.
- **No Zig/ZSX required** — ZSX block components are Publr-side sugar that
  compiles down to this contract + API.
- **Round-trip law** — `upcast(downcast(model))` must deep-equal the model.
  Every feature added must keep it true.

## Roadmap

The build is planned as phases A–F (Shortcut epics **#289–#302**; rationale in
`../.claude/thoughts/template-fields/009-build-stages.md`). Everything below the
line is the _foundation_ that already exists; the phases stack the
template/reuse story on top.

**Foundation — done:**

1. ~~**Undo/redo**~~ (#260): snapshot history on `commit()`, reactive store,
   coalescing, selection restore, native undo disowned; browser tests.
2. ~~**Selection + block ops**~~ (#266): multiselection (drag / shift /
   cmd-click) + group delete + raw-block select. ~~**Toolbar**~~ (#274, now
   `attachInlineChrome`): move arrows, bold/italic, align-as-classes.
   Remaining: duplicate, keyboard multiselect, drag-and-drop.
3. ~~**Inserter**~~ (#281/#284/#324): slash picker + appender + `+` panel.
4. ~~**InnerBlocks / block tree**~~ (#325/#326): `data-pb-children` slots,
   recursive cast, `group` container, ⌘G/⇧⌘G.
5. ~~**Embed layer**~~ (#295/#296): `attachInlineChrome` + N-instance
   `fields-demo.ts` + value in/out (PublrInlineEditor scaffolding).

**Phases — planned (critical path A→B→D→E→F; C parallel):**

- **A** (#289, _in progress_) — the **policy/locking spine**: parse policy off
  elements, enforce editable/`allowedFormats`/movable/removable/orderable,
  `fixed`/`contentOnly` preset, template-authoritative guardrail. **The current
  focus** — A6/A7 (embed) are done, A1–A5 + A8 remain.
- **B** (#298) — `allowedBlocks` enforcement on the inserter + copy Patterns.
  **Copy patterns shipped (#388)**: `registerPattern(name, { label, content })` —
  content is a wire-contract fragment validated BY ITS EXPANSION at
  registration (registered types only, ≥2 blocks total, no carrier naming an
  undeclared field — the silent-drop drift class). `editor.insertPattern` /
  `replaceWithPattern` stamp an INDEPENDENT copy — fresh ids throughout, one
  undo entry, pure composition with no reference back (synced reuse is
  Components, E/F). Optional `data-pb-pattern` provenance round-trips as
  `block.pattern` (informational only; data pipeline strips it; chrome shows
  the pattern's label). The slash picker and `+` inserter grow a Patterns
  section (hidden inside allow-listed slots — patterns are top-level
  compositions), the demo rail a Patterns shelf; the core set lives in
  `src/blocks/core-patterns.ts` (`registerCorePatterns()`, after the blocks).
  **Pattern identity (#397) + decoupling (#421, thoughts/012)**: a stamp
  wraps its blocks in the **phantom pattern root**
  (`src/blocks/pattern-root.ts`, registry capability `phantom: true`) — a
  real node in the editor (tree row, sidebar card with a "Pattern" chip +
  the copy's Content outline, the future home of template-only options)
  that the DATA pipeline unwraps entirely: its children publish in its
  place, the wrapper never exists in output. Instances are **fully
  decoupled copies** — no sync, no pin, no update; instance-level merge
  (built in #406) was deliberately REMOVED as the partial-sync trap
  (deterministic ≠ predictable). The one instance action is **Edit
  pattern** (toolbar hook `onEditPattern` / sidebar): the shell's isolation
  mode over THIS copy's blocks, applied back via `editor.setBlockChildren`.
  Definitions are edited in the LIBRARY (flyout/explorer Edit → the same
  isolation mode; Save = `publishPattern`): versioned semver publishes —
  auto-bumped from the structural diff (removals = major, else minor),
  every superseded version archived (`getPatternContent`) — that never
  touch placed copies; versions feed the future Symbol "Update from
  Source" flow (Phase E/F). Remaining in B: B2
  `allowedBlocks:false → no inserter` and B4 locks-on-stamp (both need the
  Phase A spine).
- **C** (#299, parallel) — block settings/attributes. First slice done (#327):
  declared `settings[]` + sidebar toggle-group (heading level, container-family
  transform) on `setField`/`transformBlock`. Remaining: `data-pb-settings`
  islands as a value home (fields with no DOM carrier) + more control kinds.
- **D** (#300) — per-container scoped policy + structured patterns (nesting
  itself is already done).
- **E** (#301) — definition store + reference nodes → Reusables (`ref-all`).
- **F** (#302) — Components: `data-pb-prop` bindings, partial sync, def-edit
  mode. The hard one, last.
