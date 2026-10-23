import type {Database} from '../../../kernel/database.js';
import {DEFAULT_LEDGER_CONFIG,sandboxToken,type LedgerConfig} from '../domain/config.js';
import {earningJournals} from '../domain/postings.js';
import {simNow} from './clock.js';
import {postJournals,type JournalPosting} from './journal.js';
/** The configuration in force at a simulated instant: the highest version already effective, else the built-in default. */
export async function readLedgerConfig(tx:Database,scenarioId:string,atSim:Date):Promise<LedgerConfig>{
  const r=(await tx.query(`SELECT version,holdback_days,reserve_bps,min_payout_paise::text AS min,payout_limit_paise::text AS lim,backoff_base_seconds,idempotency_window_seconds
    FROM demo_ledger_config WHERE scenario_id=$1 AND effective_from<=$2 ORDER BY version DESC LIMIT 1`,[scenarioId,atSim])).rows[0];
  if(!r)return DEFAULT_LEDGER_CONFIG;
  return {version:r.version,holdbackDays:r.holdback_days,reserveBps:r.reserve_bps,minPayoutPaise:BigInt(r.min),payoutLimitPaise:BigInt(r.lim),backoffBaseSeconds:r.backoff_base_seconds,idempotencyWindowSeconds:r.idempotency_window_seconds};
}
/**
 * Creates missing payees (synthetic, pre-verified, suffix 00) and takes the payee locks in ascending id order: step (5) of
 * the lock order in docs/23 §6. An existing payee's token is never touched.
 */
export async function lockPayees(tx:Database,scenarioId:string,payeeGroupIds:string[]):Promise<void>{
  const ids=[...new Set(payeeGroupIds)].sort();
  if(!ids.length)return;
  await tx.query(`INSERT INTO demo_payees(scenario_id,payee_group_id,account_token,verified_at) SELECT $1,x.p::uuid,x.t,clock_timestamp() FROM unnest($2::text[],$3::text[]) WITH ORDINALITY AS x(p,t,o) ORDER BY x.o ON CONFLICT DO NOTHING`,
    [scenarioId,ids,ids.map(id=>sandboxToken(id))]);
  await tx.query(`INSERT INTO demo_payee_state(scenario_id,payee_group_id) SELECT $1,p::uuid FROM unnest($2::text[]) AS p ORDER BY p ON CONFLICT DO NOTHING`,[scenarioId,ids]);
  await tx.query('SELECT payee_group_id FROM demo_payee_state WHERE scenario_id=$1 AND payee_group_id=ANY($2::uuid[]) ORDER BY payee_group_id FOR UPDATE',[scenarioId,ids]);
}
export type EarningEntry={ledgerEntryId:string;payeeGroupId:string;grossPaise:bigint;commissionPaise:bigint;netPaise:bigint};
/**
 * Earnings at fulfilment (docs/23 §6.1, P3): E1 and E2 per ledger row, a lot with its EARNED event for every positive net.
 * Runs inside the fulfilment transaction, after the ledger rows; migration 0009 refuses to commit a ledger row without them.
 * Holdback (P5): a payee that has never had a payout SETTLED is held for the configured days of simulated time, decided under
 * the payee lock. Replaying it for the same rows is a no-op.
 */
export async function postEarnings(tx:Database,scenarioId:string,entries:EarningEntry[]):Promise<{journals:number;lots:number}>{
  if(!entries.length)return {journals:0,lots:0};
  const payees=[...new Set(entries.map(e=>e.payeeGroupId))].sort();
  await lockPayees(tx,scenarioId,payees);
  const time=await simNow(tx,scenarioId),config=await readLedgerConfig(tx,scenarioId,time.sim);
  const paid=new Set((await tx.query(`SELECT DISTINCT payee_group_id::text AS p FROM demo_payouts WHERE scenario_id=$1 AND payee_group_id=ANY($2::uuid[]) AND state='SETTLED'`,[scenarioId,payees])).rows.map(r=>r.p as string));
  const postings:JournalPosting[]=[];
  for(const e of entries){
    const j=earningJournals({...e,reserveBps:config.reserveBps});
    postings.push({spec:j.earned,ledgerEntryId:e.ledgerEntryId});
    if(j.funded)postings.push({spec:j.funded,ledgerEntryId:e.ledgerEntryId});
  }
  const {posted}=await postJournals(tx,scenarioId,postings);
  const lots=entries.filter(e=>e.netPaise>0n);
  if(!lots.length)return {journals:posted,lots:0};
  // releasable_at_sim is computed in SQL with the same interval arithmetic as the schema's CHECK.
  const created=(await tx.query(`INSERT INTO demo_earning_lots(ledger_entry_id,scenario_id,payee_group_id,net_paise,earned_sim,releasable_at_sim,holdback_days,reserve_bps,config_version)
    SELECT x.l::bigint,$1,x.p::uuid,x.n::bigint,$2::timestamptz,CASE WHEN x.h THEN $2::timestamptz+make_interval(days=>$3) ELSE $2::timestamptz END,$3,$4,$5
    FROM unnest($6::text[],$7::text[],$8::text[],$9::boolean[]) AS x(l,p,n,h) ON CONFLICT (ledger_entry_id) DO NOTHING RETURNING ledger_entry_id::text AS id`,
    [scenarioId,time.sim,config.holdbackDays,config.reserveBps,config.version,lots.map(e=>e.ledgerEntryId),lots.map(e=>e.payeeGroupId),lots.map(e=>String(e.netPaise)),lots.map(e=>!paid.has(e.payeeGroupId))])).rows.map(r=>r.id as string);
  if(created.length)await tx.query(`INSERT INTO demo_lot_events(ledger_entry_id,seq,scenario_id,state,at_sim) SELECT l::bigint,1,$1,'EARNED',$2 FROM unnest($3::text[]) AS l`,[scenarioId,time.sim,created]);
  return {journals:posted,lots:created.length};
}
