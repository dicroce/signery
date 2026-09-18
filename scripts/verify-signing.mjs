// End-to-end check of Signery's digital-signing pipeline, run in Node against
// the same npm packages the app bundles.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { P12Signer } from "@signpdf/signer-p12";
import { SignPdf } from "@signpdf/signpdf";
import forge from "node-forge";
import crypto from "node:crypto";

// --- 1. Generate self-signed p12 (mirrors src/sign.ts generateSelfSignedP12) ---
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "00" + forge.util.bytesToHex(forge.random.getBytesSync(15));
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
const attrs = [{ name: "commonName", value: "Test Signer" }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: "basicConstraints", cA: false },
  { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
  { name: "extKeyUsage", emailProtection: true },
]);
cert.sign(keys.privateKey, forge.md.sha256.create());
const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "hunter2", {
  algorithm: "3des",
  friendlyName: "Test Signer",
});
const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
const p12 = new Uint8Array(p12Der.length);
for (let i = 0; i < p12Der.length; i++) p12[i] = p12Der.charCodeAt(i);
console.log("p12 generated:", p12.length, "bytes");

// --- 2. Build a small PDF and sign it (mirrors src/sign.ts digitallySign) ---
const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText("Signery signing test", { x: 50, y: 700, size: 24, font });

pdflibAddPlaceholder({
  pdfDoc: doc,
  reason: "Testing",
  contactInfo: "",
  name: "Test Signer",
  location: "",
});
const withPlaceholder = await doc.save({ useObjectStreams: false });
const signer = new P12Signer(Buffer.from(p12), { passphrase: "hunter2" });
const signed = await new SignPdf().sign(Buffer.from(withPlaceholder), signer);
console.log("signed PDF:", signed.length, "bytes");

// --- 3. Verify: parse ByteRange + Contents, check CMS SignedData ---
const pdfStr = signed.toString("latin1");
const brMatch = pdfStr.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
if (!brMatch) throw new Error("no ByteRange found");
const [a, b, c, d] = brMatch.slice(1).map(Number);
console.log("ByteRange:", [a, b, c, d]);
if (a + b !== 0 && a !== 0) throw new Error("unexpected ByteRange start");
if (c + d !== signed.length) throw new Error("ByteRange does not cover file end");

const contentsHex = pdfStr.slice(b + 1, c - 1).replace(/\0+$/, "");
const cmsDer = Buffer.from(contentsHex, "hex");
// The /Contents hex string is zero-padded to the placeholder length; let the
// DER length header decide where the CMS structure ends.
const p7 = forge.pkcs7.messageFromAsn1(
  forge.asn1.fromDer(forge.util.createBuffer(cmsDer.toString("binary")), {
    parseAllBytes: false,
  })
);

const signedData = Buffer.concat([signed.subarray(a, a + b), signed.subarray(c, c + d)]);
const actualDigest = crypto.createHash("sha256").update(signedData).digest();

// messageDigest authenticated attribute must equal the hash of the byte ranges.
const signerInfo = p7.rawCapture;
const authAttrs = signerInfo.authenticatedAttributes;
if (!authAttrs) throw new Error("no authenticated attributes");
let messageDigest = null;
const oidMessageDigest = forge.pki.oids.messageDigest;
for (const attr of authAttrs) {
  const oid = forge.asn1.derToOid(attr.value[0].value);
  if (oid === oidMessageDigest) {
    messageDigest = Buffer.from(attr.value[1].value[0].value, "binary");
  }
}
if (!messageDigest) throw new Error("no messageDigest attribute");
console.log("digest matches document bytes:", messageDigest.equals(actualDigest));
if (!messageDigest.equals(actualDigest)) throw new Error("digest mismatch");

// Verify the RSA signature over the authenticated attributes.
const attrsSet = forge.asn1.create(
  forge.asn1.Class.UNIVERSAL,
  forge.asn1.Type.SET,
  true,
  authAttrs
);
const attrDer = Buffer.from(forge.asn1.toDer(attrsSet).getBytes(), "binary");
const sigValue = Buffer.from(signerInfo.signature, "binary");
const pubPem = forge.pki.publicKeyToPem(cert.publicKey);
const ok = crypto
  .createVerify("RSA-SHA256")
  .update(attrDer)
  .verify(pubPem, sigValue);
console.log("CMS signature valid:", ok);
if (!ok) throw new Error("signature verification failed");

console.log("\nALL CHECKS PASSED — pipeline produces a valid PKCS#7 detached signature");
