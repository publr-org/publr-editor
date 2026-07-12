// PublrEditor UI icon adapter.
//
// Canonical artwork lives in @publr/icons. This thin wrapper preserves the
// editor's established sprite ids (`#pbe-i-*`) so hosts and serialized chrome
// do not change when the shared package is updated. Social/brand artwork is
// intentionally separate in blocks/social-icons.ts.

import {
  ICONS,
  ICON_VIEWBOX,
  iconRef as sharedIconRef,
  iconSvg as sharedIconSvg,
  mountIconSprite as mountSharedIconSprite,
} from "@publr/icons";

export { ICONS, ICON_VIEWBOX };

/** Preserve the editor's established default size while sharing the artwork. */
export const iconSvg = (name: string, className = "h-6 w-6"): string =>
  sharedIconSvg(name, className);

/** Mount the shared UI sprite under the editor's backwards-compatible ids. */
export function mountIconSprite(doc: Document = document): void {
  mountSharedIconSprite(doc, "pbe-i");
}

/** Sprite reference for a known UI icon, or an empty fallback. */
export const iconRef = (name: string | undefined): string => sharedIconRef(name, "pbe-i");
