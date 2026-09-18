import type { PageViewport } from "pdfjs-dist";

/** A reusable signature image created by the user (drawn, typed, or uploaded). */
export interface SignatureAsset {
  id: number;
  /** PNG with transparent background. */
  dataUrl: string;
}

/** A signature stamped somewhere on a page. Coordinates are CSS pixels
 *  relative to the page wrapper, y-down (matching pdf.js viewport space). */
export interface Placement {
  id: number;
  asset: SignatureAsset;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedPage {
  pageIndex: number;
  wrapper: HTMLDivElement;
  viewport: PageViewport;
}

export interface DigitalSignOptions {
  /** DER bytes of a PKCS#12 bundle. */
  p12: Uint8Array;
  passphrase: string;
  reason?: string;
  name?: string;
}
