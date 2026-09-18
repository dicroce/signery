import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { RenderedPage } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Width in CSS pixels that pages are scaled to fit. */
const TARGET_WIDTH = 850;

/**
 * Renders every page of the PDF into #pages and returns per-page metadata
 * needed later to map overlay coordinates back into PDF space.
 */
export async function renderPdf(
  data: Uint8Array,
  container: HTMLElement
): Promise<RenderedPage[]> {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const doc = await pdfjs.getDocument({ data: data.slice() }).promise;
  container.replaceChildren();

  const pages: RenderedPage[] = [];
  const dpr = Math.max(window.devicePixelRatio || 1, 1);

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(TARGET_WIDTH / baseViewport.width, 2.5);
    const viewport = page.getViewport({ scale });

    const wrapper = document.createElement("div");
    wrapper.className = "page-wrapper";
    wrapper.dataset.pageIndex = String(i - 1);
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext("2d")!;
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;

    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    pages.push({ pageIndex: i - 1, wrapper, viewport });
  }

  return pages;
}
