const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const mobile = createRequire(resolve("apps/client/mobile/package.json"));
const expo = createRequire(mobile.resolve("expo/package.json"));
const cli = createRequire(expo.resolve("@expo/cli/package.json"));
const certificates = createRequire(cli.resolve("@expo/code-signing-certificates/package.json"));
const forge = cli("node-forge");
assert.equal(certificates("node-forge"), forge);
const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 3 });
const digest = forge.md.sha256.create().update("signature regression");
assert.equal(keys.publicKey.verify(digest.digest().bytes(), keys.privateKey.sign(digest)), true);
const a = forge.asn1;
const make = (type, constructed, value) => a.create(a.Class.UNIVERSAL, type, constructed, value);
// Sign deliberately malformed DigestInfo so the test isolates ASN.1 validation,
// without relying on a probabilistic low-exponent signature forgery.
for (const withNull of [false, true]) {
  const algorithm = [make(a.Type.OID, false, a.oidToDer(forge.oids.sha256).getBytes())];
  if (withNull) algorithm.push(make(a.Type.NULL, false, ""));
  const info = make(a.Type.SEQUENCE, true, [
    make(a.Type.SEQUENCE, true, algorithm),
    make(a.Type.OCTETSTRING, false, digest.digest().bytes()),
  ]);
  const sign = () => keys.privateKey.sign(a.toDer(info).getBytes(), "NONE");
  assert.equal(keys.publicKey.verify(digest.digest().bytes(), sign()), true);
  info.value[0].value.push(make(a.Type.OCTETSTRING, false, "unconsumed garbage"));
  assert.throws(() => keys.publicKey.verify(digest.digest().bytes(), sign()), /DigestInfo/);
}
// Expo also uses Forge for certificate generation and verification.
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "01";
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date(Date.now() + 86400000);
cert.setSubject([{ name: "commonName", value: "dependency-test" }]);
cert.setIssuer(cert.subject.attributes);
cert.sign(keys.privateKey, forge.md.sha256.create());
assert.equal(cert.verify(forge.pki.certificateFromPem(forge.pki.certificateToPem(cert))), true);
console.log("Forge rejects nested garbage and preserves signatures and certificates");
