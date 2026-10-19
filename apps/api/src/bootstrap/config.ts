export function config() {
  const url=process.env.DATABASE_URL,origin=process.env.WEB_ORIGIN;
  if(!url || !origin) throw new Error('DATABASE_URL and WEB_ORIGIN are required');
  if(new URL(origin).origin!==origin) throw new Error('WEB_ORIGIN must be an exact origin');
  const secure=process.env.COOKIE_SECURE==='true';
  if(process.env.COOKIE_SECURE!=='true' && process.env.COOKIE_SECURE!=='false') throw new Error('COOKIE_SECURE must be explicit');
  if(!secure && !['localhost','127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Hosted sessions require secure cookies');
  // Number of trusted reverse-proxy hops in front of the API; leave unset when the API is reached directly.
  const hops=process.env.TRUST_PROXY;
  const trustProxy=hops===undefined||hops===''?undefined:Number(hops);
  if(trustProxy!==undefined&&(!Number.isInteger(trustProxy)||trustProxy<1||trustProxy>5)) throw new Error('TRUST_PROXY must be an integer from 1 to 5 when set');
  return {url,origin,secure,trustProxy};
}
