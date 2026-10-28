import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,certificateHash,newCertificateNumber,CERTIFICATE_NUMBER} from '../src/modules/market/domain/certificate.js';
// The certificate's tamper evidence (docs/24 C2): a hash over canonical JSON, so the same content always hashes the same,
// whatever key order a database or a client produces.
test('canonical JSON sorts keys at every depth, keeps array order, and has no whitespace',()=>{
  assert.equal(canonicalJson({b:1,a:{d:[3,{z:1,y:2}],c:'x'}}),'{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({a:'1',b:'2'}),canonicalJson({b:'2',a:'1'}));
  assert.equal(canonicalJson([{b:1,a:2}]),'[{"a":2,"b":1}]');
  assert.equal(canonicalJson({a:null,b:true,c:'é ₹'}),'{"a":null,"b":true,"c":"é ₹"}');
  assert.throws(()=>canonicalJson({a:undefined}),'undefined has no canonical form');
  assert.throws(()=>canonicalJson({a:1.5}),'money and counts are strings or integers, never floats');
  assert.throws(()=>canonicalJson({a:10n} as any));
});
test('the certificate hash is SHA-256 of the canonical form, independent of key order',()=>{
  assert.match(certificateHash({x:'1'}),/^[0-9a-f]{64}$/);
  assert.equal(certificateHash({x:'1',y:[1,2]}),certificateHash({y:[1,2],x:'1'}));
  assert.notEqual(certificateHash({x:'1'}),certificateHash({x:'2'}));
  assert.equal(certificateHash({}),'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a','sha256 of "{}"');
});
test('certificate numbers are random, unambiguous and never sequential',()=>{
  const seen=new Set<string>();
  for(let i=0;i<2000;i++){const n=newCertificateNumber();assert.match(n,CERTIFICATE_NUMBER);seen.add(n);}
  assert.equal(seen.size,2000,'no repeats in 2000 draws (40 bits of randomness)');
  for(const n of seen)assert.doesNotMatch(n.slice('GC-DEMO-'.length),/[ILOU]/,'Crockford base32: no I, L, O or U in the random part');
});
