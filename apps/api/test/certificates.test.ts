import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {groupLabel} from '../src/modules/market/application/orders.js';
import {certificateHash,CERTIFICATE_NUMBER} from '../src/modules/market/domain/certificate.js';
import {demoApp} from './support/demo-app.js';
// The purchase certificate (docs/24 C1-C6): built only from stored rows, frozen with a hash, visible to its buyer and the
// presenter, and verifiable by anyone through its number.
async function setup(o:{certificateRatePerMinute?:number}={}){
  const f=await demoApp(o);
  const buyer=await f.session('buyer'),presenter=await f.session('presenter');
  return {...f,buyer,presenter};
}
const ledgerOf=async(f:{db:any},orderId:string)=>(await f.db.query(`SELECT credit_id,payee_group_id::text AS payee,gross_paise::text AS gross FROM demo_ledger_entries WHERE order_id=$1 ORDER BY credit_id`,[orderId])).rows;

test('a buyer issues the certificate of a paid order once; it reconciles to the ledger and its hash covers its exact content',async()=>{
  const f=await setup();
  try{
    const orderId=await f.sell(f.buyer,f.presenter,4);
    const r=await f.send('POST',`/orders/${orderId}/certificate`,f.buyer);
    assert.equal(r.statusCode,201,r.body);
    const {certificate,replayed}=r.json();
    assert.equal(replayed,false);assert.match(certificate.number,CERTIFICATE_NUMBER);
    assert.equal(certificate.contentSha256,certificateHash(certificate.content),'the hash is over the canonical content');
    const c=certificate.content,ledger=await ledgerOf(f,orderId);
    assert.equal(c.namespace,'DEMO_ONLY');assert.equal(c.number,certificate.number);assert.deepEqual(c.buyer,{account:'buyer'});
    assert.deepEqual(c.credits.map((x:any)=>x.id),ledger.map((l:any)=>l.credit_id),'exactly the credits sold to this order');
    assert.ok(c.credits.every((x:any)=>x.tonnes==='1'&&x.vintage===2026));
    assert.deepEqual(c.credits.map((x:any)=>x.group),ledger.map((l:any)=>groupLabel(l.payee)));
    assert.equal(c.groups.reduce((n:number,g:any)=>n+g.credits,0),4);
    assert.equal(c.order.quantity,4);assert.equal(c.order.grossPaise,String(ledger.reduce((n:bigint,l:any)=>n+BigInt(l.gross),0n)));
    assert.equal(c.order.payablePaise,c.order.grossPaise);assert.equal(c.order.taxRule,'DEMO_ZERO');assert.equal(c.order.currency,'INR');
    assert.ok(c.proofs.length>=1&&c.proofs.every((p:any)=>p.status==='PENDING'),'no chain proof yet');
    assert.equal(c.verification.path,`/api/v1/certificates/${certificate.number}`);
    const again=await f.send('POST',`/orders/${orderId}/certificate`,f.buyer);
    assert.equal(again.statusCode,200);assert.deepEqual({...again.json().certificate},certificate);assert.equal(again.json().replayed,true);
    assert.deepEqual((await f.send('GET',`/orders/${orderId}/certificate`,f.buyer)).json().certificate,certificate);
    assert.equal(await f.count(`SELECT count(*)::int AS n FROM audit_events WHERE event_type='market.certificate.issued'`),1);
  }finally{await f.close();}
});

test('only the buyer of the order and the presenter can see its certificate, and an unpaid order has none',async()=>{
  const f=await setup();
  try{
    const orderId=await f.sell(f.buyer,f.presenter,2);
    const {orderId:unpaid}=await f.reserve(f.buyer,2);
    assert.equal((await f.send('GET',`/orders/${orderId}/certificate`,f.buyer)).json().code,'CERTIFICATE_NOT_ISSUED');
    assert.equal((await f.send('POST',`/orders/${unpaid}/certificate`,f.buyer)).json().code,'ORDER_NOT_FULFILLED');
    const number=(await f.send('POST',`/orders/${orderId}/certificate`,f.buyer)).json().certificate.number;
    assert.equal((await f.send('GET',`/orders/${orderId}/certificate`,await f.session('buyer-2'))).statusCode,404,'another buyer');
    assert.equal((await f.send('POST',`/orders/${orderId}/certificate`,await f.session('buyer-2'))).statusCode,404);
    for(const who of ['verifier','agent-2'])assert.equal((await f.send('GET',`/orders/${orderId}/certificate`,await f.session(who))).statusCode,403,who);
    assert.equal((await f.send('GET',`/demo/orders/${orderId}/certificate`,f.presenter)).json().certificate.number,number,'the presenter can show it');
    assert.equal((await f.send('GET',`/demo/orders/${orderId}/certificate`,await f.session('agent-2'))).statusCode,403);
    const {'x-csrf-token':_,...noCsrf}=f.buyer;
    assert.equal((await f.send('POST',`/orders/${orderId}/certificate`,noCsrf)).statusCode,403,'issuing needs CSRF');
  }finally{await f.close();}
});

