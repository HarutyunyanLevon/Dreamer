import { useCallback, useEffect, useRef, type ElementType, type HTMLAttributes, type Ref, type RefObject } from "react";

/**
 * Dreamer's one scroll system (see docs/decisions.md, "Scrolling").
 *
 * - `ScrollArea` renders any scrollable region with the shared `.scroll` look: the same slim,
 *   themed, always-present scrollbar everywhere, with its gutter reserved up front so content never
 *   shifts when the thumb appears.
 * - A **wheel boundary** (`boundary` on a ScrollArea, or `useWheelBoundary` on a panel root) is
 *   where wheel input stops: the native listener stops propagation, so nothing reaches the canvas's
 *   pan/zoom handler, and `overscroll-behavior: contain` stops scroll chaining there. Nested
 *   ScrollAreas inside one boundary chain to each other natively (inner area at its start/end →
 *   the containing area scrolls), but scroll never crosses from one panel to another.
 */

const WHEEL_BOUNDARY_ATTR = "data-wheel-boundary";

type ScrollAreaProps = HTMLAttributes<HTMLElement> & {
  as?: "div" | "ul" | "ol" | "nav" | "pre" | "section";
  axis?: "y" | "x";
  /** This area is the outermost scroller of a panel/popup: wheel input stops here. */
  boundary?: boolean;
  ref?: Ref<HTMLElement>;
};

export function ScrollArea({ as = "div", axis = "y", boundary = false, className, ref, ...rest }: ScrollAreaProps) {
  const local = useRef<HTMLElement | null>(null);
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      local.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as { current: HTMLElement | null }).current = el;
    },
    [ref],
  );
  useEffect(() => {
    const el = local.current;
    if (!el || !boundary) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: true });
    return () => el.removeEventListener("wheel", stop);
  }, [boundary]);
  const Tag = as as ElementType;
  const cls = `scroll scroll-${axis}${boundary ? " scroll-boundary" : ""}${className ? ` ${className}` : ""}`;
  return <Tag ref={setRef} className={cls} {...(boundary ? { [WHEEL_BOUNDARY_ATTR]: "" } : {})} {...rest} />;
}

/**
 * Things a press must keep for itself: fields keep text selection and caret placement, buttons and
 * links keep their click, code blocks stay selectable for copying.
 */
const KEEPS_PRESS =
  "input, textarea, select, button, a, label, summary, option, [contenteditable=''], [contenteditable='true'], [role='slider'], [role='button'], [draggable='true'], code, pre, [data-no-drag-scroll]";

/** The element a drag should scroll: the nearest ancestor (up to `root`) that has room to scroll. */
function scrollerFor(target: Element, root: HTMLElement): HTMLElement | null {
  let el: Element | null = target;
  while (el) {
    const s = getComputedStyle(el);
    const y = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const x = /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (y || x) return el as HTMLElement;
    if (el === root) break;
    el = el.parentElement;
  }
  return null;
}

/** True if the press landed on `el`'s own scrollbar (dragging the thumb must stay native). */
function onOwnScrollbar(el: Element, e: PointerEvent): boolean {
  const r = el.getBoundingClientRect();
  const he = el as HTMLElement;
  return e.clientX - r.left >= he.clientLeft + he.clientWidth || e.clientY - r.top >= he.clientTop + he.clientHeight;
}

/**
 * Drag-to-scroll inside a popup (mouse and pen; touch already scrolls natively). Press on
 * non-interactive content and drag: the nearest scrollable area follows the pointer. Presses on
 * fields, buttons, links, sliders and code keep their normal behaviour. A 4px threshold keeps plain
 * clicks as clicks; once a drag starts, the pointer is captured, text selection is suppressed, and
 * the click that would end the drag is swallowed.
 */
export function useDragScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let drag: { id: number; x: number; y: number; el: HTMLElement; top: number; left: number; active: boolean } | null = null;

    const swallowClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch") return;
      const t = e.target as Element;
      if (t.closest(KEEPS_PRESS)) return;
      const el = scrollerFor(t, root);
      if (!el || (t === el && onOwnScrollbar(el, e))) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, el, top: el.scrollTop, left: el.scrollLeft, active: false };
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.active) {
        if (Math.hypot(dx, dy) < 4) return;
        drag.active = true;
        root.setPointerCapture(e.pointerId);
        root.classList.add("drag-scrolling");
        window.getSelection()?.removeAllRanges();
      }
      e.preventDefault();
      drag.el.scrollTop = drag.top - dy;
      drag.el.scrollLeft = drag.left - dx;
    };
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.active) {
        root.classList.remove("drag-scrolling");
        if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
        // The click that follows a drag is not a click.
        window.addEventListener("click", swallowClick, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
      }
      drag = null;
    };
    root.addEventListener("pointerdown", down);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    return () => {
      root.removeEventListener("pointerdown", down);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", end);
      root.removeEventListener("pointercancel", end);
      window.removeEventListener("click", swallowClick, { capture: true });
    };
  }, [ref]);
}

/** True when `el` can still scroll in the wheel's direction (so the wheel belongs to it). */
function canScroll(el: Element, dx: number, dy: number): boolean {
  const s = getComputedStyle(el);
  if (dy !== 0 && /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) {
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  if (dx !== 0 && /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1) {
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}

/**
 * For the canvas: should this wheel event be left to the browser instead of panning/zooming?
 * Yes if it started inside a wheel boundary (panel, popup, modal), or inside a scroll area (e.g. a
 * long card body) that can still scroll that way.
 */
export function wheelBelongsToContent(target: EventTarget | null, root: Element, dx: number, dy: number): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== root) {
    if (el.hasAttribute(WHEEL_BOUNDARY_ATTR)) return true;
    if (el.classList.contains("scroll") && canScroll(el, dx, dy)) return true;
    el = el.parentElement;
  }
  return false;
}
