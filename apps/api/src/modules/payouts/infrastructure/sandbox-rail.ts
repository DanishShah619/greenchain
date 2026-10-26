import {createHash} from 'node:crypto';
import type {Database} from '../../../kernel/database.js';
import {RailUnknownError,type LookupOutcome,type PayoutRail,type RailContext,type SendOutcome,type SendRequest,type VoidOutcome} from '../domain/rail.js';
/**
 * A deterministic payout rail with persistent memory (docs/23 P9). The token's suffix selects the behaviour:
 *   00 accepted, settles on the next tick          02 timeout, never processed
 *   03 timeout, but processed                      04 two transient failures, then accepted
 *   05 beneficiary rejected                        06 accepted, then returned on the next tick
 *   10 rail down (sends transient, lookups fail)   11 timeout, processed and visible after three ticks (or a resend)
 *   12 settles a different amount (+1 paise)
 * Each call runs in its own transaction and is logged in demo_sandbox_calls, so a rail call never shares a transaction (or a
 * lock) with the ledger. It does not sleep: a "timeout" is reported at once.
 */
type Row={status:string;suffix:string;account_token:string;amount_paise:string;settled_amount_paise:string|null;transient_failures:number;rail_ref:string};
const railRef=(key:string)=>`SBX-${createHash('sha256').update(key).digest('hex').slice(0,12).toUpperCase()}`;
const suffixOf=(token:string)=>token.slice(-2);
const VISIBLE=['PROCESSING','SETTLED','REJECTED','RETURNED','VOIDED'];
export class SandboxRail implements PayoutRail{
  constructor(private db:Database){}
  private async call<T>(c:{scenarioId:string;key:string|null;op:'send'|'get'|'void'|'tick'},work:(tx:Database,row:Row|undefined)=>Promise<{result:string;value:T}>):Promise<T>{
    const outcome=await this.db.transaction(async tx=>{
      const row=c.key?(await tx.query(`SELECT status,suffix,account_token,amount_paise::text AS amount_paise,settled_amount_paise::text AS settled_amount_paise,transient_failures,rail_ref FROM demo_sandbox_rail WHERE payout_id=$1 FOR UPDATE`,[c.key])).rows[0] as Row|undefined:undefined;
      let r:{result:string;value?:T;error?:RailUnknownError};
      try{r=await work(tx,row);}catch(error){if(!(error instanceof RailUnknownError))throw error;r={result:error.code,error};}
      await tx.query('INSERT INTO demo_sandbox_calls(scenario_id,payout_id,op,result) VALUES ($1,$2,$3,$4)',[c.scenarioId,c.key,c.op,r.result]);
      return r;
    });
    if(outcome.error)throw outcome.error;
    return outcome.value as T;
  }
  private async save(tx:Database,r:SendRequest,status:string,o:{ticks?:number;failures?:number;settled?:bigint}={}){
    await tx.query(`INSERT INTO demo_sandbox_rail(payout_id,scenario_id,account_token,amount_paise,suffix,status,ticks,transient_failures,settled_amount_paise,rail_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (payout_id) DO UPDATE SET status=EXCLUDED.status,ticks=EXCLUDED.ticks,transient_failures=EXCLUDED.transient_failures,settled_amount_paise=EXCLUDED.settled_amount_paise,updated_at=now()`,
      [r.key,r.scenarioId,r.accountToken,String(r.amountPaise),suffixOf(r.accountToken),status,o.ticks??0,o.failures??0,o.settled===undefined?null:String(o.settled),railRef(r.key)]);
  }
  send(r:SendRequest):Promise<SendOutcome>{
    return this.call<SendOutcome>({scenarioId:r.scenarioId,key:r.key,op:'send'},async(tx,row)=>{
      const ref=railRef(r.key);
      if(row&&(row.account_token!==r.accountToken||BigInt(row.amount_paise)!==r.amountPaise))return {result:'CONFLICT',value:{kind:'CONFLICT'}};
      // A key already accepted is the same transfer: report where it is, never pay again.
      if(row&&row.status!=='NOT_PROCESSED'){
        if(row.status==='SETTLED')return {result:'SETTLED',value:{kind:'SETTLED',railRef:ref,amountPaise:BigInt(row.settled_amount_paise??row.amount_paise)}};
        if(row.status==='REJECTED'||row.status==='VOIDED')return {result:'REJECTED',value:{kind:'REJECTED',code:row.status==='VOIDED'?'KEY_VOIDED':'BENEFICIARY_REJECTED'}};
        // Accepting a resend makes a late transfer visible, so a payout recorded as SENT can always be found by key.
        if(row.status==='PENDING_LATE')await tx.query(`UPDATE demo_sandbox_rail SET status='PROCESSING',ticks=1,updated_at=now() WHERE payout_id=$1`,[r.key]);
        return {result:'ACCEPTED',value:{kind:'ACCEPTED',railRef:ref}};
      }
      switch(suffixOf(r.accountToken)){
        case '02':await this.save(tx,r,'NOT_PROCESSED');throw new RailUnknownError('RAIL_TIMEOUT');
        case '03':await this.save(tx,r,'PROCESSING',{ticks:1});throw new RailUnknownError('RAIL_TIMEOUT');
        case '11':await this.save(tx,r,'PENDING_LATE',{ticks:3});throw new RailUnknownError('RAIL_TIMEOUT');
        case '04':{
          const failures=row?.transient_failures??0;
          if(failures<2){await this.save(tx,r,'NOT_PROCESSED',{failures:failures+1});return {result:'TRANSIENT',value:{kind:'TRANSIENT',code:'TEMPORARY_FAILURE'}};}
          await this.save(tx,r,'PROCESSING',{ticks:1,failures});return {result:'ACCEPTED',value:{kind:'ACCEPTED',railRef:ref}};
        }
        case '05':await this.save(tx,r,'REJECTED');return {result:'REJECTED',value:{kind:'REJECTED',code:'BENEFICIARY_REJECTED'}};
        case '10':await this.save(tx,r,'NOT_PROCESSED');return {result:'TRANSIENT',value:{kind:'TRANSIENT',code:'RAIL_DOWN'}};
        case '12':await this.save(tx,r,'PROCESSING',{ticks:1,settled:r.amountPaise+1n});return {result:'ACCEPTED',value:{kind:'ACCEPTED',railRef:ref}};
        default:await this.save(tx,r,'PROCESSING',{ticks:1});return {result:'ACCEPTED',value:{kind:'ACCEPTED',railRef:ref}};
      }
    });
  }
  getByKey(c:RailContext):Promise<LookupOutcome>{
    return this.call<LookupOutcome>({scenarioId:c.scenarioId,key:c.key,op:'get'},async(_tx,row)=>{
      if(row?.suffix==='10')throw new RailUnknownError('RAIL_UNAVAILABLE');
      if(!row||!VISIBLE.includes(row.status))return {result:'NOT_FOUND',value:{kind:'NOT_FOUND'}};
      return {result:row.status,value:{kind:'FOUND',status:row.status as any,amountPaise:BigInt(row.settled_amount_paise??row.amount_paise),railRef:row.rail_ref}};
    });
  }
  voidKey(c:RailContext):Promise<VoidOutcome>{
    return this.call<VoidOutcome>({scenarioId:c.scenarioId,key:c.key,op:'void'},async(tx,row)=>{
      if(row?.suffix==='10')throw new RailUnknownError('RAIL_UNAVAILABLE');
      if(row&&['PROCESSING','SETTLED','RETURNED'].includes(row.status))return {result:'ALREADY_PROCESSED',value:'ALREADY_PROCESSED'};
      if(row)await tx.query(`UPDATE demo_sandbox_rail SET status='VOIDED',ticks=0,updated_at=now() WHERE payout_id=$1`,[c.key]);
      else await tx.query(`INSERT INTO demo_sandbox_rail(payout_id,scenario_id,account_token,amount_paise,suffix,status,rail_ref) VALUES ($1,$2,'SANDBOX-00000000-00',1,'00','VOIDED',$3)`,[c.key,c.scenarioId,railRef(c.key)]);
      return {result:'VOIDED',value:'VOIDED'};
    });
  }
  /** One processing step: late transfers come into view, accepted ones settle (or, for 06, are returned). */
  tick(scenarioId:string):Promise<void>{
    return this.call({scenarioId,key:null,op:'tick'},async tx=>{
      await tx.query(`UPDATE demo_sandbox_rail SET ticks=ticks-1,updated_at=now() WHERE scenario_id=$1 AND status IN ('PENDING_LATE','PROCESSING') AND ticks>0`,[scenarioId]);
      await tx.query(`UPDATE demo_sandbox_rail SET status=CASE WHEN suffix='06' THEN 'RETURNED' ELSE 'SETTLED' END,updated_at=now() WHERE scenario_id=$1 AND status='PROCESSING' AND ticks=0`,[scenarioId]);
      await tx.query(`UPDATE demo_sandbox_rail SET status='PROCESSING',ticks=1,updated_at=now() WHERE scenario_id=$1 AND status='PENDING_LATE' AND ticks=0`,[scenarioId]);
      return {result:'OK',value:undefined};
    });
  }
  /** Test oracle: 1 if money under this key was (or will be) paid out, else 0. */
  async processedTransfers(key:string):Promise<number>{
    return (await this.db.query(`SELECT count(*)::int AS n FROM demo_sandbox_rail WHERE payout_id=$1 AND status IN ('PENDING_LATE','PROCESSING','SETTLED','RETURNED')`,[key])).rows[0].n;
  }
}
