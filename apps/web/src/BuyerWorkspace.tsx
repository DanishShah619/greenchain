'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {CertificateView,type Certificate} from './CertificateView';
import {formatPaise,isSettling,parseQuantity,quotePaise,remaining,SHORTFALL_REASONS,stateLabel} from './market';
type Request=(path:string,options?:RequestInit)=>Promise<any>;
type Group={group:string;vintage:number;available:number;reserved:number;sold:number;provenance:{batchId:string;calculationId:string}};
type Inventory={label:string;asOf:string;unitPricePaise:string|null;available:number;groups:Group[]};
type OrderSummary={id:string;state:string;quantity:number;allocatedQuantity:number;payablePaise:string;reservedUntil:string|null;createdAt:string};
type Order={order:{id:string;state:string;quantity:number;allocatedQuantity:number;unitPricePaise:string;principalPaise:string;taxPaise:string;taxRule:string;payablePaise:string;reservedUntil:string|null;shortfallReason:string|null;createdAt:string};
  snapshotHash:string;priceChangedFromQuote:boolean;items:{creditId:string;group:string;active:boolean}[];
  payments:{id:string;state:string;amountPaise:string;mismatch:boolean}[];refunds:{kind:string;state:string;amountPaise:string}[];purchased:{creditId:string;pricePaise:string}[];
  allocation:{revision:number;cap:number;capBasisQuantity:number;ok:boolean;reason:string|null;offeredCount:number|null;groups:{group:string;count:number}[]}|null};
const REFUND_KINDS:Record<string,string>={LATE_UNFILLABLE:'Payment arrived after the credits were taken',DUPLICATE_ATTEMPT:'A second payment for the same order',AMOUNT_MISMATCH:'The amount paid did not match the order'};
const shortId=(id:string)=>id.slice(0,8).toUpperCase();
/**
 * Company buyer workspace (docs/22, docs/14 C02-C05): browse demo inventory, order, see why these credits were chosen, pay
 * through the simulated provider, and follow the order to purchase or refund. The server decides everything; this screen
 * only shows stored results and sends the buyer's choices.
 */
