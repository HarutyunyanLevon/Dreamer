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

export const WHEEL_BOUNDARY_ATTR = "data-wheel-boundary";

/** Marks an element (panel root, popup, modal backdrop) as a wheel boundary. */
export function useWheelBoundary(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute(WHEEL_BOUNDARY_ATTR, "");
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: true });
    return () => el.removeEventListener("wheel", stop);
  }, [ref]);
}

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

/** True when `el` can still scroll in the wheel's direction (so the wheel belongs to it). */
export function canScroll(el: Element, dx: number, dy: number): boolean {
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
