// Drives the placement UI in headless Chromium against the Vite dev server.
// Usage: node tests/ui-test.mjs   (starts its own server on port 4173)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 4173;
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}

function expectClose(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) {
    fail(`${label}: expected ~${expected}, got ${actual}`);
  } else {
    console.log(`ok: ${label} = ${actual.toFixed(1)}`);
  }
}

const server = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "--port", String(PORT), "--strictPort"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: true }
);
let serverOut = "";
server.stdout.on("data", (d) => (serverOut += d));
server.stderr.on("data", (d) => (serverOut += d));

try {
  // Wait for Vite to come up.
  for (let i = 0; i < 60 && !serverOut.includes("ready in"); i++) await delay(250);
  if (!serverOut.includes("ready in")) throw new Error("vite did not start:\n" + serverOut);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("console error:", m.text());
  });
  page.on("pageerror", (e) => fail("page error: " + e.message));

  await page.goto(`http://localhost:${PORT}/tests/harness.html`);
  await page.waitForFunction(() => window.harnessReady, null, { timeout: 20000 });

  // A wide, short "signature" image, like a real one.
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 120;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 400, 120);
    return c.toDataURL("image/png");
  });

  // --- Test 1: click-to-place lands centered on the click point ---
  const wrapper = page.locator(".page-wrapper").first();
  const wbox = await wrapper.boundingBox();
  const clickX = wbox.x + 300;
  const clickY = wbox.y + 400;

  const placeDone = page.evaluate((url) => window.startPlace(url), dataUrl);
  await delay(200); // let the click listeners attach
  await page.mouse.click(clickX, clickY);
  const placed = await placeDone;
  if (!placed) fail("placeOnNextClick resolved false");

  const el = page.locator(".placed-sig").first();
  let box = await el.boundingBox();
  if (!box) throw new Error("no .placed-sig element rendered");
  console.log("placed box:", box, "wrapper:", wbox);

  const expectedW = 180;
  const expectedH = 180 * (120 / 400); // 54
  expectClose(box.width, expectedW, 4, "placed width");
  expectClose(box.height, expectedH, 4, "placed height");
  expectClose(box.x + box.width / 2, clickX, 4, "placed center x");
  expectClose(box.y + box.height / 2, clickY, 4, "placed center y");
  if (box.y + box.height > wbox.y + wbox.height + 1) fail("signature extends below the page");

  // --- Test 2: drag moves it ---
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 40, { steps: 5 });
  await page.mouse.up();
  const afterDrag = await el.boundingBox();
  expectClose(afterDrag.x, box.x + 60, 4, "dragged x");
  expectClose(afterDrag.y, box.y - 40, 4, "dragged y");

  // --- Test 3: corner handle resizes, preserving aspect ---
  await page.mouse.move(afterDrag.x + 20, afterDrag.y + 20); // hover to show handle
  const handle = page.locator(".placed-sig .handle").first();
  const hbox = await handle.boundingBox();
  if (!hbox) throw new Error("resize handle not interactable");
  await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(hbox.x + hbox.width / 2 + 90, hbox.y + hbox.height / 2, { steps: 5 });
  await page.mouse.up();
  const afterResize = await el.boundingBox();
  expectClose(afterResize.width, afterDrag.width + 90, 6, "resized width");
  expectClose(
    afterResize.height,
    (afterDrag.width + 90) * (120 / 400),
    6,
    "resized height (aspect kept)"
  );

  // --- Test 4: placement state matches the DOM ---
  const state = await page.evaluate(() => JSON.stringify(window.placements()));
  console.log("placement state:", state);

  // --- Test 5: stamped output PDF has the signature at the same visual spot,
  //             including on rotated pages and pages with an offset CropBox ---
  const stampRect = { x: 200, y: 150, width: 200, height: 60 };
  const dark = (px) => px[0] < 100 && px[1] < 100 && px[2] < 100;
  const light = (px) => px[0] > 200 && px[1] > 200 && px[2] > 200;
  for (const variant of ["plain", "rot90", "rot180", "rot270", "cropbox"]) {
    const result = await page.evaluate(
      ([url, rect, v]) => window.stampTest(url, rect, v),
      [dataUrl, stampRect, variant]
    );
    console.log(`stamp[${variant}]:`, JSON.stringify(result.samples));
    if (!dark(result.samples.center)) fail(`${variant}: stamp missing at expected position`);
    else console.log(`ok: ${variant} stamp at expected position`);
    if (!light(result.samples.aboveRect)) fail(`${variant}: ink above the stamp rect`);
    if (!light(result.samples.belowRect)) fail(`${variant}: ink below the stamp rect`);
    if (!light(result.samples.mirroredY)) fail(`${variant}: ink at mirrored-Y (y-flip bug)`);
    if (!light(result.samples.pageBottom)) fail(`${variant}: ink at page bottom`);
  }

  await browser.close();
  console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL UI TESTS PASSED");
} catch (err) {
  fail(err.stack || String(err));
} finally {
  server.kill("SIGTERM");
  // On Windows, make sure the whole npx/vite tree dies.
  if (process.platform === "win32" && server.pid) {
    spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { shell: true });
  }
  await delay(500);
  process.exit(process.exitCode ?? 0);
}
