import SignaturePad from "signature_pad";

const CURSIVE_FONTS = [
  "Segoe Script",
  "Brush Script MT",
  "Lucida Handwriting",
  "Snell Roundhand",
  "cursive",
];

const INK = "#101828";

let pad: SignaturePad | null = null;
let activeTab = "draw";
let selectedFont = CURSIVE_FONTS[0];
let uploadedDataUrl: string | null = null;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/** Crops fully transparent margins off a canvas; returns a PNG data URL. */
function trimmedPng(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // nothing drawn

  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(
    canvas,
    minX, minY, out.width, out.height,
    0, 0, out.width, out.height
  );
  return out.toDataURL("image/png");
}

function renderTypedSignature(text: string, font: string): string | null {
  if (!text.trim()) return null;
  const canvas = document.createElement("canvas");
  const fontSize = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px "${font}", cursive`;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width + 40);
  canvas.height = Math.ceil(fontSize * 1.8);
  const ctx2 = canvas.getContext("2d")!;
  ctx2.font = `${fontSize}px "${font}", cursive`;
  ctx2.fillStyle = INK;
  ctx2.textBaseline = "middle";
  ctx2.fillText(text, 20, canvas.height / 2);
  return trimmedPng(canvas);
}

function refreshFontChoices() {
  const text = ($("type-input") as HTMLInputElement).value || "Your Name";
  const holder = $("font-choices");
  holder.replaceChildren();
  for (const font of CURSIVE_FONTS) {
    const btn = document.createElement("button");
    btn.className = "font-choice" + (font === selectedFont ? " selected" : "");
    const preview = renderTypedSignature(text, font);
    if (preview) {
      const img = document.createElement("img");
      img.src = preview;
      btn.appendChild(img);
    } else {
      btn.textContent = font;
    }
    btn.addEventListener("click", () => {
      selectedFont = font;
      refreshFontChoices();
    });
    holder.appendChild(btn);
  }
}

function switchTab(tab: string) {
  activeTab = tab;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  $("panel-draw").hidden = tab !== "draw";
  $("panel-type").hidden = tab !== "type";
  $("panel-image").hidden = tab !== "image";
  if (tab === "type") refreshFontChoices();
}

function setupDrawPad() {
  const canvas = $("draw-canvas") as HTMLCanvasElement;
  // Match the backing store to the CSS size for crisp strokes.
  const dpr = Math.max(window.devicePixelRatio || 1, 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.getContext("2d")!.scale(dpr, dpr);
  if (!pad) {
    pad = new SignaturePad(canvas, {
      penColor: INK,
      backgroundColor: "rgba(0,0,0,0)",
      minWidth: 1,
      maxWidth: 2.5,
    });
  } else {
    pad.clear();
  }
}

let wired = false;

function wireOnce() {
  if (wired) return;
  wired = true;

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    t.addEventListener("click", () => switchTab(t.dataset.tab!));
  });
  $("btn-draw-clear").addEventListener("click", () => pad?.clear());
  $("type-input").addEventListener("input", refreshFontChoices);

  $("btn-image-pick").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        uploadedDataUrl = reader.result as string;
        const preview = $("image-preview") as HTMLImageElement;
        preview.src = uploadedDataUrl;
        preview.hidden = false;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });
}

/**
 * Shows the signature creation modal. Resolves with a transparent PNG data URL,
 * or null if the user cancelled.
 */
export function openSignatureModal(): Promise<string | null> {
  wireOnce();
  const modal = $("sig-modal") as HTMLDialogElement;
  uploadedDataUrl = null;
  ($("image-preview") as HTMLImageElement).hidden = true;
  modal.showModal();
  setupDrawPad();
  switchTab(activeTab);

  return new Promise((resolve) => {
    const done = (value: string | null) => {
      modal.close();
      $("btn-sig-use").removeEventListener("click", onUse);
      $("btn-sig-cancel").removeEventListener("click", onCancel);
      modal.removeEventListener("cancel", onDialogCancel);
      resolve(value);
    };

    const onUse = () => {
      let result: string | null = null;
      if (activeTab === "draw" && pad && !pad.isEmpty()) {
        result = trimmedPng($("draw-canvas") as HTMLCanvasElement);
      } else if (activeTab === "type") {
        const text = ($("type-input") as HTMLInputElement).value;
        result = renderTypedSignature(text, selectedFont);
      } else if (activeTab === "image") {
        result = uploadedDataUrl;
      }
      if (!result) return; // nothing to use yet; keep the modal open
      done(result);
    };
    const onCancel = () => done(null);
    const onDialogCancel = () => done(null);

    $("btn-sig-use").addEventListener("click", onUse);
    $("btn-sig-cancel").addEventListener("click", onCancel);
    modal.addEventListener("cancel", onDialogCancel);
  });
}
