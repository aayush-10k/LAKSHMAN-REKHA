// Independently verify the audit export's signature: recompute the digest from
// the body and recover the signer. Nothing here trusts the export's own claims.
import { keccak256, toBytes, recoverAddress } from 'viem';

const res = await fetch('http://localhost:4000/v1/audit/export?mandateId=demo');
const audit = await res.json();

console.log('HTTP', res.status);
console.log('signatureStatus  ', audit.signatureStatus);
console.log('claimed signer   ', audit.coreSignerAddress);
console.log('digest (reported)', audit.digest);

const recomputed = keccak256(toBytes(JSON.stringify(audit.body)));
console.log('digest (recomputed from body)', recomputed);
console.log('digest matches   ', recomputed === audit.digest);

if (audit.signature) {
  const recovered = await recoverAddress({ hash: recomputed, signature: audit.signature });
  console.log('recovered signer ', recovered);
  console.log('signer matches   ', recovered.toLowerCase() === (audit.coreSignerAddress ?? '').toLowerCase());
} else {
  console.log('signature        ', audit.signature, '(no key configured)');
}

// Prove tampering is detectable.
const tampered = { ...audit.body, mandateId: 'attacker' };
const tamperedDigest = keccak256(toBytes(JSON.stringify(tampered)));
console.log('tampered digest differs', tamperedDigest !== audit.digest);
if (audit.signature) {
  const r = await recoverAddress({ hash: tamperedDigest, signature: audit.signature });
  console.log('tampered recovers to a DIFFERENT address', r.toLowerCase() !== (audit.coreSignerAddress ?? '').toLowerCase(), r);
}
