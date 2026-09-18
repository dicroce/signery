// Loaded by tests/harness.html via the Vite dev server. Renders a generated
// two-page PDF through the app's real viewer + placement modules and exposes
// hooks for the Playwright test to drive.
import "../src/polyfills";
import { PDFDocument, degrees } from "pdf-lib";
import { renderPdf } from "../src/pdf-viewer";
import { placeOnNextClick, getPlacements } from "../src/placement";
import { stampSignatures } from "../src/sign";
import type { Placement, SignatureAsset } from "../src/types";

declare global {
  interface Window {
    harnessReady: boolean;
    startPlace: (dataUrl: string) => Promise<boolean>;
    placements: typeof getPlacements;
    stampTest: (
      dataUrl: string,
      rect: { x: number; y: number; width: number; height: number },
      variant?: string
    ) => Promise<{
      scale: number;
      viewportSize: { width: number; height: number };
      samples: Record<string, number[]>;
    }>;
  }
}

(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  const bytes = new Uint8Array(await doc.save());

  const pages = await renderPdf(bytes, document.getElementById("pages")!);

  window.startPlace = (dataUrl: string) => {
    const asset: SignatureAsset = { id: 1, dataUrl };
    return placeOnNextClick(asset, pages, () => {});
  };
  window.placements = getPlacements;

  // Builds a single-page PDF of the requested variant (rotation / offset
  // CropBox), stamps one placement on it, re-renders the result, and samples
  // pixels (in CSS/viewport coordinates) so the test can check where the
  // signature actually landed in the output PDF.
  window.stampTest = async (dataUrl, rect, variant = "plain") => {
    const vdoc = await PDFDocument.create();
    const vpage = vdoc.addPage([612, 792]);
    if (variant === "rot90") vpage.setRotation(degrees(90));
    if (variant === "rot180") vpage.setRotation(degrees(180));
    if (variant === "rot270") vpage.setRotation(degrees(270));
    if (variant === "cropbox") {
      vpage.setMediaBox(-50, 100, 712, 992);
      vpage.setCropBox(0, 150, 612, 792);
    }
    const vbytes = new Uint8Array(await vdoc.save());

    const srcHolder = document.createElement("div");
    srcHolder.style.position = "absolute";
    srcHolder.style.left = "-10000px";
    document.body.appendChild(srcHolder);
    const srcPages = await renderPdf(vbytes, srcHolder);

    const placement: Placement = {
      id: 99,
      asset: { id: 99, dataUrl },
      pageIndex: 0,
      ...rect,
    };
    const stamped = await stampSignatures(vbytes, [placement], srcPages);

    const holder = document.createElement("div");
    holder.style.position = "absolute";
    holder.style.left = "-10000px";
    document.body.appendChild(holder);
    const stampedPages = await renderPdf(new Uint8Array(stamped), holder);
    const viewport = stampedPages[0].viewport;
    const canvas = stampedPages[0].wrapper.querySelector("canvas")!;
    const dpr = canvas.width / viewport.width;
    const ctx = canvas.getContext("2d")!;

    const sample = (x: number, y: number) =>
      Array.from(ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data);

    return {
      scale: viewport.scale,
      viewportSize: { width: viewport.width, height: viewport.height },
      samples: {
        center: sample(rect.x + rect.width / 2, rect.y + rect.height / 2),
        aboveRect: sample(rect.x + rect.width / 2, rect.y - 30),
        belowRect: sample(rect.x + rect.width / 2, rect.y + rect.height + 30),
        mirroredY: sample(
          rect.x + rect.width / 2,
          viewport.height - (rect.y + rect.height / 2)
        ),
        pageBottom: sample(rect.x + rect.width / 2, viewport.height - 10),
      },
    };
  };

  window.harnessReady = true;
})();
