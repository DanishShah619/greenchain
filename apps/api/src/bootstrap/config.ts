import {DEFAULT_MARKET} from '../modules/market/application/orders.js';
import {DEFAULT_PAYMENTS} from '../modules/market/application/payments.js';
import type {MarketRoutesConfig} from '../modules/market/http/routes.js';
/**
 * Buyer slice settings. PAYMENT_WEBHOOK_SECRET enables the payment webhook (and, with DEMO_MODE=true, the presenter's
 * simulator controls); without it neither route exists. PAYMENT_WEBHOOK_SECRET_PREVIOUS keeps the old secret valid during rotation.
 */
export function marketConfig(env:NodeJS.ProcessEnv=process.env):MarketRoutesConfig{
  const secrets=[env.PAYMENT_WEBHOOK_SECRET,env.PAYMENT_WEBHOOK_SECRET_PREVIOUS].filter((v):v is string=>Boolean(v));
  for(const secret of secrets)if(secret.length<32)throw new Error('Payment webhook secrets must be at least 32 characters');
  if(!env.PAYMENT_WEBHOOK_SECRET&&env.PAYMENT_WEBHOOK_SECRET_PREVIOUS)throw new Error('PAYMENT_WEBHOOK_SECRET_PREVIOUS needs a current PAYMENT_WEBHOOK_SECRET');
  const demo=env.DEMO_MODE??'false';
  if(demo!=='true'&&demo!=='false')throw new Error('DEMO_MODE must be true or false');
  const bps=env.DEMO_COMMISSION_BPS===undefined||env.DEMO_COMMISSION_BPS===''?DEFAULT_MARKET.commissionBps:Number(env.DEMO_COMMISSION_BPS);
  if(!Number.isInteger(bps)||bps<0||bps>10000)throw new Error('DEMO_COMMISSION_BPS must be an integer from 0 to 10000');
  const failures=env.PAYMENT_MAX_EVENT_FAILURES===undefined||env.PAYMENT_MAX_EVENT_FAILURES===''?DEFAULT_PAYMENTS.maxEventFailures:Number(env.PAYMENT_MAX_EVENT_FAILURES);
  if(!Number.isInteger(failures)||failures<1||failures>100)throw new Error('PAYMENT_MAX_EVENT_FAILURES must be an integer from 1 to 100');
  return {market:{...DEFAULT_MARKET,commissionBps:bps},payments:{...DEFAULT_PAYMENTS,secrets,maxEventFailures:failures},demoMode:demo==='true'};
}
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
  return {url,origin,secure,trustProxy,market:marketConfig()};
}
