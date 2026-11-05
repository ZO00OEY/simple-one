export interface Rect { top: number; bottom: number; left: number; right: number; }
// Measure only the part of this pane below the visible viewport. A host that
// already resizes the pane for the keyboard needs no additional inset.
export function viewportBottomOverlap(pane: Rect, viewport: { height: number; offsetTop: number; scale: number } | null): number {
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01 || viewport.height <= 0) return 0;
  return Math.ceil(Math.max(0, pane.bottom - Math.max(pane.top, viewport.offsetTop + viewport.height)));
}
// Only reserve the portion of a visible native status bar overlapping this pane.
// If Obsidian already placed the bar below the pane, no second gap is added.
export function bottomOverlap(pane: Rect, bars: Rect[]): number {
  return Math.ceil(Math.max(0, ...bars.filter(bar => bar.right > bar.left && bar.bottom > bar.top
    && bar.left < pane.right && bar.right > pane.left && bar.top < pane.bottom && bar.bottom >= pane.bottom - 1)
    .map(bar => pane.bottom - Math.max(pane.top, bar.top))));
}