test('anyone can verify a certificate by its number: content without the buyer account, an integrity check, an optional hash match',async()=>{
  const f=await setup();
  try{
    const orderId=await f.sell(f.buyer,f.presenter,2);
    const cert=(await f.send('POST',`/orders/${orderId}/certificate`,f.buyer)).json().certificate;
    const pub=await f.send('GET',`/certificates/${cert.number}`);
    assert.equal(pub.statusCode,200,pub.body);
    const v=pub.json();
    assert.equal(v.intact,true);assert.equal(v.contentSha256,cert.contentSha256);assert.deepEqual(v.content.buyer,{account:'Demo buyer'});
    assert.deepEqual({...v.content,buyer:cert.content.buyer},cert.content,'only the buyer account is withheld');
    assert.equal((await f.send('GET',`/certificates/${cert.number}?hash=${cert.contentSha256}`)).json().hashMatches,true);
    assert.equal((await f.send('GET',`/certificates/${cert.number}?hash=${'0'.repeat(64)}`)).json().hashMatches,false);
    assert.equal((await f.send('GET',`/certificates/${cert.number}?hash=nothex`)).statusCode,400);
    assert.equal((await f.send('GET','/certificates/GC-DEMO-0000-0000')).statusCode,404);
    assert.equal((await f.send('GET','/certificates/not-a-number')).statusCode,400);
    const captures=(await f.db.query('SELECT event_id::text AS id FROM captures')).rows.map((r:any)=>r.id);
    for(const secret of [...captures,orderId,'Market seed farmer','Synthetic village','"account":"buyer"'])assert.ok(!pub.body.includes(secret),`public view leaks ${secret}`);
  }finally{await f.close();}
});

test('tampering is evident: the stored certificate cannot be edited, and an edit that bypasses the guard fails verification',async()=>{
  const f=await setup();
  try{
    const orderId=await f.sell(f.buyer,f.presenter,2);
    const cert=(await f.send('POST',`/orders/${orderId}/certificate`,f.buyer)).json().certificate;
    await assert.rejects(f.db.query(`UPDATE demo_certificates SET content=jsonb_set(content,'{order,quantity}','99')`));
    await assert.rejects(f.db.query('DELETE FROM demo_certificates'));
    await f.db.query('SET session_replication_role = replica');
    await f.db.query(`UPDATE demo_certificates SET content=jsonb_set(content,'{order,quantity}','99')`);
    await f.db.query('SET session_replication_role = origin');
    const v=(await f.send('GET',`/certificates/${cert.number}?hash=${cert.contentSha256}`)).json();
    assert.equal(v.intact,false);assert.equal(v.hashMatches,false);
  }finally{await f.close();}
});

test('a confirmed chain proof of an issuance batch appears on the certificate, with its network and transaction',async()=>{
  const f=await setup();
  try{
    const tx=`0x${'ab'.repeat(32)}`;
    for(const b of (await f.db.query(`SELECT id::text AS id FROM demo_issuance_batches WHERE scenario_id='presenter'`)).rows){
      const event=randomUUID();
      await f.db.query(`INSERT INTO demo_registry_events(id,batch_id,event_type,payload) VALUES ($1,$2,'demo.credits.issued','{}'::jsonb)`,[event,b.id]);
      await f.db.query(`INSERT INTO demo_chain_proofs(event_id,batch_id,commitment,anchor_seq,anchor_hash,status,network,contract_address,signer_address,transaction_hash,block_number,block_hash,confirmations)
        VALUES ($1,$2,'c',1,'a','CONFIRMED',80002,'0xcontract','0xsigner',$3,123,'0xblock',12)`,[event,b.id,tx]);
    }
    const orderId=await f.sell(f.buyer,f.presenter,2);
    const c=(await f.send('POST',`/orders/${orderId}/certificate`,f.buyer)).json().certificate.content;
    assert.ok(c.proofs.length>=1);
    for(const p of c.proofs)assert.deepEqual({status:p.status,network:p.network,transactionHash:p.transactionHash},{status:'CONFIRMED',network:80002,transactionHash:tx});
  }finally{await f.close();}
});

test('the public verification route is rate-limited per address',async()=>{
  const f=await setup({certificateRatePerMinute:3});
  try{
    const statuses=[];for(let i=0;i<4;i++)statuses.push((await f.send('GET','/certificates/GC-DEMO-0000-0000')).statusCode);
    assert.deepEqual(statuses,[404,404,404,429]);
  }finally{await f.close();}
});