export function BuyerWorkspace({request,online=true}:{request:Request;online?:boolean}){
  const [inventory,setInventory]=useState<Inventory|null>(null),[orders,setOrders]=useState<OrderSummary[]>([]),[order,setOrder]=useState<Order|null>(null);
  // The field keeps exactly what the buyer typed; the number is derived from it during render.
  const [quantityText,setQuantityText]=useState('5'),[requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const quantity=parseQuantity(quantityText);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[now,setNow]=useState(()=>Date.now());
  const [certificate,setCertificate]=useState<Certificate|null>(null);
  // Orders and payments are never queued offline (docs/06 §7): every action needs the server, so it is disabled with a reason.
  const blocked=busy||!online;
  const fail=(error:unknown,fallback:string)=>setMessage(error instanceof Error?error.message:fallback);
  async function refresh(selected=order?.order.id){
    const [inv,list]=await Promise.all([request('/market/inventory'),request('/orders')]);
    setInventory(inv);setOrders(list.orders);
    if(selected)setOrder(await request(`/orders/${selected}`));
  }
  useEffect(()=>{refresh().catch(error=>fail(error,'Could not load the marketplace.'));},[]);
  // Countdown tick while something is reserved, and a status refresh while the provider or worker may still change the order.
  useEffect(()=>{
    if(!order)return;
    const tick=['RESERVED','AWAITING_PAYMENT'].includes(order.order.state)?setInterval(()=>setNow(Date.now()),1000):undefined;
    const poll=isSettling(order.order.state)?setInterval(()=>{refresh(order.order.id).catch(()=>{});},3000):undefined;
    return()=>{if(tick)clearInterval(tick);if(poll)clearInterval(poll);};
  },[order?.order.id,order?.order.state]);
  const price=inventory?.unitPricePaise??null,quote=price&&quantity?quotePaise(price,quantity):null;
  async function place(event:FormEvent){
    event.preventDefault();if(!price||!quantity)return;setBusy(true);
    try{
      // The same request id is reused if this is retried after a network failure, so a retry can never create a second order.
      const created:Order=await request('/orders',{method:'POST',body:JSON.stringify({requestId,quantity,quotedTotalPaise:quotePaise(price,quantity)})});
      setRequestId(crypto.randomUUID());setOrder(created);await refresh(created.order.id);
      setMessage(created.order.state==='RESERVED'?`Reserved ${created.order.allocatedQuantity} credits for 5 minutes. Review and continue to payment.`:'Not enough credits fit your order right now. See the offer below.');
      if(created.priceChangedFromQuote)setMessage('The price changed since you looked. Check the new total before paying.');
    }catch(error){fail(error,'The order was not placed. You can retry safely.');}finally{setBusy(false);}
  }
  async function act(path:string,body:unknown,done:string){
    if(!order)return;setBusy(true);
    try{await request(`/orders/${order.order.id}/${path}`,{method:'POST',body:JSON.stringify(body)});await refresh(order.order.id);setMessage(done);}
    catch(error){fail(error,'That did not go through. Refresh and try again.');}finally{setBusy(false);}
  }
  async function open(id:string){setBusy(true);try{setOrder(await request(`/orders/${id}`));setMessage('');}catch(error){fail(error,'Could not open the order.');}finally{setBusy(false);}}
  const o=order?.order,left=o?remaining(o.reservedUntil,now):null,openAttempt=order?.payments.some(p=>['CREATED','PENDING'].includes(p.state));
  return <section className="card buyer">
    <p className="notice demo-banner" role="note"><strong>Demonstration</strong> — synthetic credits and simulated payments. No real money moves and no recognised carbon credits are sold.</p>
    {!online&&<p className="notice" role="alert">You are offline. Ordering and payment need a connection; nothing is queued on this device.</p>}
    <div className="card-heading"><h2>Demo credit marketplace</h2><button className="text-button" disabled={busy} onClick={()=>refresh().catch(error=>fail(error,'Refresh failed.'))}>Refresh</button></div>
    {!inventory&&!message&&<p role="status">Loading the marketplace…</p>}
    {inventory&&<><dl className="market-summary"><div><dt>Available now</dt><dd>{inventory.available} credits</dd></div><div><dt>Price per credit</dt><dd>{formatPaise(price)}</dd></div><div><dt>Farmer groups</dt><dd>{inventory.groups.length}</dd></div></dl>
      <details><summary>Supply by farmer group (pseudonymous)</summary><ul className="group-list">{inventory.groups.map(g=><li key={g.group}><strong>{g.group}</strong><span>{g.available} available · {g.reserved} reserved · {g.sold} sold · vintage {g.vintage}</span><code>batch {g.provenance.batchId} · calculation {g.provenance.calculationId}</code></li>)}</ul></details></>}
    <form onSubmit={place} className="order-form"><label>Credits to buy<input type="number" min={1} max={100} step={1} inputMode="numeric" required aria-invalid={quantity===null} aria-describedby="quantity-help" value={quantityText} onChange={event=>{setQuantityText(event.target.value);setRequestId(crypto.randomUUID());}}/></label>
      <p className="help" id="quantity-help">{quantity===null?'Enter a whole number of credits from 1 to 100. ':`Estimated total ${formatPaise(quote)}. `}Credits are spread across farmer groups that have waited longest for a sale; one group supplies at most 15% of an order. A reservation is held for 5 minutes.</p>
      <button disabled={blocked||!price||quantity===null}>{!price?'No price set yet':quantity===null?'Enter a quantity':`Reserve ${quantity} credit${quantity===1?'':'s'}`}</button></form>
    {orders.length>0&&<><h3 className="section-title">Your orders</h3><div className="case-list">{orders.map(item=><button type="button" className="case-row" key={item.id} disabled={busy} aria-current={item.id===o?.id?'true':undefined} onClick={()=>open(item.id)}>
      <strong>Order {shortId(item.id)} · {stateLabel(item.state)}</strong><span>{item.allocatedQuantity||item.quantity} credits · {formatPaise(item.payablePaise)} · {new Date(item.createdAt).toLocaleString()}</span></button>)}</div></>}
    {order&&o&&<section className="case-detail" aria-labelledby="order-title">
      <div className="card-heading"><h3 id="order-title">Order {shortId(o.id)}</h3><span className="pill">{stateLabel(o.state)}</span></div>
      <dl className="review"><dt>Asked for</dt><dd>{o.quantity} credits</dd><dt>Reserved</dt><dd>{o.allocatedQuantity} credits</dd><dt>Unit price</dt><dd>{formatPaise(o.unitPricePaise)}</dd>
        <dt>Total</dt><dd><strong>{formatPaise(o.payablePaise)}</strong> <small>(demo tax rule: zero)</small></dd>
        {left&&<><dt>Held for</dt><dd>{left} more</dd></>}</dl>
      {order.allocation&&order.allocation.ok&&<div className="allocation"><h4>Why these credits</h4><p>Spread over {order.allocation.groups.length} farmer group{order.allocation.groups.length===1?'':'s'}, at most {order.allocation.cap} from any one group (15% of {order.allocation.capBasisQuantity}), giving priority to groups that have waited longest for a sale.</p>
        <ul className="group-list">{order.allocation.groups.map(g=><li key={g.group}><strong>{g.group}</strong><span>{g.count} credit{g.count===1?'':'s'}</span></li>)}</ul></div>}
      {o.state==='CREATED'&&order.allocation&&!order.allocation.ok&&<div className="notice" role="alert"><p>{SHORTFALL_REASONS[order.allocation.reason??'']??'Not enough credits fit this order.'}</p>
        {order.allocation.offeredCount?<><p>We can reserve <strong>{order.allocation.offeredCount}</strong> of the {o.quantity} credits now, for {formatPaise(quotePaise(o.unitPricePaise,order.allocation.offeredCount))}. Nothing is reserved until you accept.</p>
          <div className="form-actions"><button disabled={blocked} onClick={()=>act('accept-partial',{},'Partial order reserved for 5 minutes.')}>Accept {order.allocation.offeredCount}</button><button className="secondary" disabled={blocked} onClick={()=>act('cancel',{},'Order cancelled.')}>Cancel</button></div></>
          :<p>No credits can be offered right now. Try again later or with a smaller quantity.</p>}</div>}
      {o.state==='RESERVED'&&!openAttempt&&<button disabled={blocked} onClick={()=>act('payment-attempts',{acceptSnapshotHash:order.snapshotHash},'Payment started. Waiting for the payment provider.')}>Continue to payment · {formatPaise(o.payablePaise)}</button>}
      {o.state==='AWAITING_PAYMENT'&&<p className="notice" role="status">Waiting for the payment provider. In this demo the presenter completes the simulated payment from the presenter window. This page updates by itself.</p>}
      {o.state==='AWAITING_PAYMENT'&&!openAttempt&&<button disabled={blocked} onClick={()=>act('payment-attempts',{acceptSnapshotHash:order.snapshotHash},'Payment restarted.')}>Try payment again</button>}
      {(o.state==='RESERVED'||o.state==='AWAITING_PAYMENT')&&<button className="secondary" disabled={blocked} onClick={()=>act('cancel',{},'Order cancelled and credits released.')}>Cancel order</button>}
      {o.state==='FULFILLED'&&<p className="notice">Purchased {order.purchased.length} demo credits. Each one below is now yours and cannot be sold again.</p>}
      {o.state==='FULFILLED'&&<button className="secondary" disabled={blocked} onClick={async()=>{setBusy(true);try{setCertificate((await request(`/orders/${o.id}/certificate`,{method:'POST'})).certificate);}catch(error){fail(error,'Could not issue the certificate.');}finally{setBusy(false);}}}>View purchase certificate</button>}
      {certificate&&certificate.content.number&&<CertificateView certificate={certificate} onClose={()=>setCertificate(null)}/>}
      {o.state==='EXPIRED'&&<p className="notice">The reservation ended before payment. The credits went back on sale. If you were charged, the payment is checked and either completes this order or is refunded in full.</p>}
      {order.purchased.length>0&&<details open><summary>Your credits ({order.purchased.length})</summary><ul className="credit-list">{order.purchased.map(c=><li key={c.creditId}><code>{c.creditId}</code><span>{formatPaise(c.pricePaise)}</span></li>)}</ul></details>}
      {order.purchased.length===0&&order.items.length>0&&o.state!=='CREATED'&&<details><summary>{order.items.some(i=>i.active)?'Reserved credits':'Previously reserved credits'} ({order.items.length})</summary><ul className="credit-list">{order.items.map(i=><li key={i.creditId}><code>{i.creditId}</code><span>{i.group}{i.active?'':' · released'}</span></li>)}</ul></details>}
      {order.refunds.length>0&&<div className="notice"><h4>Refunds</h4><ul>{order.refunds.map((r,i)=><li key={i}>{formatPaise(r.amountPaise)} · {REFUND_KINDS[r.kind]??r.kind} · {r.state==='REFUNDED'?'refunded':'in progress'}</li>)}</ul></div>}
      {order.payments.length>0&&<details><summary>Payment attempts ({order.payments.length})</summary><ul>{order.payments.map(p=><li key={p.id}>{formatPaise(p.amountPaise)} · {p.state.toLowerCase()}{p.mismatch?' · amount did not match':''}</li>)}</ul></details>}
    </section>}
    <p role="status" aria-live="polite" className="status">{message}</p>
  </section>;
}
