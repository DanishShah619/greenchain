/** Pure helpers for purchase certificates, their public verification page, and the presenter reset (docs/24). */
const NUMBER=/^GC-DEMO-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,HASH=/^[0-9a-f]{64}$/,TX=/^0x[0-9a-fA-F]{64}$/;
export const isCertificateNumber=(value:string)=>NUMBER.test(value);
/** The human verification page for a certificate (the PWA's exported verify.html, which any static host serves without rewrites), carrying the number and its content hash. */
export function verifyLink(origin:string,number:string,hash:string):string{
  return `${origin}/verify.html?n=${encodeURIComponent(number)}&h=${encodeURIComponent(hash)}`;
}
/** Reads ?n= and ?h= strictly: anything malformed is dropped rather than sent to the API. */
export function verifyQuery(search:string):{number:string|null;hash:string|null}{
  const q=new URLSearchParams(search),n=q.get('n')??'',h=q.get('h')??'';
  return {number:NUMBER.test(n)?n:null,hash:HASH.test(h)?h:null};
}
export type Proof={group:string;status:string;network?:number;transactionHash?:string};
export function proofLine(p:Proof):{text:string;href:string|null}{
  if(p.status==='CONFIRMED'&&p.network===80002)return {text:`${p.group}: recorded on Polygon Amoy (testnet)`,href:p.transactionHash&&TX.test(p.transactionHash)?`https://amoy.polygonscan.com/tx/${p.transactionHash}`:null};
  return {text:`${p.group}: blockchain proof pending`,href:null};
}
export const resetConfirmed=(typed:string)=>typed==='RESET';
export const CERTIFICATE_MESSAGES:Record<string,string>={
  ORDER_NOT_FULFILLED:'A certificate is issued once the order is paid.',
  CERTIFICATE_NOT_ISSUED:'No certificate has been issued for this order yet.',
  SCENARIO_RETIRED:'This demo scenario was reset. Sign in again to continue in the fresh one.',
  RATE_LIMITED:'Too many verification checks from this address. Wait a minute and try again.',
  NOT_FOUND:'No certificate has this number.'};
