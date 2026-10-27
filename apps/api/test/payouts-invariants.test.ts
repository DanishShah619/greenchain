import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from '../src/kernel/database.js';
import {runDueBatches} from '../src/modules/payouts/application/batch.js';
import {assertPayoutInvariants,PAYOUT_INVARIANT_CODES} from '../src/modules/payouts/application/invariants.js';
import {runSettlementCycle} from '../src/modules/payouts/application/settlement.js';
import {sandboxToken} from '../src/modules/payouts/domain/config.js';
import {SandboxRail} from '../src/modules/payouts/infrastructure/sandbox-rail.js';
import {seedMarket} from './support/market.js';
import {migratedPglite} from './support/pglite.js';
import {sellViaWebhook,setLedgerConfig} from './support/payouts.js';
// The ledger invariants of docs/23 §8, checked in one read-only snapshot per scenario. The database guards prevent these states,
// so each violation is planted with triggers switched off (session_replication_role = replica), as only a bypass could.
async function populated(){
  const {db}=await migratedPglite();
  const m=await seedMarket(db,{groups:3,perGroup:20,buyers:['buyer-1','buyer-2','buyer-3','buyer-4','buyer-5']});
  await setLedgerConfig(db,m.scenario,1,{holdbackDays:0});
  for(let i=0;i<4;i++)await sellViaWebhook(db,{buyerId:`buyer-${i+1}`,quantity:2});
  await sellViaWebhook(db,{buyerId:'buyer-5',market:{commissionBps:10000,reservationSeconds:300,shortfallHoldSeconds:900}});
  const payees=(await db.query('SELECT payee_group_id::text AS p FROM demo_payees ORDER BY 1')).rows.map(r=>r.p as string);
  const returning=(await db.query('SELECT min(payee_group_id::text) AS p FROM demo_earning_lots')).rows[0].p as string;
  await db.query('UPDATE demo_payees SET account_token=$2 WHERE payee_group_id=$1',[returning,sandboxToken(returning,'06')]);
  const rail=new SandboxRail(db);
  await runDueBatches(db,m.scenario);
  for(let i=0;i<2;i++)await runSettlementCycle(db,m.scenario,{rail});
  return {db,scenario:m.scenario,payees};
}
const bypass=async(db:Database,sql:string,values:unknown[]=[])=>{
  await db.query(`SET session_replication_role = replica`);
  try{await db.query(sql,values);}finally{await db.query(`SET session_replication_role = origin`);}
};
const codes=async(db:Database,scenario:string)=>[...new Set((await assertPayoutInvariants(db,scenario)).map(v=>v.code))].sort();

test('a real flow (sales, a 100% commission sale, payouts settled and returned) satisfies every invariant',async()=>{
  const {db,scenario}=await populated();
  const states=(await db.query('SELECT DISTINCT state FROM demo_payouts ORDER BY 1')).rows.map(r=>r.state);
  assert.deepEqual(states,['RETURNED','SETTLED'],'one payout returned (06), the rest settled');
  assert.deepEqual(await assertPayoutInvariants(db,scenario),[]);
  assert.equal(PAYOUT_INVARIANT_CODES.length,9);
});

test('each invariant reports its own violation, and refs never carry a payee id',async()=>{
  const cases:[string,(f:Awaited<ReturnType<typeof populated>>)=>Promise<unknown>][]=[
    ['JOURNAL_UNBALANCED',f=>bypass(f.db,`UPDATE demo_journal_lines SET amount_paise=amount_paise+1 WHERE line_no=1 AND journal_id=(SELECT min(journal_id) FROM demo_journal_lines)`)],
    ['PAYABLE_MISMATCH',f=>bypass(f.db,`UPDATE demo_lot_events SET state='PAID' WHERE (ledger_entry_id,seq) IN (SELECT ledger_entry_id,seq FROM demo_lot_events WHERE state='RELEASED' LIMIT 1)`)],
    ['LEDGER_PARITY',f=>bypass(f.db,`DELETE FROM demo_earning_lots WHERE ledger_entry_id=(SELECT max(ledger_entry_id) FROM demo_earning_lots)`)],
    ['PAYOUT_ITEMS_MISMATCH',f=>bypass(f.db,`UPDATE demo_payouts SET gross_paise=gross_paise+1,amount_paise=amount_paise+1 WHERE id=(SELECT id FROM demo_payouts WHERE state='SETTLED' LIMIT 1)`)],
    ['LOT_PAYOUT_STATE',f=>bypass(f.db,`UPDATE demo_payouts SET state='SENT' WHERE id=(SELECT id FROM demo_payouts WHERE state='SETTLED' LIMIT 1)`)],
    ['CLEARING_MISMATCH',f=>bypass(f.db,`DELETE FROM demo_journal_lines WHERE journal_id=(SELECT id FROM demo_journal_entries WHERE kind='PAYOUT_BATCHED' LIMIT 1)`)],
    ['RESERVE_MISMATCH',f=>bypass(f.db,`UPDATE demo_journal_entries SET basis_bps=2500 WHERE id=(SELECT id FROM demo_journal_entries WHERE kind='RESERVE_FUNDED' LIMIT 1)`)],
    ['CONSERVATION',f=>bypass(f.db,`UPDATE demo_payouts SET state='CANCELLED' WHERE id=(SELECT id FROM demo_payouts WHERE state='SETTLED' LIMIT 1)`)],
    ['BUYER_CLEARING',f=>bypass(f.db,`UPDATE demo_ledger_entries SET gross_paise=gross_paise+1,net_paise=net_paise+1 WHERE id=(SELECT max(id) FROM demo_ledger_entries)`)],
  ];
  for(const [code,plant] of cases){
    const f=await populated();
    await plant(f);
    const found=await assertPayoutInvariants(f.db,f.scenario);
    assert.ok(found.some(v=>v.code===code),`${code}: got ${JSON.stringify(found)}`);
    for(const v of found)assert.ok(!f.payees.some(p=>v.ref.includes(p)),`${code}: a ref must not carry a payee id (${v.ref})`);
  }
});

test('the check is scoped: another scenario with a violation does not leak into this one',async()=>{
  const f=await populated();
  const other=await seedMarket(f.db,{scenario:'other-market',groups:1,perGroup:4,buyers:['buyer-x']});
  await setLedgerConfig(f.db,other.scenario,1,{holdbackDays:0});
  await sellViaWebhook(f.db,{buyerId:'buyer-x',scenario:other.scenario});
  await bypass(f.db,`UPDATE demo_journal_lines SET amount_paise=amount_paise+1 WHERE scenario_id='other-market' AND line_no=1`);
  assert.deepEqual(await assertPayoutInvariants(f.db,f.scenario),[]);
  assert.ok((await codes(f.db,'other-market')).includes('JOURNAL_UNBALANCED'));
});
