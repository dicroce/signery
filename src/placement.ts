import type { Placement, RenderedPage, SignatureAsset } from "./types";

const DEFAULT_WIDTH = 180;

let nextId = 1;
const placements: Placement[] = [];

export function getPlacements(): readonly Placement[] {
  return placements;
}

export function clearPlacements() {
  placements.length = 0;
}

function imageAspect(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalHeight / img.naturalWidth || 0.4);
    img.onerror = () => resolve(0.4);
    img.src = dataUrl;
  });
}

/**
 * Puts the viewer into "click to place" mode: the next click on a page drops
 * the signature there. Resolves once placed (true) or cancelled with Esc (false).
 */
export function placeOnNextClick(
  asset: SignatureAsset,
  pages: RenderedPage[],
  onChange: () => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = () => {
      for (const p of pages) {
        p.wrapper.classList.remove("placing");
        p.wrapper.removeEventListener("click", handlers.get(p)!);
      }
      document.removeEventListener("keydown", onKey);
    };

    const handlers = new Map<RenderedPage, (e: MouseEvent) => void>();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cleanup();
        resolve(false);
      }
    };

    for (const page of pages) {
      const handler = async (e: MouseEvent) => {
        cleanup();
        const rect = page.wrapper.getBoundingClientRect();
        const aspect = await imageAspect(asset.dataUrl);
        const w = DEFAULT_WIDTH;
        const h = w * aspect;
        const placement: Placement = {
          id: nextId++,
          asset,
          pageIndex: page.pageIndex,
          x: Math.min(Math.max(e.clientX - rect.left - w / 2, 0), rect.width - w),
          y: Math.min(Math.max(e.clientY - rect.top - h / 2, 0), rect.height - h),
          width: w,
          height: h,
        };
        placements.push(placement);
        mountPlacement(placement, page, onChange);
        onChange();
        resolve(true);
      };
      handlers.set(page, handler);
      page.wrapper.classList.add("placing");
      page.wrapper.addEventListener("click", handler);
    }
    document.addEventListener("keydown", onKey);
  });
}

function mountPlacement(
  placement: Placement,
  page: RenderedPage,
  onChange: () => void
) {
  const el = document.createElement("div");
  el.className = "placed-sig";
  el.style.left = `${placement.x}px`;
  el.style.top = `${placement.y}px`;
  el.style.width = `${placement.width}px`;
  el.style.height = `${placement.height}px`;

  const img = document.createElement("img");
  img.src = placement.asset.dataUrl;
  img.draggable = false;
  el.appendChild(img);

  const handle = document.createElement("div");
  handle.className = "handle";
  el.appendChild(handle);

  const remove = document.createElement("button");
  remove.className = "remove";
  remove.textContent = "✕";
  remove.title = "Remove";
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    const idx = placements.indexOf(placement);
    if (idx >= 0) placements.splice(idx, 1);
    el.remove();
    onChange();
  });
  el.appendChild(remove);

  const pageRect = () => page.wrapper.getBoundingClientRect();

  // Drag to move.
  el.addEventListener("pointerdown", (e) => {
    if (e.target === handle || e.target === remove) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("active");
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = placement.x;
    const origY = placement.y;

    const onMove = (ev: PointerEvent) => {
      const rect = pageRect();
      placement.x = Math.min(
        Math.max(origX + ev.clientX - startX, 0),
        rect.width - placement.width
      );
      placement.y = Math.min(
        Math.max(origY + ev.clientY - startY, 0),
        rect.height - placement.height
      );
      el.style.left = `${placement.x}px`;
      el.style.top = `${placement.y}px`;
    };
    const onUp = () => {
      el.classList.remove("active");
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  });

  // Corner handle: resize, preserving aspect ratio.
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    el.classList.add("active");
    const startX = e.clientX;
    const origW = placement.width;
    const aspect = placement.height / placement.width;

    const onMove = (ev: PointerEvent) => {
      const rect = pageRect();
      let w = Math.max(40, origW + ev.clientX - startX);
      w = Math.min(w, rect.width - placement.x);
      let h = w * aspect;
      if (placement.y + h > rect.height) {
        h = rect.height - placement.y;
        w = h / aspect;
      }
      placement.width = w;
      placement.height = h;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    };
    const onUp = () => {
      el.classList.remove("active");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });

  page.wrapper.appendChild(el);
}
