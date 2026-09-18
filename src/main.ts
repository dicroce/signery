import "./polyfills";
import "./styles.css";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { renderPdf } from "./pdf-viewer";
import { openSignatureModal } from "./signature-modal";
import { getPlacements, clearPlacements, placeOnNextClick } from "./placement";
import { stampSignatures, digitallySign, generateSelfSignedP12 } from "./sign";
import type { RenderedPage, SignatureAsset } from "./types";

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

let pdfBytes: Uint8Array | null = null;
let pdfPath: string | null = null;
let pages: RenderedPage[] = [];
let assets: SignatureAsset[] = [];
let selectedAsset: SignatureAsset | null = null;
let nextAssetId = 1;
let p12Path: string | null = null;

function setStatus(text: string) {
  $("status-text").textContent = text;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Lets the browser paint (e.g. a status update) before heavy sync work. */
function nextFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

// ---- Opening a document ----

async function openPdf() {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: "PDF documents", extensions: ["pdf"] }],
  });
  if (!path) return;

  try {
    setStatus(`Loading ${baseName(path)}…`);
    const bytes = await readFile(path);
    pages = await renderPdf(bytes, $("pages"));
    pdfBytes = bytes;
    pdfPath = path;
    clearPlacements();

    $("empty-state").hidden = true;
    $("doc-tools").hidden = false;
    $("btn-save").hidden = false;
    $("doc-name").textContent = baseName(path);
    setStatus(`${pages.length} page${pages.length === 1 ? "" : "s"} loaded`);
  } catch (err) {
    setStatus(`Could not open PDF: ${err}`);
  }
}

// ---- Signature assets & placement ----

function renderTray() {
  const holder = $("tray-items");
  holder.replaceChildren();
  for (const asset of assets) {
    const item = document.createElement("button");
    item.className = "tray-item" + (asset === selectedAsset ? " selected" : "");
    const img = document.createElement("img");
    img.src = asset.dataUrl;
    item.appendChild(img);
    item.addEventListener("click", () => startPlacing(asset));
    holder.appendChild(item);
  }
  $("tray").hidden = assets.length === 0;
}

async function startPlacing(asset: SignatureAsset) {
  if (!pages.length) return;
  selectedAsset = asset;
  renderTray();
  setStatus("Click on the document to place the signature (Esc to cancel)");
  const placed = await placeOnNextClick(asset, pages, updateSaveState);
  setStatus(placed ? "Signature placed — drag to move, corner dot to resize" : "Placement cancelled");
  selectedAsset = null;
  renderTray();
}

async function addSignature() {
  const dataUrl = await openSignatureModal();
  if (!dataUrl) return;
  const asset: SignatureAsset = { id: nextAssetId++, dataUrl };
  assets.push(asset);
  renderTray();
  await startPlacing(asset);
}

function updateSaveState() {
  const n = getPlacements().length;
  setStatus(n === 0 ? "Ready" : `${n} signature${n === 1 ? "" : "s"} placed`);
}

// ---- Sign & save ----

function wireSaveModal() {
  const chkDigital = $("chk-digital") as HTMLInputElement;
  chkDigital.addEventListener("change", () => {
    $("digital-options").hidden = !chkDigital.checked;
  });

  document.querySelectorAll<HTMLInputElement>('input[name="certsource"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const generate = getCertSource() === "generate";
      $("gen-options").hidden = !generate;
      $("p12-options").hidden = generate;
    });
  });

  $("btn-pick-p12").addEventListener("click", async () => {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "PKCS#12 certificate", extensions: ["p12", "pfx"] }],
    });
    if (path) {
      p12Path = path;
      $("p12-name").textContent = baseName(path);
    }
  });

  $("btn-save-cancel").addEventListener("click", () => {
    ($("save-modal") as HTMLDialogElement).close();
  });

  $("btn-save-go").addEventListener("click", saveSigned);
}

function getCertSource(): string {
  return (
    document.querySelector<HTMLInputElement>('input[name="certsource"]:checked')?.value ?? "p12"
  );
}

