/** Pure helpers for credit retirement (docs/25 T8). The server re-checks everything; these only guide the buyer early. */
const PERIOD=/^(FY20[2-9][0-9]-[0-9]{2}|20[2-9][0-9])$/,PURPOSE=/^[A-Za-z0-9 ,.()&:/'-]{1,120}$/;
/** `FY2026-27` (consecutive years) or a calendar year `2026`, as the API accepts. */
export function validReportingPeriod(period:string):boolean{
  if(!PERIOD.test(period))return false;
  return !period.startsWith('FY')||(Number(period.slice(2,6))+1)%100===Number(period.slice(7));
}
/** The Indian financial year (April to March) containing `now`, read in IST. */
export function defaultReportingPeriod(now:Date):string{
  const ist=new Date(now.getTime()+330*60_000),year=ist.getUTCFullYear(),start=ist.getUTCMonth()>=3?year:year-1;
  return `FY${start}-${String((start+1)%100).padStart(2,'0')}`;
}
/** The purpose is optional and shown publicly on the certificate, so plain text only. */
export const validPurpose=(purpose:string)=>purpose===''||PURPOSE.test(purpose);
export const heldCount=(purchased:{retired:boolean}[])=>purchased.filter(c=>!c.retired).length;
/** The live note on a purchase certificate's verification: its frozen content cannot say what happened after the sale. */
export function retiredLine(retired:{credits:number;of:number}):string|null{
  if(retired.credits===0)return null;
  if(retired.of===1)return 'This credit has since been retired.';
  return `${retired.credits} of these ${retired.of} credits have since been retired.`;
}
export const RETIRE_MESSAGES:Record<string,string>={
  NOT_ENOUGH_CREDITS:'This order does not have that many credits left to retire.',
  CREDIT_NOT_RETIRABLE:'Some of these credits are already retired. Refresh to see what is left.',
  ORDER_NOT_FULFILLED:'Credits can be retired once the order is paid.',
  SCENARIO_RETIRED:'This demo scenario was reset. Sign in again to continue in the fresh one.',
  KEY_REUSE:'This retirement was already sent with different details. Refresh and try again.'};
