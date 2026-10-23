import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {Database} from '../../src/kernel/database.js';
import {defaultMigrationsDir,loadMigrations,migrate} from '../../src/kernel/migrate.js';
import type {JournalSpec} from '../../src/modules/payouts/domain/postings.js';
import {pgliteDatabase} from './pglite.js';
import {PRICE} from './market.js';
/** A PGlite database migrated only up to `version`, so data can be written the way an older release wrote it (backfill tests). */
export async function migratedTo(version:number){
  const dir=mkdtempSync(join(tmpdir(),'greenchain-upto-')),source=fileURLToPath(defaultMigrationsDir);
  try{
    for(const m of loadMigrations())if(m.version<=version){const file=`${String(m.version).padStart(4,'0')}_${m.name}.sql`;copyFileSync(join(source,file),join(dir,file));}
    const created=pgliteDatabase();await migrate(created.db,pathToFileURL(dir+'/'));return created;
  }finally{rmSync(dir,{recursive:true,force:true});}
}
/**
 * A FULFILLED order selling `commissions.length` credits of one group, written with direct inserts in the order of docs/22
 * §6.1 (works on any schema from 0007). Each entry is one ledger row's commission; net is the remainder of PRICE. From 0009 a
 * ledger row commits only with its earnings, which `earnings` writes in the same transaction (omit it to prove that).
 */
