import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {Contract,ContractFactory,JsonRpcProvider,Wallet,keccak256} from 'ethers';
import {compileContract} from '../scripts/compile-contract.mjs';
import {EvmProofPort,ABI} from '../src/modules/chain/infrastructure/evm.js';
import {digest} from '../src/modules/audit/application/audit.js';
test('local EVM enforces writer/idempotency, validates signer policy and reconciles reorganisations',async()=>{
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()));
  const rpc=`http://127.0.0.1:${port}`,node=spawn(process.execPath,[resolve('../../node_modules/hardhat/dist/src/cli.js'),'node','--network','local','--hostname','127.0.0.1','--port',String(port)],{cwd:process.cwd(),windowsHide:true,stdio:'ignore'});
  const provider=new JsonRpcProvider(rpc,undefined,{cacheTimeout:-1,batchMaxCount:1});let adapter:EvmProofPort|undefined;
  try{
    let online=false;for(let i=0;i<200;i++){if(node.exitCode!==null)throw new Error('Local EVM exited before readiness');try{const response=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});if((await response.json() as any).result==='0x7a69'){online=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(online,'Local EVM starts');
    const writer=Wallet.createRandom().connect(provider);await provider.send('hardhat_setBalance',[writer.address,'0x56BC75E2D63100000']);
    const artifact=await compileContract(),deployed=await new ContractFactory(artifact.abi,artifact.bytecode,writer).deploy(writer.address);await deployed.waitForDeployment();
    const address=await deployed.getAddress(),codeHash=keccak256(await provider.getCode(address));
    adapter=new EvmProofPort({rpcUrl:rpc,network:31337,contractAddress:address,codeHash,privateKey:writer.privateKey,confirmations:2,maxFeeGwei:200});
    const intent={effectId:digest(['effect',1]),commitment:digest(['batch',1]),anchorSeq:'8',anchorHash:digest(['head',8])};
    assert.equal((await adapter.inspect(intent)).status,'ABSENT');const signed=await adapter.prepare(intent);
    await assert.rejects(adapter.submit({...intent,commitment:digest('forged')},signed),/CHAIN_PREPARED_TRANSACTION_MISMATCH/);
    const snapshot=await provider.send('evm_snapshot',[]);await adapter.submit(intent,signed);
    assert.equal((await adapter.inspect(intent,signed)).status,'PENDING');await provider.send('evm_mine',[]);
    assert.equal((await adapter.inspect(intent,signed)).status,'CONFIRMED');
    const contract=new Contract(address,ABI,await provider.getSigner(0));
    await assert.rejects(contract.recordProof('0x'+digest('unauthorized'),'0x'+intent.commitment,8,'0x'+intent.anchorHash));
    const owned=new Contract(address,ABI,writer);
    await (await owned.recordProof('0x'+intent.effectId,'0x'+intent.commitment,8,'0x'+intent.anchorHash)).wait();
    const block=Number((await owned.proofs('0x'+intent.effectId)).blockNumber),events=await provider.getLogs({address,fromBlock:block,toBlock:'latest'});assert.equal(events.length,1,'Replays emit no second proof');
    await assert.rejects(owned.recordProof('0x'+intent.effectId,'0x'+digest('different'),8,'0x'+intent.anchorHash));
    await assert.rejects(owned.recordProof('0x'+digest('other-effect'),'0x'+intent.commitment,8,'0x'+digest('different-head')));
    await provider.send('evm_revert',[snapshot]);assert.equal((await adapter.inspect(intent,signed)).status,'ABSENT');
    await adapter.submit(intent,signed);await provider.send('evm_mine',[]);assert.equal((await adapter.inspect(intent,signed)).status,'CONFIRMED');
    const wrongNetwork=new EvmProofPort({rpcUrl:rpc,network:80002,contractAddress:address,codeHash,privateKey:writer.privateKey,confirmations:2,maxFeeGwei:200});try{await assert.rejects(wrongNetwork.prepare(intent),/CHAIN_NETWORK_MISMATCH/);}finally{wrongNetwork.close();}
    const wrongCode=new EvmProofPort({rpcUrl:rpc,network:31337,contractAddress:address,codeHash:'0x'+'0'.repeat(64),privateKey:writer.privateKey,confirmations:2,maxFeeGwei:200});try{await assert.rejects(wrongCode.prepare(intent),/CHAIN_CONTRACT_MISMATCH/);}finally{wrongCode.close();}
  }finally{adapter?.close();provider.destroy();if(node.exitCode===null){const closed=once(node,'exit');node.kill();await closed;}}
});
