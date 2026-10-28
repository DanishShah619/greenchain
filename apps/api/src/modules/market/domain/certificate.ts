import {createHash,randomBytes} from 'node:crypto';
/**
 * Purchase certificate primitives (docs/24 C2). The hash is SHA-256 over canonical JSON: object keys sorted at every depth,
 * array order kept, no whitespace. Content holds only strings, integers, booleans and null (money is integer paise in strings),
 * so the canonical form is unambiguous and any client can recompute it.
 */
export function canonicalJson(value:unknown):string{
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'){
    if(!Number.isSafeInteger(value))throw new Error('certificate content allows only safe integers (amounts are strings)');
    return String(value);
  }
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(typeof value==='object'){
    const entries=Object.entries(value as Record<string,unknown>);
    for(const [k,v] of entries)if(v===undefined)throw new Error(`certificate field ${k} is undefined`);
    return `{${entries.sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`certificate content cannot hold a ${typeof value}`);
}
export const certificateHash=(content:unknown)=>createHash('sha256').update(canonicalJson(content)).digest('hex');
/** Crockford base32: no I, L, O or U, so a number read aloud or printed cannot be confused. */
const ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CERTIFICATE_NUMBER=/^GC-DEMO-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
/** 40 random bits: not sequential, so numbers cannot be enumerated (the public verification route is rate-limited too). */
export function newCertificateNumber():string{
  const bytes=randomBytes(5);let bits=0n;for(const b of bytes)bits=(bits<<8n)|BigInt(b);
  let out='';for(let i=0;i<8;i++){out=ALPHABET[Number(bits&31n)]+out;bits>>=5n;}
  return `GC-DEMO-${out.slice(0,4)}-${out.slice(4)}`;
}