function openSaveModal() {
  if (!pdfBytes) return;
  const n = getPlacements().length;
  if (n === 0 && !($("chk-digital") as HTMLInputElement).checked) {
    setStatus("Place at least one signature first (or enable digital signing in the next dialog)");
  }
  $("save-summary").textContent =
    n === 0
      ? "No visual signatures placed — you can still apply a digital-only signature."
      : `${n} visual signature${n === 1 ? "" : "s"} will be flattened into the document.`;
  ($("save-modal") as HTMLDialogElement).showModal();
}

async function saveSigned() {
  if (!pdfBytes || !pdfPath) return;
  const modal = $("save-modal") as HTMLDialogElement;
  const wantDigital = ($("chk-digital") as HTMLInputElement).checked;
  const placements = getPlacements();

  if (placements.length === 0 && !wantDigital) {
    setStatus("Nothing to do: place a signature or enable digital signing");
    modal.close();
    return;
  }

  try {
    // 1. Resolve the certificate first so any input errors surface before writing.
    let p12: Uint8Array | null = null;
    let passphrase = "";
    let signerName = "";

    if (wantDigital) {
      if (getCertSource() === "generate") {
        signerName = ($("gen-name") as HTMLInputElement).value.trim();
        const email = ($("gen-email") as HTMLInputElement).value.trim();
        passphrase = ($("gen-pass") as HTMLInputElement).value;
        if (!signerName) {
          setStatus("Enter a name for the self-signed certificate");
          return;
        }
        setStatus("Generating 2048-bit RSA key and certificate (this can take a few seconds)…");
        await nextFrame();
        p12 = generateSelfSignedP12(signerName, email, passphrase);

        if (($("chk-save-p12") as HTMLInputElement).checked) {
          const certPath = await saveDialog({
            title: "Save your certificate for future use",
            defaultPath: `${signerName.replace(/\s+/g, "_")}.p12`,
            filters: [{ name: "PKCS#12 certificate", extensions: ["p12"] }],
          });
          if (certPath) await writeFile(certPath, p12);
        }
      } else {
        if (!p12Path) {
          setStatus("Choose a .p12/.pfx certificate file first");
          return;
        }
        passphrase = ($("p12-pass") as HTMLInputElement).value;
        p12 = await readFile(p12Path);
      }
    }

    modal.close();

    // 2. Flatten visual signatures.
    setStatus("Stamping signatures…");
    await nextFrame();
    let out = placements.length
      ? await stampSignatures(pdfBytes, placements, pages)
      : pdfBytes;

    // 3. Optional cryptographic signature (incremental update, so it covers
    //    the flattened content).
    if (wantDigital && p12) {
      setStatus("Applying digital signature…");
      await nextFrame();
      const reason = ($("sign-reason") as HTMLInputElement).value.trim();
      out = await digitallySign(out, { p12, passphrase, reason, name: signerName });
    }

    // 4. Save.
    const suggested = baseName(pdfPath).replace(/\.pdf$/i, "") + "-signed.pdf";
    const outPath = await saveDialog({
      title: "Save signed PDF",
      defaultPath: suggested,
      filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    });
    if (!outPath) {
      setStatus("Save cancelled");
      return;
    }
    await writeFile(outPath, out);
    setStatus(`Saved ${baseName(outPath)}`);
  } catch (err) {
    console.error(err);
    const msg = String(err);
    setStatus(
      /invalid password|PKCS#12 MAC could not be verified/i.test(msg)
        ? "Wrong certificate password"
        : `Signing failed: ${msg}`
    );
  }
}

// ---- Bootstrap ----

window.addEventListener("DOMContentLoaded", () => {
  $("btn-open").addEventListener("click", openPdf);
  $("btn-open-empty").addEventListener("click", openPdf);
  $("btn-add-signature").addEventListener("click", addSignature);
  $("btn-save").addEventListener("click", openSaveModal);
  wireSaveModal();
});
