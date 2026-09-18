// Captures README screenshots by driving the real app in Chromium with the
// Tauri IPC stubbed. Usage: node scripts/screenshots.mjs  ->  images/*.png
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = 4175;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "images");
fs.mkdirSync(OUT, { recursive: true });

// --- A plausible-looking agreement document ---
async function makePdf() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  const gray = rgb(0.25, 0.27, 0.3);

  page.drawText("CONSULTING AGREEMENT", { x: 170, y: 720, size: 20, font: bold, color: gray });
  const lines = [
    "This Consulting Agreement (the \u201CAgreement\u201D) is entered into as of the date of the",
    "last signature below (the \u201CEffective Date\u201D) by and between Acme Widgets LLC and",
    "the undersigned consultant (the \u201CConsultant\u201D).",
    "",
    "1. Services. Consultant agrees to perform the services described in Exhibit A with",
    "    professional skill and diligence.",
    "",
    "2. Compensation. Company shall pay Consultant the fees set forth in Exhibit B",
    "    within thirty (30) days of receipt of a proper invoice.",
    "",
    "3. Confidentiality. Consultant shall hold in strict confidence all non-public",
    "    information disclosed by the Company.",
    "",
    "4. Term. This Agreement remains in effect until the Services are complete unless",
    "    terminated earlier by either party upon fourteen (14) days written notice.",
    "",
    "IN WITNESS WHEREOF, the parties have executed this Agreement as of the",
    "Effective Date.",
  ];
  let y = 670;
  for (const line of lines) {
    if (line) page.drawText(line, { x: 72, y, size: 11, font: helv, color: gray });
    y -= 18;
  }
  y -= 40;
  page.drawLine({ start: { x: 72, y }, end: { x: 300, y }, thickness: 1, color: gray });
  page.drawText("Consultant signature", { x: 72, y: y - 16, size: 9, font: helv, color: gray });
  page.drawLine({ start: { x: 340, y }, end: { x: 540, y }, thickness: 1, color: gray });
  page.drawText("Date", { x: 340, y: y - 16, size: 9, font: helv, color: gray });
  return { bytes: Buffer.from(await doc.save()).toString("base64"), sigLineY: y };
}

const { bytes: pdfBase64 } = await makePdf();

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
});
let serverOut = "";
server.stdout.on("data", (d) => (serverOut += d));
server.stderr.on("data", (d) => (serverOut += d));

async function newAppPage(browser, { dark = false } = {}) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: dark ? "dark" : "light",
  });
  await page.addInitScript((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (cb) => cb,
      invoke: async (cmd) => {
        switch (cmd) {
          case "plugin:dialog|open": return "C:/Documents/consulting-agreement.pdf";
          case "plugin:dialog|save": return "C:/Documents/consulting-agreement-signed.pdf";
          case "plugin:fs|read_file": return bytes;
          default: return null;
        }
      },
    };
  }, pdfBase64);
  await page.goto(`http://localhost:${PORT}/`);
  return page;
}

async function drawSignature(page) {
  const c = await page.locator("#draw-canvas").boundingBox();
  // A flowing, signature-like set of strokes.
  const baseX = c.x + 60;
  const baseY = c.y + 120;
  const curve = [
    [0, 0], [15, -55], [30, -70], [42, -50], [48, -8], [50, 25], [46, 40],
    [38, 30], [40, 0], [55, -20], [75, -28], [95, -18], [108, 0], [118, 8],
    [135, 2], [150, -18], [162, -35], [168, -20], [170, 5], [178, 12],
    [195, 6], [215, -10], [240, -22], [270, -18], [300, -6], [330, -2],
  ];
  await page.mouse.move(baseX + curve[0][0], baseY + curve[0][1]);
  await page.mouse.down();
  for (const [dx, dy] of curve.slice(1)) {
    await page.mouse.move(baseX + dx, baseY + dy, { steps: 4 });
  }
  await page.mouse.up();
}

try {
  for (let i = 0; i < 60 && !serverOut.includes("ready in"); i++) await delay(250);
  if (!serverOut.includes("ready in")) throw new Error("vite did not start:\n" + serverOut);
  const browser = await chromium.launch();

  // --- Shot 1: signature modal, Draw tab ---
  let page = await newAppPage(browser);
  await page.click("#btn-open");
  await page.waitForSelector(".page-wrapper canvas");
  await page.click("#btn-add-signature");
  await page.waitForSelector("#sig-modal[open]");
  await drawSignature(page);
  await delay(200);
  await page.screenshot({ path: path.join(OUT, "draw-signature.png") });
  console.log("captured draw-signature.png");

  // --- Shot 2: signature placed on the document (hero) ---
  await page.click("#btn-sig-use");
  await delay(300);
  const wbox = await page.locator(".page-wrapper").first().boundingBox();
  // Land it on the signature line (~72..300 PDF units from left, lower third).
  await page.mouse.click(wbox.x + 210, wbox.y + 660);
  await page.waitForSelector(".placed-sig");
  await page.mouse.move(wbox.x + 700, wbox.y + 200); // unhover
  await delay(200);
  await page.screenshot({ path: path.join(OUT, "main.png") });
  console.log("captured main.png");

  // --- Shot 3: sign & save modal with self-signed generation ---
  await page.click("#btn-save");
  await page.waitForSelector("#save-modal[open]");
  await page.check("#chk-digital");
  await page.check('input[name="certsource"][value="generate"]');
  await page.fill("#gen-name", "Jordan Example");
  await page.fill("#gen-email", "jordan@example.com");
  await page.fill("#gen-pass", "correct horse battery staple");
  await page.fill("#sign-reason", "I approve this agreement");
  await delay(150);
  await page.screenshot({ path: path.join(OUT, "sign-and-save.png") });
  console.log("captured sign-and-save.png");
  await page.close();

  // --- Shot 4: dark mode ---
  page = await newAppPage(browser, { dark: true });
  await page.click("#btn-open");
  await page.waitForSelector(".page-wrapper canvas");
  await page.click("#btn-add-signature");
  await page.waitForSelector("#sig-modal[open]");
  await drawSignature(page);
  await page.click("#btn-sig-use");
  await delay(300);
  const wbox2 = await page.locator(".page-wrapper").first().boundingBox();
  await page.mouse.click(wbox2.x + 210, wbox2.y + 660);
  await page.waitForSelector(".placed-sig");
  await page.mouse.move(wbox2.x + 700, wbox2.y + 200);
  await delay(200);
  await page.screenshot({ path: path.join(OUT, "dark-mode.png") });
  console.log("captured dark-mode.png");

  await browser.close();
  console.log("done");
} catch (err) {
  console.error("FAIL:", err.stack || String(err));
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  if (process.platform === "win32" && server.pid) {
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { shell: true });
  }
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
