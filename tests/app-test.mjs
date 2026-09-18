// Drives the REAL app (index.html + main.ts) in headless Chromium with the
// Tauri IPC stubbed, replicating the user flow: open PDF -> draw a signature
// in the modal -> use it -> click to place. Run: node tests/app-test.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4174;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}

// Build the test document the stubbed file dialog will "open".
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 2; i++) {
  const p = doc.addPage([612, 792]);
  p.drawText(`Test document, page ${i + 1}`, { x: 60, y: 720, size: 18, font });
}
const pdfBase64 = Buffer.from(await doc.save()).toString("base64");

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
});
let serverOut = "";
server.stdout.on("data", (d) => (serverOut += d));
server.stderr.on("data", (d) => (serverOut += d));

try {
  for (let i = 0; i < 60 && !serverOut.includes("ready in"); i++) await delay(250);
  if (!serverOut.includes("ready in")) throw new Error("vite did not start:\n" + serverOut);

  const browser = await chromium.launch();
  // Mimic the user's environment: 150% Windows display scaling.
  const page = await browser.newPage({
    viewport: { width: 1200, height: 850 },
    deviceScaleFactor: 1.5,
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("console error:", m.text());
  });
  page.on("pageerror", (e) => fail("page error: " + e.message));

  // Stub the Tauri IPC used by the dialog/fs plugins.
  await page.addInitScript((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    window.__SAVED__ = {};
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (cb) => cb,
      invoke: async (cmd, args) => {
        switch (cmd) {
          case "plugin:dialog|open":
            return "C:/fake/test.pdf";
          case "plugin:dialog|save":
            return "C:/fake/test-signed.pdf";
          case "plugin:fs|read_file":
            return bytes;
          case "plugin:fs|write_file":
            return null;
          default:
            console.warn("unstubbed invoke:", cmd, args);
            return null;
        }
      },
    };
  }, pdfBase64);

  await page.goto(`http://localhost:${PORT}/`);

  // 1. Open the document.
  await page.click("#btn-open");
  await page.waitForSelector(".page-wrapper canvas", { timeout: 20000 });
  console.log("ok: document rendered");
  await page.screenshot({ path: "tests/out-1-opened.png" });

  // 2. Add a drawn signature.
  await page.click("#btn-add-signature");
  await page.waitForSelector("#sig-modal[open]");
  const cbox = await page.locator("#draw-canvas").boundingBox();
  // Scribble a few strokes.
  await page.mouse.move(cbox.x + 50, cbox.y + 120);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(
      cbox.x + 50 + i * 35,
      cbox.y + 100 + Math.sin(i) * 50,
      { steps: 3 }
    );
  }
  await page.mouse.up();
  await page.screenshot({ path: "tests/out-2-drawn.png" });
  await page.click("#btn-sig-use");

  // 3. Click on page 1 to place it.
  const wbox = await page.locator(".page-wrapper").first().boundingBox();
  const clickX = wbox.x + 320;
  const clickY = wbox.y + 500;
  await delay(300);
  await page.mouse.click(clickX, clickY);
  await page.waitForSelector(".placed-sig", { timeout: 5000 });
  const box = await page.locator(".placed-sig").first().boundingBox();
  console.log("placed:", box, "click was at:", { x: clickX, y: clickY }, "wrapper:", wbox);
  await page.screenshot({ path: "tests/out-3-placed.png" });

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (Math.abs(cx - clickX) > 5 || Math.abs(cy - clickY) > 5) {
    fail(`placed signature center (${cx},${cy}) is not at the click point (${clickX},${clickY})`);
  } else {
    console.log("ok: signature centered on click point");
  }
  if (box.width > 200) fail(`placed signature too wide: ${box.width}`);
  else console.log(`ok: placed size ${box.width}x${box.height}`);
  if (box.y + box.height > wbox.y + wbox.height) fail("signature is below the page");

  // 4. Full save path (visual only) through the stubbed dialogs.
  await page.click("#btn-save");
  await page.waitForSelector("#save-modal[open]");
  await page.click("#btn-save-go");
  await page.waitForFunction(
    () => document.getElementById("status-text").textContent.includes("Saved"),
    null,
    { timeout: 20000 }
  );
  console.log("ok: sign & save completed:", await page.locator("#status-text").textContent());

  await browser.close();
  console.log(process.exitCode ? "\nAPP TEST FAILED" : "\nAPP TEST PASSED");
} catch (err) {
  fail(err.stack || String(err));
} finally {
  server.kill("SIGTERM");
  if (process.platform === "win32" && server.pid) {
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { shell: true });
  }
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
