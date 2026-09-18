import { PDFDocument, degrees } from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { P12Signer } from "@signpdf/signer-p12";
import { SignPdf } from "@signpdf/signpdf";
import forge from "node-forge";
import type { DigitalSignOptions, Placement, RenderedPage } from "./types";

/**
 * Flattens the placed signature images into the PDF using pdf-lib.
 * Placement coordinates are CSS pixels in pdf.js viewport space (y-down);
 * viewport.convertToPdfPoint maps them into PDF user space (y-up), which
 * also transparently handles pages with /Rotate set.
 */
export async function stampSignatures(
  pdfBytes: Uint8Array,
  placements: readonly Placement[],
  pages: RenderedPage[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const pdfPages = doc.getPages();
  const embedded = new Map<number, Awaited<ReturnType<typeof doc.embedPng>>>();

  for (const placement of placements) {
    const page = pages[placement.pageIndex];
    const pdfPage = pdfPages[placement.pageIndex];
    if (!page || !pdfPage) continue;

    let image = embedded.get(placement.asset.id);
    if (!image) {
      image = await embedImage(doc, placement.asset.dataUrl);
      embedded.set(placement.asset.id, image);
    }

    const { x, y, width, height } = placement;
    const [blx, bly] = page.viewport.convertToPdfPoint(x, y + height);
    const [brx, bry] = page.viewport.convertToPdfPoint(x + width, y + height);
    const [tlx, tly] = page.viewport.convertToPdfPoint(x, y);

    const wVec = { x: brx - blx, y: bry - bly };
    const hVec = { x: tlx - blx, y: tly - bly };
    const angle = (Math.atan2(wVec.y, wVec.x) * 180) / Math.PI;

    pdfPage.drawImage(image, {
      x: blx,
      y: bly,
      width: Math.hypot(wVec.x, wVec.y),
      height: Math.hypot(hVec.x, hVec.y),
      rotate: degrees(angle),
    });
  }

  return doc.save({ useObjectStreams: false });
}

async function embedImage(doc: PDFDocument, dataUrl: string) {
  if (dataUrl.startsWith("data:image/png")) {
    return doc.embedPng(dataUrl);
  }
  // JPEG / WebP uploads: normalize to PNG through a canvas.
  if (dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg")) {
    return doc.embedJpg(dataUrl);
  }
  const png = await toPng(dataUrl);
  return doc.embedPng(png);
}

function toPng(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("Could not load signature image"));
    img.src = dataUrl;
  });
}

/**
 * Adds a PKCS#7 (adbe.pkcs7.detached) digital signature as an incremental
 * update. Runs entirely in-process; the key never leaves this machine.
 */
export async function digitallySign(
  pdfBytes: Uint8Array,
  opts: DigitalSignOptions
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: opts.reason || "Signed with Signery",
    contactInfo: "",
    name: opts.name || "",
    location: "",
  });
  const withPlaceholder = await doc.save({ useObjectStreams: false });
  const signer = new P12Signer(Buffer.from(opts.p12), {
    passphrase: opts.passphrase,
  });
  const signed = await new SignPdf().sign(Buffer.from(withPlaceholder), signer);
  return new Uint8Array(signed);
}

/**
 * Generates a 2048-bit RSA key and a 10-year self-signed certificate,
 * bundled as password-protected PKCS#12. Pure JS (node-forge), fully offline.
 */
export function generateSelfSignedP12(
  name: string,
  email: string,
  password: string
): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Random positive serial number.
  cert.serialNumber = "00" + forge.util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs: forge.pki.CertificateField[] = [{ name: "commonName", value: name }];
  if (email) attrs.push({ name: "emailAddress", value: email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      nonRepudiation: true,
    },
    { name: "extKeyUsage", emailProtection: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: "3des", // forge's own parser (used by P12Signer) reads this reliably
    friendlyName: name,
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  const bytes = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
  return bytes;
}