export type LedgerRow={id:string;credit_id:string;gross_paise:string;commission_paise:string;net_paise:string};
export async function sellDirect(db:Database,o:{scenario:string;group:{capture:string;creditIds:string[]};commissions:bigint[];buyer?:string;price?:bigint;earnings?:(tx:Database,rows:LedgerRow[])=>Promise<unknown>}){
  const id=randomUUID(),n=o.commissions.length,price=o.price??PRICE;
  const credits=(await db.query(`SELECT id FROM demo_credits WHERE id=ANY($1::text[]) AND state='AVAILABLE' ORDER BY id LIMIT $2`,[o.group.creditIds,n])).rows.map(r=>r.id as string);
  if(credits.length<n)throw new Error('not enough credits in the group');
  await db.transaction(async tx=>{
    await tx.query(`INSERT INTO demo_orders(id,scenario_id,buyer_id,request_id,request_hash,quantity,allocated_quantity,state,unit_price_paise,price_effective_from,commission_bps,principal_paise,payable_paise,reserved_until,allocated_at)
      VALUES ($1,$2,$3,$4,'h',$5,$5,'RESERVED',$6,now()-interval '400 days',500,$7,$7,now()+interval '5 minutes',now())`,[id,o.scenario,o.buyer??'buyer-1',randomUUID(),n,String(price),String(price*BigInt(n))]);
    for(const c of credits){
      await tx.query(`INSERT INTO demo_order_items(order_id,scenario_id,credit_id,group_id,generation) VALUES ($1,$2,$3,$4,1)`,[id,o.scenario,c,o.group.capture]);
      await tx.query(`UPDATE demo_credits SET state='RESERVED',reserved_order_id=$2 WHERE id=$1`,[c,id]);
    }
    const attempt=randomUUID();
    await tx.query(`INSERT INTO demo_payment_attempts(id,order_id,scenario_id,provider,provider_ref,state,amount_paise) VALUES ($1,$2,$3,'simulator',$4,'PENDING',$5)`,[attempt,id,o.scenario,`ref-${attempt}`,String(price*BigInt(n))]);
    await tx.query(`UPDATE demo_credits SET state='SOLD' WHERE id=ANY($1::text[])`,[credits]);
    for(const [i,c] of credits.entries())await tx.query(`INSERT INTO demo_ledger_entries(order_id,scenario_id,credit_id,payee_group_id,gross_paise,commission_paise,net_paise) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id,o.scenario,c,o.group.capture,String(price),String(o.commissions[i]),String(price-o.commissions[i])]);
    if(o.earnings)await o.earnings(tx,await ledgerRows(tx,id));
    await tx.query(`UPDATE demo_payment_attempts SET state='SUCCEEDED' WHERE id=$1`,[attempt]);
    await tx.query(`UPDATE demo_orders SET state='FULFILLED' WHERE id=$1`,[id]);
  });
  return {orderId:id,ledger:await ledgerRows(db,id)};
}
const ledgerRows=async(db:Database,orderId:string)=>(await db.query('SELECT id::text AS id,credit_id,gross_paise::text AS gross_paise,commission_paise::text AS commission_paise,net_paise::text AS net_paise FROM demo_ledger_entries WHERE order_id=$1 ORDER BY id',[orderId])).rows as LedgerRow[];
export const sandboxToken=(payee:string,suffix='00')=>`SANDBOX-${payee.replace(/-/g,'').slice(0,8).toUpperCase()}-${suffix}`;
export async function addPayee(db:Database,scenario:string,payee:string,suffix='00'){
  await db.query(`INSERT INTO demo_payees(scenario_id,payee_group_id,account_token,verified_at) VALUES ($1,$2,$3,now())`,[scenario,payee,sandboxToken(payee,suffix)]);
  await db.query(`INSERT INTO demo_payee_state(scenario_id,payee_group_id) VALUES ($1,$2)`,[scenario,payee]);
}
/** Writes a journal exactly as specified (no idempotency handling): the schema tests drive the database guards with it. */
export async function writeJournal(db:Database,scenario:string,spec:JournalSpec,refs:{ledgerEntryId?:string;payoutId?:string;basisBps?:number;lineCount?:number;totalPaise?:bigint}={}){
  const id=(await db.query(`INSERT INTO demo_journal_entries(scenario_id,idempotency_key,kind,payload_hash,line_count,total_paise,ledger_entry_id,payout_id,basis_bps) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text AS id`,
    [scenario,spec.key,spec.kind,spec.payloadHash,refs.lineCount??spec.lines.length,String(refs.totalPaise??spec.totalPaise),refs.ledgerEntryId??null,refs.payoutId??null,refs.basisBps??null])).rows[0].id as string;
  for(const [i,l] of spec.lines.entries())await db.query(`INSERT INTO demo_journal_lines(journal_id,scenario_id,line_no,account,payee_group_id,side,amount_paise) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id,scenario,i+1,l.account,l.payeeGroupId??null,l.side,String(l.amountPaise)]);
  return id;
}
/** Account balance in paise, credit-positive (liabilities and revenue): Σ CR − Σ DR. */
export async function balance(db:Database,scenario:string,account:string,payee?:string){
  const r=await db.query(`SELECT coalesce(sum(CASE side WHEN 'CR' THEN amount_paise ELSE -amount_paise END),0)::text AS b FROM demo_journal_lines WHERE scenario_id=$1 AND account=$2 AND ($3::uuid IS NULL OR payee_group_id=$3)`,[scenario,account,payee??null]);
  return BigInt(r.rows[0].b);
}
/** A batch row; run_date is derived from the simulated time exactly as the schema requires. */
export async function addBatch(db:Database,scenario:string,o:{runSeq?:number;requestId?:string|null;asOfSim?:string}={}){
  const id=randomUUID(),runSeq=o.runSeq??0,requestId=o.requestId===undefined?(runSeq===0?null:randomUUID()):o.requestId,asOf=o.asOfSim??new Date().toISOString();
  await db.query(`INSERT INTO demo_payout_batches(id,scenario_id,run_date,run_seq,request_id,as_of_sim,as_of_real,min_payout_paise,payout_limit_paise,config_version,status,created_by)
    VALUES ($1,$2,($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,$4,$5,$3,now(),10000,5000000,0,'RUNNING','worker')`,[id,scenario,asOf,runSeq,requestId]);
  return id;
}
/** A PENDING payout with the payee's current token (no items: the schema allows it, invariants would not). */
export async function addPayout(db:Database,scenario:string,batchId:string,payee:string,amount=95028n){
  const id=randomUUID();
  await db.query(`INSERT INTO demo_payouts(id,batch_id,scenario_id,payee_group_id,account_token,gross_paise,amount_paise) VALUES ($1,$2,$3,$4,(SELECT account_token FROM demo_payees WHERE scenario_id=$3 AND payee_group_id=$4),$5,$5)`,[id,batchId,scenario,payee,String(amount)]);
  return id;
}
