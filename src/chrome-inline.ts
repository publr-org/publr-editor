// chrome-inline.ts — the DEFAULT in-canvas UI, batteries included (story
// #313). The core stays headless: nothing here runs unless the host calls
// attachInlineChrome(editor), and bundlers tree-shake the whole module when
// it goes unused. Hosts that want their own UI import just the core.
//
// What attaches, per editor instance (N instances on a page never cross):
// - "/" in an empty default block → quick block picker: the MOST-USED shelf
//   by default, live-filtered as the user keeps typing ("/gro" → Group). The
//   caret never leaves the block — the menu is driven from the document.
// - the empty default block's ghost row carries the inline + → the block
//   INSERTER (search + grid): the most-used shelf up front, search reaches
//   the full registry
// - both pickers offer a "Pattern" entry when the host provides
//   onBrowsePatterns — the escalation into the host's full pattern dialog
//   (patterns themselves never leak into the block lists)
// - the floating block toolbar: block indicator, move up/down, an alignment
//   DROPDOWN, bold/italic/link, and a policy-aware ⋮ action menu — dropdowns over inline
//   buttons on purpose: the toolbar will grow. A multi-selection swaps the
//   whole strip for the Group action. A block TYPE can declare its own
//   controls (registry `toolbar`) through one descriptor renderer. Inline
//   formats surface only while a rich carrier is active; media-level Link and
//   rich-text Link never share the strip.
// - the media placeholder: empty media blocks (image/video/audio/cover/
//   media-text/embed) grow a placeholder card — drag-drop / Upload (OPFS via
//   the /media/* worker) / Insert from URL.
//
// Styling is Tailwind utilities written as literals below — chrome.css
// (imported here) compiles them into dist/publr-editor.css, the lib's one
// CSS artifact. These are raw-HTML versions of Publr design-system recipes:
// semantic token colors, 8px surfaces, quiet borders, and compact controls.
//
// Two behavioral laws carried over from the demos (both were re-discovered
// the hard way — see story #313):
// - The slash check rides MODEL changes only, never selectionchange: an
//   Escape-refocused caret sitting in a block that still reads "/" must not
//   reopen the menu it just closed.
// - Chrome swallows mousedown (except the inserter's search field) so
//   clicking a control never blurs the carrier or collapses the text
//   selection it is about to act on.

import { effect } from "../vendor/publr/publr.js";
import type { FieldValue } from "./carriers";
import type { Editor } from "./editor";
import { iconSvg } from "./icons";
import { mediaStoreSupported, putMedia } from "./media-store";
import { getPattern, PATTERN_ROOT_TYPE } from "./patterns";
import { blockTypes, getBlockType } from "./registry";
import type { ToolbarSpec } from "./registry";
import { locateBlock } from "./tree";
// The stylesheet behind the class literals below. The lib build extracts it
// into dist/publr-editor.css (the emitted JS carries no CSS import).
import "./chrome.css";

export interface InlineChromeOptions {
  /**
   * Positioned ancestor the floating UI parks in (defaults to the canvas's
   * parent; given position:relative when static).
   */
  container?: HTMLElement;
  /** "/" quick picker (default true). */
  slash?: boolean;
  /** Inline + inserter on the empty default block's ghost row (default true). */
  inserter?: boolean;
  /**
   * Renders a "Browse all" footer in the + inserter panel — the escalation
   * slot for hosts that have a bigger block library (the demo shell opens
   * its library rail). Called with the block the panel targeted, which the
   * host should treat as the insertion anchor (familiar block-editor semantics:
   * an empty default block gets REPLACED by the eventual pick).
   */
  onBrowseAll?: (targetId: string | null) => void;
  /**
   * Renders a "Pattern" entry in the "/" quick picker and the + inserter
   * grid — the escalation into the host's FULL pattern selection dialog
   * (the demo shell opens its pattern explorer). Called with the block the
   * picker targeted; the host should treat it as the insertion anchor (an
   * empty default block gets REPLACED by the eventual pick). Absent = no
   * entry, the pickers stay blocks-only.
   */
  onBrowsePatterns?: (targetId: string | null) => void;
  /** Floating block toolbar (default true). */
  toolbar?: boolean;
  /**
   * Renders an "Edit pattern" button in the toolbar's pattern strip — the
   * hook for hosts with an isolation-editing mode over THIS COPY's blocks
   * (instances are fully decoupled; thoughts/012). Absent = no strip.
   */
  onEditPattern?: (name: string, blockId: string) => void;
  /**
   * Placeholder card on media blocks whose primary media is empty
   * (drag-drop / Upload / Insert from URL), injected next to the empty
   * carrier — canvas chrome only, serialize never sees it (default true).
   */
  mediaPlaceholder?: boolean;
}

// --- class vocabulary (literals — the Tailwind scanner reads this file) ------

const BTN =
  "flex h-9 min-w-9 cursor-pointer items-center justify-center gap-0.5 rounded-md px-1.5 text-sm font-semibold text-foreground hover:bg-ui-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
// `pbe-ui` so a hidden segment actually collapses: the .flex here would beat
// the UA [hidden] rule, and only .pbe-ui[hidden] (chrome.css, unlayered) wins.
const SEGMENT = "pbe-ui flex items-stretch gap-0.5 border-r border-border p-1 last:border-r-0";
const PANEL =
  "pbe-ui absolute z-40 min-w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg";
const PANEL_LABEL = "block px-2 py-1.5 text-xs font-semibold text-muted-foreground";
const ITEM =
  "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium text-popover-foreground hover:bg-ui-accent hover:text-accent-foreground focus-visible:bg-ui-accent focus-visible:text-accent-foreground focus-visible:outline-none disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
// The current choice inside a menu (e.g. the active alignment) — the
// conventional accent ring on the selected item.
const ITEM_ACTIVE = "shadow-[inset_0_0_0_1.5px_var(--color-pbe-accent)]";
// A toggled-on toolbar button (bold while bold): a solid dark fill.
// Conflicting utilities SWAP, never stack (same layer + specificity means
// stylesheet order would decide, and text-zinc-900 happens to out-sort
// text-white) — the on-state removes the base color/hover classes.
const BTN_ON = ["bg-ui-accent", "text-accent-foreground"];
const BTN_ON_SWAPS = ["text-foreground", "hover:bg-ui-accent"];

// --- icons -------------------------------------------------------------------

const stroke = (paths: string) =>
  `<svg class="h-[15px] w-[15px]" viewBox="0 0 16 16" fill="none" aria-hidden="true">${paths}</svg>`;
