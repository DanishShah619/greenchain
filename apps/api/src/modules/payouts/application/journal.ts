import type {Database} from '../../../kernel/database.js';
import {WorkflowError} from '../../../kernel/errors.js';
import type {JournalSpec} from '../domain/postings.js';
export type JournalPosting={spec:JournalSpec;ledgerEntryId?:string;payoutId?:string};
/**
 * Writes journals in two set-based statements (entries, then lines), idempotent by key: a key already posted with the same
 * payload hash is skipped, a key posted with different content is refused. The database checks every journal's size,
 * balance, accounts and hash at commit (migrations 0008, 0009).
 */
export async function postJournals(tx:Database,scenarioId:string,postings:JournalPosting[]):Promise<{posted:number;replayed:number}>{
  if(!postings.length)return {posted:0,replayed:0};
  const byKey=new Map(postings.map(p=>[p.spec.key,p]));
  if(byKey.size!==postings.length)throw new WorkflowError('JOURNAL_KEY_CONFLICT',409);
  const inserted=(await tx.query(`INSERT INTO demo_journal_entries(scenario_id,idempotency_key,kind,payload_hash,line_count,total_paise,ledger_entry_id,payout_id,basis_bps)
    SELECT $1,x.k,x.kind,x.h,x.n,x.t::bigint,x.l::bigint,x.p::uuid,x.b FROM unnest($2::text[],$3::text[],$4::text[],$5::int[],$6::text[],$7::text[],$8::text[],$9::int[]) AS x(k,kind,h,n,t,l,p,b)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id::text AS id,idempotency_key AS k`,
    [scenarioId,postings.map(p=>p.spec.key),postings.map(p=>p.spec.kind),postings.map(p=>p.spec.payloadHash),postings.map(p=>p.spec.lines.length),postings.map(p=>String(p.spec.totalPaise)),
      postings.map(p=>p.ledgerEntryId??null),postings.map(p=>p.payoutId??null),postings.map(p=>p.spec.basisBps??null)])).rows as {id:string;k:string}[];
  const fresh=new Set(inserted.map(r=>r.k)),repeated=postings.filter(p=>!fresh.has(p.spec.key));
  if(repeated.length){
    const existing=(await tx.query('SELECT idempotency_key AS k,payload_hash AS h,scenario_id AS s FROM demo_journal_entries WHERE idempotency_key=ANY($1::text[])',[repeated.map(p=>p.spec.key)])).rows;
    const same=new Map(existing.map(r=>[r.k as string,r.h===byKey.get(r.k)!.spec.payloadHash&&r.s===scenarioId]));
    if(repeated.some(p=>!same.get(p.spec.key)))throw new WorkflowError('JOURNAL_KEY_CONFLICT',409);
  }
  const lines=inserted.flatMap(r=>byKey.get(r.k)!.spec.lines.map((l,i)=>({journal:r.id,no:i+1,...l})));
  if(lines.length)await tx.query(`INSERT INTO demo_journal_lines(journal_id,scenario_id,line_no,account,payee_group_id,side,amount_paise)
    SELECT x.j::bigint,$1,x.no,x.a,x.p::uuid,x.s,x.amt::bigint FROM unnest($2::text[],$3::int[],$4::text[],$5::text[],$6::text[],$7::text[]) AS x(j,no,a,p,s,amt)`,
    [scenarioId,lines.map(l=>l.journal),lines.map(l=>l.no),lines.map(l=>l.account),lines.map(l=>l.payeeGroupId??null),lines.map(l=>l.side),lines.map(l=>String(l.amountPaise))]);
  return {posted:inserted.length,replayed:repeated.length};
}