const line = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`;

const ICON_UP = iconSvg("chevron-up");
const ICON_DOWN = iconSvg("chevron-down");
const ICON_CHEVRON = iconSvg("chevron-down", "h-4 w-4");
const ICON_MORE = iconSvg("more");
const ICON_PLUS = iconSvg("plus", "h-5 w-5");
const ICON_GROUP = iconSvg("group-blocks", "h-5 w-5");
const ICON_UNGROUP = iconSvg("ungroup", "h-5 w-5");
const ICON_LINK = iconSvg("link");
const ICON_CAPTION = iconSvg("caption");

const ALIGNMENTS = [
  {
    key: "left",
    label: "Align text left",
    icon: stroke(line("M1 3.5h14") + line("M1 8h8") + line("M1 12.5h11")),
  },
  {
    key: "center",
    label: "Align text center",
    icon: stroke(line("M1 3.5h14") + line("M4 8h8") + line("M2.5 12.5h11")),
  },
  {
    key: "right",
    label: "Align text right",
    icon: stroke(line("M1 3.5h14") + line("M7 8h8") + line("M4 12.5h11")),
  },
];

// Block badges for the picker/inserter/indicator: the definition's declared
// icon name resolved against the shared set (src/icons.ts, self-contained
// inline SVG — this layer is imperative, no sprite needed); types without
// one fall back to their initial. Returns MARKUP — callers inject via h().
const badgeOf = (type: string): string => {
  const name = getBlockType(type)?.icon ?? (type === "raw-html" ? "html" : undefined);
  return (name && iconSvg(name, "h-5 w-5")) || (type[0] ?? "?").toUpperCase();
};

// --- small DOM helpers ---------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (html != null) el.innerHTML = html;
  return el;
}

function button(className: string, html: string, title?: string): HTMLButtonElement {
  const b = h("button", className, html);
  b.type = "button";
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  return b;
}

const setOn = (btn: HTMLButtonElement, on: boolean) => {
  BTN_ON.forEach((c) => btn.classList.toggle(c, on));
  BTN_ON_SWAPS.forEach((c) => btn.classList.toggle(c, !on));
};

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

// A reusable URL + open-in-new-tab popover, driven per open() by the caller's
// current value and apply/remove callbacks — shared by the block-level media
// link and the inline rich-text link (each supplies its own read/write).
interface LinkPopover {
  el: HTMLElement;
  open: (
    trigger: HTMLElement,
    opts: {
      href: string;
      target: string;
      canRemove: boolean;
      onApply: (href: string, target: string) => void;
      onRemove: () => void;
    },
  ) => void;
}

/**
 * Attach the default in-canvas UI to an editor instance. Everything is
 * scoped to that instance; returns a detach function that removes the UI and
 * all document-level listeners.
 */
export function attachInlineChrome(editor: Editor, options: InlineChromeOptions = {}): () => void {
  const withSlash = options.slash ?? true;
  const withInserter = options.inserter ?? true;
  const withToolbar = options.toolbar ?? true;
  const withMediaPlaceholder = options.mediaPlaceholder ?? true;

  const canvas = editor.canvas;
  const host = options.container ?? canvas.parentElement;
  if (!host) throw new Error("PublrEditor: attachInlineChrome needs a positioned container");
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  canvas.classList.add("pbe-canvas"); // scope hook for the shipped canvas-owned CSS

  let detached = false;
  const disposers: (() => void)[] = [];
  const mounted: HTMLElement[] = [];
  const mount = <T extends HTMLElement>(el: T): T => {
    host.appendChild(el);
    mounted.push(el);
    return el;
  };
  const listen = <K extends keyof DocumentEventMap>(
    type: K,
    fn: (e: DocumentEventMap[K]) => void,
  ) => {
    document.addEventListener(type, fn);
    disposers.push(() => document.removeEventListener(type, fn));
  };

  const rootOf = (id: string) =>
    canvas.querySelector<HTMLElement>(`[data-pb-id="${CSS.escape(id)}"]`);

  const plainText = (html: FieldValue | undefined): string => {
    const d = document.createElement("div");
    d.innerHTML = typeof html === "string" ? html : "";
    return d.textContent ?? "";
  };

  // Escape from a block-anchored panel: put the caret back at the end.
  const refocusCarrier = (id: string) => {
    const root = rootOf(id);
    const carrier =
      root &&
      (root.matches("[data-pb-rich],[data-pb-text]")
        ? root
        : root.querySelector<HTMLElement>("[data-pb-rich],[data-pb-text]"));
    if (!carrier) return;
    carrier.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(carrier);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  // Park `el` against the host at viewport coords (top/left in px).
  const park = (el: HTMLElement, top: number, left: number) => {
    const fr = host.getBoundingClientRect();
    el.style.top = `${top - fr.top}px`;
    el.style.left = `${Math.max(0, left - fr.left)}px`;
  };

  // The scrolling ancestor the sticky toolbar clamps against — the canvas
  // viewport, not the whole page. Null when nothing above host scrolls (the
  // toolbar then just floats above its block, no sticking needed).
  const scrollParent = (el: HTMLElement): HTMLElement | null => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === "auto" || oy === "scroll") return p;
    }
    return null;
  };
  const scroller = scrollParent(host);
  const STICKY_GAP = 10; // toolbar-to-block breathing room while floating above
  const STICKY_MARGIN = 8; // gap from the viewport top once stuck

  // Linear keyboard nav shared by every menu-shaped panel.
  const wireMenuKeys = (panel: HTMLElement, onEscape: () => void) =>
    panel.addEventListener("keydown", (e) => {
      const items = [...panel.querySelectorAll<HTMLButtonElement>("button:not([hidden])")].filter(
        (b) => !b.disabled,
      );
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next =
          e.key === "ArrowDown"
            ? cur < items.length - 1
              ? cur + 1
              : 0
            : cur > 0
              ? cur - 1
              : items.length - 1;
        items[next]?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onEscape();
      }
    });

  // ONE floating surface open at a time, across all parts of this instance.
  type Panel = { el: HTMLElement; onClose?: () => void };
  let openPanel: Panel | null = null;
  function showPanel(p: Panel) {
    closePanel();
    openPanel = p;
    p.el.hidden = false;
  }
  function closePanel() {
    if (!openPanel) return;
    const p = openPanel;
    openPanel = null;
    p.el.hidden = true;
    p.onClose?.();
  }

  // The block an open picker/inserter targets — picking TRANSFORMS it
  // (familiar block-editor semantics: replace the empty/"/" default block).
  let targetId: string | null = null;

  const pickBlock = (type: string) => {
    const id = targetId;
    targetId = null;
    closePanel();
    if (id && editor.getBlock(id)) editor.replaceBlock(id, type); // focuses the fresh block
  };

  // Inserter hygiene (story #370): the pickers offer what the TARGET's slot
  // takes — a declared allowedChildren list verbatim (internal types
  // included: inside an accordion the item IS the offering), otherwise every
  // non-internal type. Mirrors the replaceBlock slot gate, so nothing listed
  // ever no-ops, and parent-scoped types (list-item, column, accordion-item,
  // social-link) never leak into a foreign context. Patterns are deliberately
  // NOT offered here — they are compositions, not blocks, and live in the
  // host's Patterns surface (demo: the rail's Patterns tab + explorer).
  const parentIdOf = (id: string | null) =>
    (id ? locateBlock(editor.getModel().blocks, id)?.parent?.id : null) ?? null;
  const pickerTypes = (id: string | null) => {
    const parentId = parentIdOf(id);
    // Nested slot → block-def allowedChildren ∩ slot policy (D2); ROOT → the
    // editor's allowedBlocks policy (B2). Both via canInsertInto so the picker
    // never offers a type the primitive would refuse. Empty at root → inserter hidden.
    return blockTypes().filter(
      (b) => (parentId || !b.internal) && editor.canInsertInto(parentId, b.type),
    );
  };

  // The pickers' DEFAULT shelf: FIVE most-used types (a most-used list),
  // topped up from the slot's offering when some aren't available — the
  // "Pattern" entry leads the shelf, making six rows total. Search/typing
  // reaches the full offering — this only curates the resting state so
  // neither picker opens as a 40-block wall.
  const MOST_USED = ["paragraph", "heading", "image", "quote", "list", "group"];
  const QUICK_LIMIT = 5;
  const mostUsedOf = <T extends { type: string }>(types: T[]): T[] => {
    const picks = MOST_USED.map((t) => types.find((b) => b.type === t)).filter((b): b is T => !!b);
    for (const b of types) {
      if (picks.length >= QUICK_LIMIT) break;
      if (!picks.includes(b)) picks.push(b);
    }
    return picks.slice(0, QUICK_LIMIT);
  };

  // ---------------------------------------------------------------------------
  // "/" quick picker
  // ---------------------------------------------------------------------------

  const quick = withSlash ? mount(h("div", `${PANEL} pbe-quick`)) : null;

  // The caret STAYS in the block while the menu is up (typing keeps
  // filtering), so "active item" is a highlight the document-level keys move,
  // not focus. Same swap-not-stack rule as BTN_ON.
  const QUICK_ON = ["bg-ui-accent", "text-accent-foreground"];
  const QUICK_ON_SWAPS = ["text-foreground", "hover:bg-ui-accent"];
  let quickItems: HTMLButtonElement[] = [];
  let quickActive = 0;
  const setQuickActive = (i: number) => {
    quickActive = i;
    quickItems.forEach((el, j) => {
      QUICK_ON.forEach((c) => el.classList.toggle(c, j === i));
      QUICK_ON_SWAPS.forEach((c) => el.classList.toggle(c, j !== i));
    });
  };

  // The quick picker's "Pattern" pick: consume the slash command (the
  // explorer's eventual pick must find an EMPTY default block to replace),
  // then escalate to the host's full pattern dialog.
  const browsePatternsFromQuick = () => {
    const id = targetId;
    targetId = null;
    closePanel();
    if (!id) return;
    const block = editor.getBlock(id);
    const field =
      block && getBlockType(block.type)?.fields.find((f) => f.type === "rich" || f.type === "text");
    if (block && field && plainText(block.fields[field.name]).trim().startsWith("/"))
      editor.setField(id, field.name, "");
    options.onBrowsePatterns!(id);
  };

  if (quick) {
    quick.hidden = true;
    quick.setAttribute("role", "menu");
    quick.addEventListener("mousedown", (e) => e.preventDefault());
    quick.addEventListener("click", (e) => {
      const item =
        e.target instanceof Element
          ? e.target.closest<HTMLButtonElement>("button[data-type], button[data-browse-patterns]")
          : null;
      if (!item) return;
      if (item.dataset.browsePatterns) browsePatternsFromQuick();
      else pickBlock(item.dataset.type!);
    });
    // Menu keys ride the DOCUMENT (capture): focus is in the carrier, and the
    // canvas's own Enter/arrow handling must never see these strokes.
    const onQuickKeys = (e: KeyboardEvent) => {
      if (openPanel?.el !== quick) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = quickItems.length;
        if (n)
          setQuickActive(e.key === "ArrowDown" ? (quickActive + 1) % n : (quickActive + n - 1) % n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        quickItems[quickActive]?.click();
      } else if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        targetId = null;
        closePanel(); // the caret never left the block — nothing to refocus
      }
    };
    document.addEventListener("keydown", onQuickKeys, true);
    disposers.push(() => document.removeEventListener("keydown", onQuickKeys, true));
  }

  // (Re)build the menu for the text typed after "/": empty query = the
  // most-used shelf, anything else filters the slot's full offering. Returns
  // false when nothing matches (the caller closes the panel).
  function buildQuickItems(q: string): boolean {
    if (!quick || !targetId) return false;
    const query = q.trim().toLowerCase();
    const types = pickerTypes(targetId);
    const list = (
      query
        ? types.filter((b) => b.type.includes(query) || b.label.toLowerCase().includes(query))
        : mostUsedOf(types)
    ).slice(0, QUICK_LIMIT);
    // "Pattern" rides along while it matches the query — it opens the host's
    // full pattern dialog, it is not a block.
    const withPatterns = !!options.onBrowsePatterns && (!query || "patterns".includes(query));
    quick.textContent = "";
    quickItems = [];
    if (!list.length && !withPatterns) return false;
    // Pattern LEADS the menu — the composition escalation before the blocks.
    if (withPatterns) {
      quick.appendChild(h("span", PANEL_LABEL, "Patterns"));
      const item = button(ITEM, "", undefined);
      item.dataset.browsePatterns = "1";
      item.setAttribute("role", "menuitem");
      item.append(
        h(
          "span",
          "flex h-5 w-5 items-center justify-center font-bold",
          iconSvg("pattern", "h-5 w-5") || "P",
        ),
        "Pattern",
      );
      quick.appendChild(item);
      quickItems.push(item);
    }
    if (list.length) quick.appendChild(h("span", PANEL_LABEL, "Blocks"));
    for (const b of list) {
      const item = button(ITEM, "", undefined);
      item.dataset.type = b.type;
      item.setAttribute("role", "menuitem");
      item.append(
        h("span", "flex h-5 w-5 items-center justify-center font-bold", badgeOf(b.type)),
        b.label,
      );
      quick.appendChild(item);
      quickItems.push(item);
    }
    setQuickActive(0);
    return true;
  }

  function openQuick(id: string) {
    const root = quick && rootOf(id);
    if (!quick || !root) return;
    targetId = id;
    if (!buildQuickItems("")) {
      targetId = null; // B2: nothing insertable here → no picker
      return;
    }
    const rr = root.getBoundingClientRect();
    park(quick, rr.bottom + 6, rr.left);
    showPanel({ el: quick });
    // focus stays in the carrier — syncSlash refilters as typing continues
  }

  // ---------------------------------------------------------------------------
  // + appender → block inserter (search + grid)
  // ---------------------------------------------------------------------------

  const inserter = withInserter
    ? mount(
        h(
          "div",
          "pbe-ui pbe-inserter absolute z-40 w-[300px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg",
        ),
      )
    : null;
  const search = h(
    "input",
    "pbe-search m-3 mb-1 block w-[calc(100%-24px)] rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25",
  );
  const grid = h("div", "pbe-grid grid grid-cols-3 gap-1 px-2 pt-2 pb-3");
  const noResults = h(
    "div",
    "pbe-noresults px-3 pt-1 pb-4 text-center text-[13px] text-muted-foreground",
    "No blocks found",
  );
  const browseAll = options.onBrowseAll
    ? button(
        "pbe-browseall block w-full cursor-pointer border-t border-border bg-primary p-3 text-center text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring",
        "Browse all",
      )
    : null;
  const appender = mount(
    button(
      "pbe-ui pbe-appender absolute z-30 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      ICON_PLUS,
      "Add block",
    ),
  );
  appender.hidden = true;
  const spacerHandle = mount(
    button(
      "pbe-ui pbe-spacer-handle absolute z-30 h-3 w-12 cursor-ns-resize rounded-full border border-input bg-background shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      "",
      "Resize spacer",
    ),
  );
  spacerHandle.hidden = true;

  spacerHandle.addEventListener("pointerdown", (event) => {
    const id = spacerHandle.dataset.target;
    const root = id ? rootOf(id) : null;
    if (!id || !root || !editor.canStyle(id)) return;
    event.preventDefault();
    spacerHandle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = root.getBoundingClientRect().height;
    const originalHeight = root.style.height;
    let nextHeight = Math.max(8, Math.round(startHeight));
    const move = (moveEvent: PointerEvent) => {
      nextHeight = Math.max(8, Math.round(startHeight + moveEvent.clientY - startY));
      root.style.height = `${nextHeight}px`;
      syncSpacerResizer();
    };
    const finish = () => {
      spacerHandle.removeEventListener("pointermove", move);
      spacerHandle.removeEventListener("pointerup", finish);
      spacerHandle.removeEventListener("pointercancel", finish);
      root.style.height = originalHeight;
      editor.setStyle(id, "height", `${nextHeight}px`);
    };
    spacerHandle.addEventListener("pointermove", move);
    spacerHandle.addEventListener("pointerup", finish);
    spacerHandle.addEventListener("pointercancel", finish);
  });

  if (inserter) {
    inserter.hidden = true;
    search.type = "text";
    search.placeholder = "Search";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Search for blocks");
    noResults.hidden = true;
    inserter.append(search, grid, noResults);
    if (browseAll) {
      inserter.append(browseAll);
      browseAll.addEventListener("click", () => {
        const id = targetId;
        targetId = null;
        closePanel();
        options.onBrowseAll!(id);
      });
    }

    const gridItems = () => [...grid.querySelectorAll<HTMLButtonElement>("button[data-type]")];
    const visibleItems = () => gridItems().filter((el) => !el.hidden);
    // Resting state = the most-used shelf (data-quick rows); a query searches
    // the FULL offering — every type is in the DOM, filtering just unhides.
    const filterGrid = () => {
      const q = search.value.trim().toLowerCase();
      for (const el of gridItems())
        el.hidden = q
          ? !el.dataset.type!.includes(q) && !el.dataset.label!.includes(q)
          : el.dataset.quick !== "1";
      noResults.hidden = visibleItems().length > 0;
    };
    // One routing for click/Enter: the "Pattern" tile escalates to the host's
    // full pattern dialog; everything else is a block pick.
    const chooseGridItem = (item: HTMLButtonElement) => {
      if (item.dataset.browsePatterns) {
        const id = targetId;
        targetId = null;
        closePanel();
        options.onBrowsePatterns!(id);
      } else {
        pickBlock(item.dataset.type!);
      }
    };

    search.addEventListener("input", filterGrid);
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const first = visibleItems()[0];
        if (first) chooseGridItem(first);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        visibleItems()[0]?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        const id = targetId;
        targetId = null;
        closePanel();
        if (id) refocusCarrier(id);
      }
    });
    grid.addEventListener("click", (e) => {
      const item =
        e.target instanceof Element
          ? e.target.closest<HTMLButtonElement>("button[data-type]")
          : null;
      if (item) chooseGridItem(item);
    });
    grid.addEventListener("keydown", (e) => {
      const items = visibleItems();
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"];
      if (keys.includes(e.key)) {
        e.preventDefault();
        const fwd = e.key === "ArrowDown" || e.key === "ArrowRight";
        if (fwd) items[cur < items.length - 1 ? cur + 1 : 0]?.focus();
        else if (cur > 0) items[cur - 1].focus();
        else search.focus(); // past the top: back to the search box
      } else if (e.key === "Escape") {
        e.preventDefault();
        const id = targetId;
        targetId = null;
        closePanel();
        if (id) refocusCarrier(id);
      }
    });

    appender.addEventListener("mousedown", (e) => e.preventDefault());
    appender.addEventListener("click", () => {
      const id = appender.dataset.target;
      if (!id || !editor.getBlock(id)) return;
      targetId = id;
      search.value = "";
      grid.textContent = "";
      const GRID_ITEM =
        "flex cursor-pointer flex-col items-center gap-2 rounded-md px-1 pt-3.5 pb-2.5 text-[13px] font-medium text-popover-foreground hover:bg-ui-accent hover:text-accent-foreground focus-visible:bg-ui-accent focus-visible:outline-none";
      // the "Pattern" tile LEADS the shelf — the composition escalation
      // before the blocks; it opens the host's full pattern dialog
      if (options.onBrowsePatterns) {
        const item = button(GRID_ITEM, "");
        item.dataset.type = "pattern"; // filter vocabulary only — never inserted
        item.dataset.label = "pattern";
        item.dataset.quick = "1";
        item.dataset.browsePatterns = "1";
        item.append(
          h("span", "text-lg leading-none font-bold", iconSvg("pattern", "h-5 w-5") || "P"),
          "Pattern",
        );
        grid.appendChild(item);
      }
      // then the most-used shelf (the resting view), the rest behind the search
      const types = pickerTypes(id);
      const quickShelf = mostUsedOf(types);
      const shelf = new Set(quickShelf.map((b) => b.type));
      const ordered = [...quickShelf, ...types.filter((b) => !shelf.has(b.type))];
      for (const b of ordered) {
        const item = button(GRID_ITEM, "");
        item.dataset.type = b.type;
        item.dataset.label = b.label.toLowerCase();
        if (shelf.has(b.type)) item.dataset.quick = "1";
        item.append(h("span", "text-lg leading-none font-bold", badgeOf(b.type)), b.label);
        grid.appendChild(item);
      }
      filterGrid();
      const ar = appender.getBoundingClientRect();
      const fr = host.getBoundingClientRect();
      inserter.hidden = false; // measurable before parking
      inserter.style.top = `${ar.bottom - fr.top + 6}px`;
      inserter.style.left = `${Math.max(0, ar.right - fr.left - inserter.offsetWidth)}px`;
      showPanel({ el: inserter });
      search.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // floating block toolbar
  // ---------------------------------------------------------------------------

  const toolbar = withToolbar
    ? mount(
        h(
          "div",
          "pbe-ui pbe-toolbar absolute z-30 flex items-stretch rounded-lg border border-border bg-popover text-popover-foreground shadow-lg",
        ),
      )
    : null;

  // built below when withToolbar; declared here so syncs can reference them
  let indicator!: HTMLElement;
  let segShell!: HTMLElement;
  let btnUp!: HTMLButtonElement;
  let btnDown!: HTMLButtonElement;
  let segFormat!: HTMLElement;
  let btnBold!: HTMLButtonElement;
  let btnItalic!: HTMLButtonElement;
  let btnFmtLink!: HTMLButtonElement; // inline link over selected rich text
  // Every block-owned control is generated into this segment from descriptors.
  let segChoices!: HTMLElement;
  let segOther!: HTMLElement;
  let linkPopover!: LinkPopover;
  let buildReplacePanel!: (panel: HTMLElement, id: string, field: string) => void;
  let moreTrigger!: HTMLButtonElement;
  let segMore!: HTMLElement;
  let morePanel!: HTMLElement;
  let itemConvertPattern!: HTMLButtonElement;
  let itemUngroup!: HTMLButtonElement;
  let itemDuplicate!: HTMLButtonElement;
  let itemRemove!: HTMLButtonElement;
  let singleStrip!: HTMLElement;
  let multiStrip!: HTMLElement;
  let segPattern!: HTMLElement;
  let btnEditPattern!: HTMLButtonElement;
  let toolbarId: string | null = null; // the block the toolbar currently rides
  let toolbarPatternId: string | null = null;
  let toolbarPatternName: string | null = null;
  // The block the toolbar is anchored to for POSITIONING. Same as toolbarId for
  // a single selection, but a multi-selection (toolbarId null) still rides the
  // first block's box — the sticky reposition on scroll needs this either way.
  let toolbarAnchorId: string | null = null;

  if (toolbar) {
    toolbar.hidden = true;
    toolbar.addEventListener("mousedown", (e) => e.preventDefault());

    singleStrip = h("div", "pbe-ui flex items-stretch");
    multiStrip = h("div", "pbe-ui flex items-stretch");
    toolbar.append(singleStrip, multiStrip);

    // segment 1: block indicator + movers
    segShell = h("div", SEGMENT);
    indicator = h(
      "span",
      "flex h-9 min-w-9 items-center justify-center px-1 text-[15px] font-bold text-foreground",
    );
    btnUp = button(BTN, ICON_UP, "Move up");
    btnDown = button(BTN, ICON_DOWN, "Move down");
    btnUp.addEventListener("click", () => toolbarId && editor.moveBlock(toolbarId, -1));
    btnDown.addEventListener("click", () => toolbarId && editor.moveBlock(toolbarId, 1));
    segShell.append(indicator, btnUp, btnDown);

    // pattern segment: a block carrying pattern provenance is a fully
    // DECOUPLED copy (thoughts/012) — the strip offers exactly one thing:
    // "Edit pattern", editing THIS copy in the host's isolation mode (there
    // is no "source" from the instance's point of view).
    segPattern = h("div", SEGMENT);
    segPattern.hidden = true;
    btnEditPattern = button(`${BTN} px-2 whitespace-nowrap`, "Edit pattern");
    btnEditPattern.addEventListener("click", () => {
      if (toolbarPatternName && toolbarPatternId)
        options.onEditPattern!(toolbarPatternName, toolbarPatternId);
    });
    if (options.onEditPattern) segPattern.append(btnEditPattern);

    // Inline formats (bold / italic / link over the text selection).
    segFormat = h("div", SEGMENT);
    btnBold = button(BTN, iconSvg("bold", "h-5 w-5"), "Bold");
    btnItalic = button(BTN, iconSvg("italic", "h-5 w-5"), "Italic");
    btnFmtLink = button(BTN, ICON_LINK, "Link");
    const fmt = (cmd: string) => {
      editor.format(cmd);
      syncToolbar();
    };
    btnBold.addEventListener("click", () => fmt("bold"));
    btnItalic.addEventListener("click", () => fmt("italic"));
    // Inline link over the selected rich text. Focusing the popover's URL
    // input replaces the document selection, so the caption range is SAVED at
    // click time and restored (carrier refocused) before applyLink reads it.
    btnFmtLink.addEventListener("click", () => {
      const sel = window.getSelection();
      const saved = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const restore = () => {
        if (!saved) return;
        const c = saved.commonAncestorContainer;
        const carrier = (c instanceof Element ? c : c.parentElement)?.closest<HTMLElement>(
          "[data-pb-rich]",
        );
        carrier?.focus({ preventScroll: true });
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(saved);
      };
      const cur = editor.linkState();
      linkPopover.open(btnFmtLink, {
        href: cur?.href ?? "",
        target: cur?.target ?? "",
        canRemove: !!cur,
        onApply: (href, target) => {
          restore();
          editor.applyLink(href, target);
        },
        onRemove: () => {
          restore();
          editor.applyLink("", "");
        },
      });
    });
    segFormat.append(btnBold, btnItalic, btnFmtLink);

    // One segment for every block-owned descriptor control.
    linkPopover = createLinkPopover();
    segChoices = h("div", "pbe-ui flex items-stretch");
    segChoices.hidden = true;
    segOther = h("div", "pbe-ui flex items-stretch");
    segOther.hidden = true;

    // segment 4: ⋮ options menu — the growth point for future block actions
    segMore = h("div", SEGMENT);
    moreTrigger = button(BTN, ICON_MORE, "Options");
    moreTrigger.setAttribute("aria-haspopup", "menu");
    moreTrigger.setAttribute("aria-expanded", "false");
    segMore.append(moreTrigger);
    morePanel = mount(h("div", `${PANEL} pbe-more`));
    morePanel.hidden = true;
    morePanel.setAttribute("role", "menu");
    itemConvertPattern = button(ITEM, "", "Convert to blocks");
    itemConvertPattern.setAttribute("role", "menuitem");
    itemConvertPattern.append(
      h("span", "flex h-5 w-5 items-center justify-center", ICON_UNGROUP),
      "Convert to blocks",
    );
    itemConvertPattern.addEventListener("click", () => {
      closePanel();
      if (toolbarId) editor.convertPatternToBlocks(toolbarId);
    });
    itemUngroup = button(ITEM, "", "Ungroup (⇧⌘G)");
    itemUngroup.setAttribute("role", "menuitem");
    itemUngroup.append(
      h("span", "flex h-5 w-5 items-center justify-center", ICON_UNGROUP),
      "Ungroup",
    );
    itemUngroup.addEventListener("click", () => {
      closePanel();
      editor.ungroupBlock(toolbarId ?? undefined);
    });
    itemDuplicate = button(ITEM, "", "Duplicate");
    itemDuplicate.setAttribute("role", "menuitem");
    itemDuplicate.append(
      h("span", "flex h-5 w-5 items-center justify-center", iconSvg("duplicate", "h-5 w-5")),
      "Duplicate",
    );
    itemDuplicate.addEventListener("click", () => {
      closePanel();
      if (toolbarId) editor.duplicateBlock(toolbarId);
    });
    itemRemove = button(ITEM, "", "Remove");
    itemRemove.setAttribute("role", "menuitem");
    itemRemove.append(
      h("span", "flex h-5 w-5 items-center justify-center", iconSvg("trash", "h-5 w-5")),
      "Remove",
    );
    itemRemove.addEventListener("click", () => {
      closePanel();
      if (toolbarId) editor.removeBlock(toolbarId);
    });
    morePanel.append(itemConvertPattern, itemUngroup, itemDuplicate, itemRemove);

    singleStrip.append(segShell, segPattern, segChoices, segFormat, segOther, segMore);

    // multi-selection strip: the Group action
    const segMulti = h("div", SEGMENT);
    const btnGroup = button(`${BTN} px-2`, "", "Group (⌘G)");
    btnGroup.append(h("span", "flex h-5 w-5 items-center justify-center", ICON_GROUP), "Group");
    btnGroup.addEventListener("click", () => void editor.groupBlocks());
    segMulti.append(btnGroup);
    multiStrip.append(segMulti);

    // dropdown plumbing: panels swallow mousedown (the carrier/selection must
    // survive), Escape returns focus to the trigger
    for (const [trigger, panel] of [[moreTrigger, morePanel]] as const) {
      panel.addEventListener("mousedown", (e) => e.preventDefault());
      wireMenuKeys(panel, () => {
        closePanel();
        trigger.focus();
      });
      trigger.addEventListener("click", () => {
        if (openPanel?.el === panel) {
          closePanel();
          return;
        }
        const tr = trigger.getBoundingClientRect();
        park(panel, tr.bottom + 6, tr.left);
        showPanel({ el: panel, onClose: () => trigger.setAttribute("aria-expanded", "false") });
        trigger.setAttribute("aria-expanded", "true");
        panel.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
      });
    }

    // Escape anywhere in the strip: caret back into the block.
    toolbar.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !openPanel && toolbarId) refocusCarrier(toolbarId);
    });

    // Rebuild the Replace dropdown for the current media field: Upload / Insert
    // from URL / Reset, plus the current source. Reuses uploadTo/uploadsReady
    // (the media plumbing the empty-block placeholder uses, defined below).
    buildReplacePanel = (panel: HTMLElement, id: string, field: string): void => {
      const block = editor.getBlock(id);
      if (!block) return;
      const cur = block.fields[field];
      const value =
        cur && typeof cur === "object" ? cur : { src: "", alt: "", width: "", height: "" };
      panel.textContent = "";

      if (uploadsReady()) {
        const up = h("label", `${ITEM} cursor-pointer`);
        up.innerHTML = `<span class="flex h-5 w-5 items-center justify-center">${iconSvg("image", "h-5 w-5")}</span>Upload<input type="file" class="hidden">`;
        const fileInput = up.querySelector<HTMLInputElement>("input")!;
        fileInput.addEventListener("change", () => {
          const file = fileInput.files?.[0];
          fileInput.value = "";
          closePanel();
          if (file) void uploadTo(id, field, file);
        });
        panel.appendChild(up);
      }

      const urlBtn = button(ITEM, "");
      urlBtn.append(
        h("span", "flex h-5 w-5 items-center justify-center", iconSvg("globe", "h-5 w-5")),
        "Insert from URL",
      );
      const urlForm = h("form", "mt-1 mb-1 flex items-center gap-1.5 px-1");
      urlForm.hidden = true;
      const urlInput = h(
        "input",
        "h-10 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25",
      ) as HTMLInputElement;
      urlInput.type = "text";
      urlInput.placeholder = "Paste or type URL";
      const urlApply = button(
        "flex h-10 min-w-10 cursor-pointer items-center justify-center rounded-lg bg-primary px-2 text-sm font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "↵",
        "Apply",
      );
      urlApply.type = "submit";
      urlForm.append(urlInput, urlApply);
      urlBtn.addEventListener("click", () => {
        urlForm.hidden = !urlForm.hidden;
        if (!urlForm.hidden) {
          urlInput.value = value.src;
          urlInput.focus();
        }
      });
      urlForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const src = urlInput.value.trim();
        closePanel();
        // external source: intrinsic dims unknown — cleared, not stale
        editor.setField(id, field, { src, alt: value.alt, width: "", height: "" });
      });
      panel.append(urlBtn, urlForm);

      const reset = button(ITEM, "");
      reset.append(
        h("span", "flex h-5 w-5 items-center justify-center", iconSvg("reset", "h-5 w-5")),
        "Reset",
      );
      reset.disabled = !value.src;
      reset.addEventListener("click", () => {
        closePanel();
        editor.setField(id, field, { src: "", alt: value.alt, width: "", height: "" });
      });
      panel.appendChild(reset);

      if (value.src) {
        const meta = h("div", "mt-1.5 border-t border-border px-2.5 pt-2");
        meta.append(h("span", PANEL_LABEL + " px-0", "Current media URL"));
        const link = h(
          "a",
          "block truncate text-[13px] text-pbe-accent underline",
        ) as HTMLAnchorElement;
        link.href = value.src;
        link.textContent = value.src;
        link.target = "_blank";
        link.rel = "noopener";
        meta.appendChild(link);
        panel.appendChild(meta);
      }
    };

    // The shared link popover — factory here so its DOM/handlers live with the
    // rest of the toolbar wiring (referenced above by both link buttons).
    function createLinkPopover(): LinkPopover {
      const el = mount(h("div", `${PANEL} pbe-link w-80`));
      el.hidden = true;
      el.setAttribute("role", "dialog");
      const form = h("form", "flex items-center gap-1.5");
      const input = h(
        "input",
        "h-10 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25",
      ) as HTMLInputElement;
      input.type = "text";
      input.placeholder = "Paste URL or type…";
      const apply = button(
        "flex h-10 min-w-10 cursor-pointer items-center justify-center rounded-lg bg-primary px-2 text-sm font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "↵",
        "Apply",
      );
      apply.type = "submit";
      form.append(input, apply);
      const newTabRow = h(
        "label",
        "mt-2.5 flex cursor-pointer items-center gap-2 px-1 text-sm text-muted-foreground",
      );
      const newTab = h("input", "size-4 accent-[var(--color-pbe-accent)]") as HTMLInputElement;
      newTab.type = "checkbox";
      newTabRow.append(newTab, document.createTextNode("Open in new tab"));
      const remove = button(`${ITEM} mt-1`, "");
      remove.append(
        h("span", "flex h-5 w-5 items-center justify-center", ICON_LINK),
        "Remove link",
      );
      el.append(form, newTabRow, remove);

      // The input must take focus (clicking it is not swallowed); a click
      // anywhere else in the popover is, so it never collapses a selection.
      el.addEventListener("mousedown", (e) => {
        if (e.target !== input) e.preventDefault();
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          const trigger = cur?.trigger;
          closePanel();
          trigger?.focus();
        }
      });

      let cur: {
        trigger: HTMLElement;
        onApply: (h: string, t: string) => void;
        onRemove: () => void;
      } | null = null;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const c = cur;
        const href = input.value.trim();
        const target = newTab.checked ? "_blank" : "none";
        closePanel();
        c?.onApply(href, target);
      });
      remove.addEventListener("click", () => {
        const c = cur;
        closePanel();
        c?.onRemove();
      });

      return {
        el,
        open(trigger, opts) {
          cur = { trigger, onApply: opts.onApply, onRemove: opts.onRemove };
          input.value = opts.href;
          newTab.checked = opts.target === "_blank";
          remove.hidden = !opts.canRemove;
          const tr = trigger.getBoundingClientRect();
          el.hidden = false; // measurable before parking
          park(el, tr.bottom + 6, tr.left);
          showPanel({ el });
          input.focus();
          input.select();
        },
      };
    }
  }

  function buildDeclaredControls(specs: readonly ToolbarSpec[], id: string): void {
    segChoices.textContent = "";
    segOther.textContent = "";
    const block = editor.getBlock(id);
    const def = block ? getBlockType(block.type) : undefined;
    if (!block) {
      segChoices.hidden = segOther.hidden = true;
      return;
    }

    const grouped = new Map<string, HTMLElement[]>();
    const add = (spec: ToolbarSpec, control: HTMLElement) => {
      const group = spec.group ?? "block";
      const controls = grouped.get(group) ?? [];
      controls.push(control);
      grouped.set(group, controls);
    };
    const settingValue = (name: string): unknown =>
      block.settings && name in block.settings
        ? block.settings[name]
        : def?.settings?.find((setting) => setting.setting === name)?.default;
    const openMenu = (trigger: HTMLButtonElement, panel: HTMLElement, focusFirst = true): void => {
      const rect = trigger.getBoundingClientRect();
      panel.hidden = false;
      park(panel, rect.bottom + 6, rect.left);
      showPanel({
        el: panel,
        onClose: () => {
          trigger.setAttribute("aria-expanded", "false");
          panel.remove();
        },
      });
      trigger.setAttribute("aria-expanded", "true");
      if (focusFirst) panel.querySelector<HTMLElement>("button:not([disabled]), input")?.focus();
    };

    for (const spec of specs) {
      if (spec.control === "add-child" && spec.type) {
        const trigger = button(`${BTN} px-2 whitespace-nowrap`, spec.label, spec.label);
        trigger.addEventListener("click", () => editor.appendChild(id, spec.type!));
        add(spec, trigger);
        continue;
      }
      if (spec.control === "toggle-setting" && spec.setting) {
        const icon = spec.icon ? iconSvg(spec.icon) : "";
        const toggle = icon
          ? button(BTN, icon, spec.label)
          : button(`${BTN} px-2 whitespace-nowrap`, spec.label, spec.label);
        setOn(toggle, settingValue(spec.setting) === true);
        toggle.addEventListener("click", () => {
          const currentBlock = editor.getBlock(id);
          const current =
            currentBlock?.settings && spec.setting! in currentBlock.settings
              ? currentBlock.settings[spec.setting!]
              : def?.settings?.find((setting) => setting.setting === spec.setting)?.default;
          editor.setSetting(id, spec.setting!, !current);
        });
        add(spec, toggle);
        continue;
      }

      if (spec.control === "text-align") {
        const active = editor.getStyle(id, "textAlign") ?? "";
        const selected = ALIGNMENTS.find((alignment) => alignment.key === active);
        const trigger = button(
          BTN,
          `${selected?.icon ?? ALIGNMENTS[0].icon}${ICON_CHEVRON}`,
          spec.label,
        );
        trigger.setAttribute("aria-haspopup", "menu");
        trigger.setAttribute("aria-expanded", "false");
        trigger.addEventListener("click", () => {
          const panel = mount(h("div", `${PANEL} pbe-align`));
          panel.setAttribute("role", "menu");
          panel.addEventListener("mousedown", (event) => event.preventDefault());
          for (const alignment of ALIGNMENTS) {
            const item = button(`${ITEM}${alignment.key === active ? ` ${ITEM_ACTIVE}` : ""}`, "");
            item.setAttribute("role", "menuitem");
            item.append(
              h("span", "flex h-5 w-5 items-center justify-center", alignment.icon),
              alignment.label,
            );
            item.addEventListener("click", () => {
              closePanel();
              editor.setStyle(id, "textAlign", alignment.key === active ? "" : alignment.key);
              refocusCarrier(id);
            });
            panel.appendChild(item);
          }
          wireMenuKeys(panel, () => {
            closePanel();
            trigger.focus();
          });
          openMenu(trigger, panel);
        });
        add(spec, trigger);
        continue;
      }

      if (spec.control === "replace" && spec.field) {
        const icon = spec.icon ? iconSvg(spec.icon) : "";
        const trigger = icon
          ? button(BTN, `${icon}${ICON_CHEVRON}`, spec.label)
          : button(`${BTN} px-2 whitespace-nowrap`, `${spec.label}${ICON_CHEVRON}`, spec.label);
        trigger.setAttribute("aria-haspopup", "menu");
        trigger.setAttribute("aria-expanded", "false");
        trigger.addEventListener("click", () => {
          const panel = mount(h("div", `${PANEL} pbe-replace w-72`));
          panel.setAttribute("role", "menu");
          panel.addEventListener("mousedown", (event) => {
            if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
          });
          buildReplacePanel(panel, id, spec.field!);
          panel.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closePanel();
              trigger.focus();
            }
          });
          openMenu(trigger, panel, false);
        });
        add(spec, trigger);
        continue;
      }

      if (spec.control === "link" && (spec.field || spec.setting)) {
        const trigger = button(BTN, ICON_LINK, spec.label);
        const rawHref = spec.field ? block.fields[spec.field] : settingValue(spec.setting!);
        const href = typeof rawHref === "string" ? rawHref : "";
        setOn(trigger, href.trim() !== "");
        trigger.addEventListener("click", () => {
          const current = editor.getBlock(id);
          if (!current) return;
          const currentHref = spec.field
            ? current.fields[spec.field]
            : (current.settings?.[spec.setting!] ??
              def?.settings?.find((setting) => setting.setting === spec.setting)?.default);
          const target = spec.targetSetting
            ? (current.settings?.[spec.targetSetting] ??
              def?.settings?.find((setting) => setting.setting === spec.targetSetting)?.default)
            : "";
          linkPopover.open(trigger, {
            href: typeof currentHref === "string" ? currentHref : "",
            target: typeof target === "string" ? target : "",
            canRemove: typeof currentHref === "string" && currentHref.trim() !== "",
            onApply: (nextHref, nextTarget) => {
              if (spec.field) editor.setField(id, spec.field, nextHref);
              else editor.setSetting(id, spec.setting!, nextHref);
              if (spec.targetSetting)
                editor.setSetting(
                  id,
                  spec.targetSetting,
                  nextTarget === "_blank" ? "_blank" : "none",
                );
            },
            onRemove: () => {
              if (spec.field) editor.setField(id, spec.field, "");
              else editor.setSetting(id, spec.setting!, "");
            },
          });
        });
        add(spec, trigger);
        continue;
      }

      if (spec.control === "caption" && spec.field && spec.setting) {
        const caption = button(BTN, ICON_CAPTION, spec.label);
        const content = plainText(block.fields[spec.field]).trim();
        setOn(caption, settingValue(spec.setting) === true || content !== "");
        caption.addEventListener("click", () => {
          const current = editor.getBlock(id);
          if (!current) return;
          const currentContent = plainText(current.fields[spec.field!]).trim();
          const shown =
            (current.settings?.[spec.setting!] ??
              def?.settings?.find((setting) => setting.setting === spec.setting)?.default) ===
              true || currentContent !== "";
          if (shown) {
            if (currentContent) editor.setField(id, spec.field!, "");
            editor.setSetting(id, spec.setting!, false);
          } else {
            editor.setSetting(id, spec.setting!, true);
            refocusCarrier(id);
          }
        });
        add(spec, caption);
        continue;
      }

      if (spec.control === "copy" && spec.field) {
        const copy = button(`${BTN} px-2 whitespace-nowrap`, spec.label, spec.label);
        const current = block.fields[spec.field];
        copy.disabled = typeof current !== "string" || !current.trim();
        copy.addEventListener("click", () => {
          const value = editor.getBlock(id)?.fields[spec.field!];
          if (typeof value === "string" && value) void copyText(value);
        });
        add(spec, copy);
        continue;
      }

      if (spec.control === "text" && (spec.field || spec.setting)) {
        const edit = button(`${BTN} px-2 whitespace-nowrap`, spec.label, spec.label);
        edit.setAttribute("aria-haspopup", "dialog");
        edit.setAttribute("aria-expanded", "false");
        edit.addEventListener("click", () => {
          const panel = mount(h("div", `${PANEL} w-72`));
          panel.setAttribute("role", "dialog");
          panel.setAttribute("aria-label", spec.label);
          const form = h("form", "flex items-center gap-1.5");
          const input = h(
            "input",
            "h-10 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25",
          ) as HTMLInputElement;
          const current = spec.field ? block.fields[spec.field] : settingValue(spec.setting!);
          input.type = "text";
          input.value = typeof current === "string" ? current : "";
          input.setAttribute("aria-label", spec.label);
          const apply = button(
            "flex h-10 min-w-10 cursor-pointer items-center justify-center rounded-lg bg-primary px-2 text-sm font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "↵",
            "Apply",
          );
          apply.type = "submit";
          form.append(input, apply);
          panel.appendChild(form);
          panel.addEventListener("mousedown", (event) => {
            if (event.target !== input) event.preventDefault();
          });
          panel.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closePanel();
              edit.focus();
            }
          });
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            closePanel();
            if (spec.field) editor.setField(id, spec.field, input.value);
            else editor.setSetting(id, spec.setting!, input.value);
          });
          openMenu(edit, panel, false);
          input.focus();
          input.select();
        });
        add(spec, edit);
        continue;
      }

      if (
        spec.control !== "field-options" &&
        spec.control !== "setting-options" &&
        spec.control !== "transform-options" &&
        spec.control !== "style-options"
      )
        continue;
      if (!spec.options) continue;

      const value =
        spec.control === "transform-options"
          ? block.type
          : spec.control === "style-options"
            ? editor.getStyle(id, spec.style!)
            : spec.field
              ? block.fields[spec.field]
              : settingValue(spec.setting!);
      const active = spec.options.find((option) => option.value === value);
      const trigger = button(
        `${BTN} px-2 whitespace-nowrap`,
        `${active?.label ?? spec.label}${ICON_CHEVRON}`,
        spec.label,
      );
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      trigger.addEventListener("click", () => {
        const panel = mount(h("div", `${PANEL} pbe-toolbar-options`));
        panel.setAttribute("role", "menu");
        panel.addEventListener("mousedown", (event) => event.preventDefault());
        for (const option of spec.options!) {
          const item = button(
            `${ITEM}${option.value === value ? ` ${ITEM_ACTIVE}` : ""}`,
            option.label,
          );
          item.setAttribute("role", "menuitem");
          item.addEventListener("click", () => {
            closePanel();
            if (spec.control === "transform-options") editor.transformBlock(id, option.value);
            else if (spec.control === "style-options")
              editor.setStyle(id, spec.style!, option.value === value ? "" : option.value);
            else if (spec.field) editor.setField(id, spec.field, option.value);
            else editor.setSetting(id, spec.setting!, option.value);
            refocusCarrier(id);
          });
          panel.appendChild(item);
        }
        wireMenuKeys(panel, () => {
          closePanel();
          trigger.focus();
        });
        openMenu(trigger, panel);
      });
      add(spec, trigger);
    }

    for (const group of ["parent", "block", "inline", "other"] as const) {
      const controls = grouped.get(group);
      if (!controls?.length) continue;
      const segment = h("div", SEGMENT);
      segment.dataset.toolbarGroup = group;
      segment.append(...controls);
      (group === "other" ? segOther : segChoices).appendChild(segment);
    }
    segChoices.hidden = !segChoices.childElementCount;
    segOther.hidden = !segOther.childElementCount;
  }

  function syncToolbar() {
    if (!toolbar) return;
    // While chrome holds focus (open dropdown, tabbed-to button) the caret is
    // gone but the toolbar must not vanish under the user.
    if (openPanel || toolbar.contains(document.activeElement)) return;

    const ids = editor.selection.blocks;
    const multi = ids.length > 1;
    const id = multi ? ids[0] : (editor.selection.active ?? ids[0] ?? null);
    const block = id ? editor.getBlock(id) : null;
    const root = id ? rootOf(id) : null;
    if (!id || !block || !root) {
      toolbar.hidden = true;
      toolbarId = null;
      return;
    }
    toolbarId = multi ? null : id;
    singleStrip.hidden = multi;
    multiStrip.hidden = !multi;

    if (!multi) {
      const mode = editor.editingMode(id);
      const patternDef = block.pattern ? getPattern(block.pattern) : undefined;
      toolbarPatternId = patternDef ? id : null;
      toolbarPatternName = patternDef ? block.pattern! : null;
      segPattern.hidden = !patternDef || !options.onEditPattern;
      indicator.innerHTML = patternDef ? badgeOf(PATTERN_ROOT_TYPE) : badgeOf(block.type);
      indicator.title = patternDef
        ? patternDef.label
        : (blockTypes().find((b) => b.type === block.type)?.label ?? block.type);

      // A block whose policy pins it (movable:false, or the container is not
      // orderable) shows NO move buttons; otherwise they disable at the edges.
      const movable = mode === "default" && editor.canMove(id);
      btnUp.hidden = btnDown.hidden = !movable;
      const at = locateBlock(editor.getModel().blocks, id);
      btnUp.disabled = !at || at.index <= 0;
      btnDown.disabled = !at || at.index >= at.list.length - 1;

      const richCarriers = [
        ...(root.matches("[data-pb-rich]") ? [root] : []),
        ...root.querySelectorAll<HTMLElement>("[data-pb-rich]"),
      ].filter((carrier) => carrier.closest("[data-pb-id]") === root);
      const activeRich = document.activeElement?.closest?.("[data-pb-rich]");
      const hasActiveRich = !!activeRich && richCarriers.includes(activeRich as HTMLElement);

      const declared = patternDef ? [] : (getBlockType(block.type)?.toolbar ?? []);
      const tbSpecs = declared.filter(
        (spec) => mode === "default" || (mode === "content-only" && spec.role === "content"),
      );
      // Bound block controls and carrier formatting are mutually exclusive: the
      // format segment only appears once the user SELECTS caption text
      // (selecting the leaf image drops a collapsed caret in the caption, which
      // must NOT count as "formatting"), and the block controls step aside for
      // it — one strip, no duplicate Link buttons.
      const winSel = window.getSelection();
      const hasTextSel =
        editor.selection.active === id &&
        hasActiveRich &&
        !!winSel?.rangeCount &&
        !winSel.isCollapsed;
      const boundControls = new Set(["replace", "link", "caption"]);
      const ownsBlockControls = tbSpecs.some((spec) => boundControls.has(spec.control));
      buildDeclaredControls(
        hasTextSel ? tbSpecs.filter((spec) => !boundControls.has(spec.control)) : tbSpecs,
        id,
      );
      segFormat.hidden = ownsBlockControls ? !hasTextSel : !hasActiveRich;
      segShell.hidden = mode !== "default";
      const canConvertPattern = editor.canConvertPattern(id);
      itemConvertPattern.hidden = !canConvertPattern;
      itemConvertPattern.disabled = !canConvertPattern;
      const ungroupTarget = editor.ungroupTarget(id);
      itemUngroup.hidden = !ungroupTarget;
      itemUngroup.disabled = !ungroupTarget;
      itemDuplicate.disabled = !editor.canDuplicate(id);
      itemRemove.disabled = !editor.canRemove(id);
      segMore.hidden =
        mode !== "default" ||
        (!canConvertPattern && !ungroupTarget && itemDuplicate.disabled && itemRemove.disabled);

      const marks = editor.formatState();
      // allowedFormats hides a disallowed mark's button entirely (null = all,
      // [] = plain text) — same effective policy editor.format() enforces.
      const allowed = editor.blockPolicy(id).allowedFormats;
      const canFmt = (m: string) => allowed === null || allowed.includes(m);
      btnBold.hidden = !canFmt("bold");
      btnItalic.hidden = !canFmt("italic");
      btnBold.disabled = btnItalic.disabled = !hasActiveRich;
      setOn(btnBold, !!marks.bold);
      setOn(btnItalic, !!marks.italic);

      // Inline link: needs selected text to wrap; lights up when the selection
      // already sits in a link. Same allowedFormats gate ("link").
      const lk = canFmt("link") ? editor.linkState() : null;
      btnFmtLink.hidden = !canFmt("link");
      btnFmtLink.disabled = !hasTextSel;
      setOn(btnFmtLink, !!lk);
    }

    toolbarAnchorId = id;
    toolbar.hidden = false; // unhide before measuring — offsetHeight needs layout
    positionToolbar();
  }

  // Sticky placement: the toolbar floats above its block, but once the block
  // scrolls up under the canvas viewport's top edge it sticks there, staying
  // visible — then rides back down with the block's bottom edge as the block
  // finally leaves, so it never detaches from the block it belongs to.
  //
  // Crucially this must be LAG-FREE: each phase is positioned so the browser
  // tracks it natively, with no per-scroll-frame JS correction that would
  // trail the scroll. Floating/trailing use position:absolute — the toolbar's
  // offset inside the scrolling host is constant, so it rides with the block
  // for free. Stuck uses position:fixed — the browser pins it to the viewport
  // on the compositor. The scroll handler only flips between the two at the
  // phase boundaries; a late handler is invisible because the CSS holds.
  function positionToolbar() {
    if (!toolbar || toolbar.hidden || !toolbarAnchorId) return;
    const root = rootOf(toolbarAnchorId);
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const th = toolbar.offsetHeight;
    const floating = rr.top - th - STICKY_GAP; // resting spot above the block
    const stuck = (scroller ? scroller.getBoundingClientRect().top : 0) + STICKY_MARGIN;
    const trailing = rr.bottom - th; // pinned to the block's bottom as it exits
    const top = Math.min(Math.max(floating, stuck), trailing); // viewport coords

    if (top === stuck && floating < stuck && stuck < trailing) {
      // Stuck to the viewport top — fixed, so scroll doesn't move it at all.
      toolbar.style.position = "fixed";
      toolbar.style.top = `${top}px`;
      toolbar.style.left = `${Math.max(0, rr.left)}px`;
    } else {
      // Floating above / trailing the block — absolute, offset within the host
      // (constant across scroll, so the toolbar tracks the block natively).
      toolbar.style.position = "absolute";
      park(toolbar, top, rr.left);
    }
  }

  // ---------------------------------------------------------------------------
  // syncs + wiring
  // ---------------------------------------------------------------------------

  // "/" rides MODEL changes only (see the header note). Opening still takes
  // an EXACT "/" (a fresh slash just typed — Escape at "/gro" must not
  // reopen on the next keystroke); once open, every model change re-filters
  // the menu from whatever follows the slash, and losing the slash (or the
  // block, or the caret) closes it.
  const slashTextOf = (id: string | null): string | null => {
    const block = id ? editor.getBlock(id) : null;
    if (!block || block.type !== editor.defaultBlock) return null;
    const field = getBlockType(block.type)?.fields.find(
      (f) => f.type === "rich" || f.type === "text",
    );
    return field ? plainText(block.fields[field.name]).trim() : null;
  };
  function syncSlash() {
    if (!withSlash || !quick) return;
    if (openPanel?.el === quick) {
      const text = slashTextOf(targetId);
      if (text == null || !text.startsWith("/") || editor.selection.active !== targetId) {
        targetId = null;
        closePanel();
        return;
      }
      if (!buildQuickItems(text.slice(1))) {
        targetId = null;
        closePanel();
      }
      return;
    }
    if (openPanel) return;
    const id = editor.selection.active;
    if (id && slashTextOf(id) === "/") openQuick(id);
  }

  // The + follows the empty default block's ghost row.
  function syncAppender() {
    if (!withInserter || openPanel) return;
    const id = editor.selection.active;
    const block = id ? editor.getBlock(id) : null;
    const root = id ? rootOf(id) : null;
    const ghosted =
      root &&
      (root.matches("[data-pbe-ph].pbe-empty")
        ? root
        : root.querySelector("[data-pbe-ph].pbe-empty"));
    if (
      !id ||
      !block ||
      !root ||
      block.type !== editor.defaultBlock ||
      !ghosted ||
      !pickerTypes(id).length // B2: nothing insertable → no + affordance
    ) {
      appender.hidden = true;
      return;
    }
    const cr = canvas.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    appender.dataset.target = id;
    park(appender, rr.top + (rr.height - 32) / 2, cr.right - 40);
    appender.hidden = false;
  }

  function syncSpacerResizer() {
    const ids = editor.selection.blocks;
    const id = editor.selection.active ?? (ids.length === 1 ? ids[0] : null);
    const block = id ? editor.getBlock(id) : null;
    const root = id ? rootOf(id) : null;
    if (
      !id ||
      !block ||
      block.type !== "spacer" ||
      editor.editingMode(id) !== "default" ||
      !editor.canStyle(id) ||
      !root
    ) {
      spacerHandle.hidden = true;
      delete spacerHandle.dataset.target;
      return;
    }
    const rect = root.getBoundingClientRect();
    spacerHandle.dataset.target = id;
    park(spacerHandle, rect.bottom - 6, rect.left + rect.width / 2 - 24);
    spacerHandle.hidden = false;
  }

  // --- media placeholder --------------------------------------------------
  // A block whose PRIMARY media is empty (the field a "media" control binds)
  // gets a placeholder card next to the empty carrier: drag-drop / Upload /
  // Insert from URL. Chrome DOM only — serialize re-renders from the model
  // and never sees it. Upload needs the /media/* worker; the URL path works
  // everywhere.

  const uploadsReady = () => mediaStoreSupported() && !!navigator.serviceWorker?.controller;

  const mediaFieldOf = (type: string | null): string | null => {
    const spec = type
      ? getBlockType(type)?.settings?.find((s) => s.control === "media")
      : undefined;
    return spec?.field ?? null;
  };

  async function uploadTo(id: string, field: string, file: File) {
    const { url } = await putMedia(file, file.name);
    let width = "";
    let height = "";
    if (file.type.startsWith("image/")) {
      try {
        const bmp = await createImageBitmap(file);
        width = String(bmp.width);
        height = String(bmp.height);
        bmp.close();
      } catch {
        /* not decodable — dims stay empty */
      }
    }
    const cur = editor.getBlock(id)?.fields[field];
    const alt = typeof cur === "object" && cur !== null ? cur.alt : "";
    editor.setField(id, field, { src: url, alt, width, height });
  }

  function buildMediaPlaceholder(id: string, field: string, type: string): HTMLElement {
    const def = getBlockType(type)!;
    const noun = def.label.toLowerCase();
    const card = document.createElement("div");
    card.className =
      "pbe-ui pbe-media-ph my-1 rounded-lg border border-border bg-muted p-4 text-foreground";
    card.contentEditable = "false";
    card.innerHTML =
      `<div class="mb-1 flex items-center gap-2 font-semibold">${iconSvg(def.icon ?? "", "h-5 w-5")}<span>${def.label}</span></div>` +
      `<p class="m-0 mb-3 text-sm text-muted-foreground">Drag and drop ${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun} file, upload, or insert from URL.</p>` +
      `<div class="flex flex-wrap items-center gap-2">` +
      `<label class="pbe-mph-upload inline-flex h-10 cursor-pointer items-center rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground shadow-xs hover:bg-primary/90"${uploadsReady() ? "" : " hidden"}>Upload<input type="file" class="hidden"></label>` +
      `<button type="button" class="pbe-mph-url-btn h-10 cursor-pointer rounded-lg border border-input bg-background px-3.5 text-sm font-semibold text-foreground shadow-xs hover:bg-ui-accent">Insert from URL</button>` +
      `</div>` +
      `<form class="pbe-mph-url-row mt-2 flex items-center gap-1.5" hidden>` +
      `<input type="text" placeholder="Paste or type URL" class="h-10 w-full max-w-96 rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25">` +
      `<button type="submit" class="h-10 min-w-10 cursor-pointer rounded-md px-2 text-sm font-semibold hover:bg-ui-accent" aria-label="Apply">↵</button>` +
      `</form>`;

    // The card is interactive chrome inside the contenteditable canvas:
    // keep its events out of the editor's selection/keyboard machinery
    // (Enter must submit the URL form, never split a block) — but clicking
    // it still SELECTS the block, so the sidebar shows its options.
    card.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      editor.selectBlock(id);
    });
    card.addEventListener("keydown", (e) => e.stopPropagation());

    const fileInput = card.querySelector<HTMLInputElement>("input[type=file]")!;
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) void uploadTo(id, field, file);
    });

    const urlRow = card.querySelector<HTMLFormElement>(".pbe-mph-url-row")!;
    const urlInput = urlRow.querySelector<HTMLInputElement>("input")!;
    card.querySelector<HTMLButtonElement>(".pbe-mph-url-btn")!.addEventListener("click", () => {
      urlRow.hidden = !urlRow.hidden;
      if (!urlRow.hidden) urlInput.focus();
    });
    urlRow.addEventListener("submit", (e) => {
      e.preventDefault();
      const src = urlInput.value.trim();
      if (!src) return;
      const cur = editor.getBlock(id)?.fields[field];
      const alt = typeof cur === "object" && cur !== null ? cur.alt : "";
      editor.setField(id, field, { src, alt, width: "", height: "" });
    });

    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      card.classList.add("border-[var(--color-pbe-accent)]");
    });
    card.addEventListener("dragleave", () =>
      card.classList.remove("border-[var(--color-pbe-accent)]"),
    );
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("border-[var(--color-pbe-accent)]");
      const file = e.dataTransfer?.files?.[0];
      if (file && uploadsReady()) void uploadTo(id, field, file);
    });
    return card;
  }

  function syncMediaPlaceholders() {
    if (!withMediaPlaceholder) return;
    for (const root of canvas.querySelectorAll<HTMLElement>("[data-pb-block]")) {
      const id = root.getAttribute("data-pb-id");
      const field = mediaFieldOf(root.getAttribute("data-pb-block"));
      const existing = [...root.querySelectorAll<HTMLElement>(".pbe-media-ph")].find(
        (el) => el.parentElement?.closest("[data-pb-block]") === root,
      );
      const value = id && field ? editor.getBlock(id)?.fields[field] : undefined;
      const empty = typeof value === "object" && value !== null && value.src === "";
      if (!id || !field || !empty) {
        existing?.remove();
        continue;
      }
      if (existing) {
        // SW readiness can flip after mount — keep the Upload button honest
        const upload = existing.querySelector<HTMLElement>(".pbe-mph-upload");
        if (upload) upload.hidden = !uploadsReady();
        continue;
      }
      const carrier = [...root.querySelectorAll<HTMLElement>(`[data-pb-image]`)].find(
        (el) =>
          el.getAttribute("data-pb-image") === field && el.closest("[data-pb-block]") === root,
      );
      carrier?.insertAdjacentElement(
        "afterend",
        buildMediaPlaceholder(id, field, root.getAttribute("data-pb-block")!),
      );
    }
  }

  // The worker claims clients asynchronously on first load — refresh the
  // Upload affordance once it does.
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    void navigator.serviceWorker.ready.then(() => {
      if (!detached) syncMediaPlaceholders();
    });
  }
  disposers.push(() => {
    for (const el of canvas.querySelectorAll(".pbe-media-ph")) el.remove();
  });

  // Click anywhere outside an open panel dismisses it.
  listen("mousedown", (e) => {
    if (!openPanel || !(e.target instanceof Node)) return;
    if (!openPanel.el.contains(e.target)) closePanel();
  });

  // Caret movement WITHIN a block changes mark states and the +'s row without
  // any store change. Cheap when another instance owns the caret: active=null.
  listen("selectionchange", () => {
    if (detached) return;
    syncAppender();
    syncToolbar();
    syncSpacerResizer();
  });

  const unsubscribe = editor.subscribe(() => {
    if (detached) return;
    syncSlash();
    syncAppender();
    syncToolbar();
    syncSpacerResizer();
    syncMediaPlaceholders();
  });
  syncMediaPlaceholders(); // content may already be loaded when chrome attaches
  disposers.push(unsubscribe);

  // Block-selection changes (cmd+click, Escape, drag promotion) ride the
  // editor's reactive selection store.
  effect(() => {
    if (detached) return;
    syncToolbar();
    syncSpacerResizer();
  });

  // Scrolling and resizing don't touch the model or selection, but the sticky
  // toolbar has to re-clamp against the viewport on both — a cheap reposition,
  // no button-state rebuild. Listen on the scroll container (falling back to
  // the window if the canvas isn't the scroller).
  const reposition = () => {
    // An open dropdown is parked against the toolbar's current spot — moving
    // the toolbar out from under it would separate the two. Leave both put.
    if (!detached && !openPanel) {
      positionToolbar();
      syncSpacerResizer();
    }
  };
  (scroller ?? window).addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition);
  disposers.push(() => (scroller ?? window).removeEventListener("scroll", reposition));
  disposers.push(() => window.removeEventListener("resize", reposition));

  return function detach() {
    detached = true;
    closePanel();
    disposers.forEach((d) => d());
    mounted.forEach((el) => el.remove());
    canvas.classList.remove("pbe-canvas");
  };
}
