import {readFile} from 'node:fs/promises';
import {Contract,FetchRequest,Interface,JsonRpcProvider,Transaction,Wallet,getAddress,keccak256} from 'ethers';
import type {ChainPort,Observation,Prepared,ProofIntent} from '../application/port.js';
export const ABI=[
  'function VERSION() view returns(uint256)','function writer() view returns(address)',
  'function proofs(bytes32) view returns(bytes32 commitment,uint64 anchorSeq,bytes32 anchorHash,uint64 blockNumber)',
  'function anchors(uint64) view returns(bytes32)',
  'function recordProof(bytes32,bytes32,uint64,bytes32)',
  'event ProofRecorded(bytes32 indexed effectId,bytes32 commitment,uint64 anchorSeq,bytes32 anchorHash)'
];
const iface=new Interface(ABI);
export function calldata(intent:ProofIntent){return iface.encodeFunctionData('recordProof',['0x'+intent.effectId,'0x'+intent.commitment,intent.anchorSeq,'0x'+intent.anchorHash]);}
export class EvmProofPort implements ChainPort {
  readonly provider:JsonRpcProvider;private readonly wallet:Wallet;private readonly contract:Contract;
  readonly identity:{network:number;contractAddress:string;signerAddress:string};
  constructor(private readonly config:{rpcUrl:string;network:number;contractAddress:string;codeHash:string;privateKey:string;confirmations:number;maxFeeGwei:number}){
    const request=new FetchRequest(config.rpcUrl);request.timeout=8000;
    this.provider=new JsonRpcProvider(request,undefined,{cacheTimeout:-1,batchMaxCount:1});
    this.wallet=new Wallet(config.privateKey,this.provider);this.contract=new Contract(config.contractAddress,ABI,this.provider);
    this.identity={network:config.network,contractAddress:getAddress(config.contractAddress),signerAddress:this.wallet.address};
  }
  private async ready(){
    const network=await this.provider.getNetwork();if(Number(network.chainId)!==this.config.network)throw new Error('CHAIN_NETWORK_MISMATCH');
    const code=await this.provider.getCode(this.identity.contractAddress);
    if(code==='0x'||keccak256(code).toLowerCase()!==this.config.codeHash.toLowerCase())throw new Error('CHAIN_CONTRACT_MISMATCH');
    if(await this.contract.VERSION()!==1n||getAddress(await this.contract.writer())!==this.wallet.address)throw new Error('CHAIN_WRITER_MISMATCH');
  }
  async prepare(intent:ProofIntent):Promise<Prepared>{
    await this.ready();const data=calldata(intent),nonce=await this.provider.getTransactionCount(this.wallet.address,'pending');
    const estimated=await this.provider.estimateGas({from:this.wallet.address,to:this.identity.contractAddress,data,value:0n});
    const gasLimit=estimated*120n/100n;if(gasLimit>200000n)throw new Error('CHAIN_GAS_LIMIT');
    const fee=await this.provider.getFeeData(),cap=BigInt(this.config.maxFeeGwei)*1000000000n;
    if(fee.maxFeePerGas===null||fee.maxPriorityFeePerGas===null||fee.maxFeePerGas>cap||fee.maxPriorityFeePerGas>cap)throw new Error('CHAIN_FEE_LIMIT');
    const rawTransaction=await this.wallet.signTransaction({type:2,to:this.identity.contractAddress,chainId:this.config.network,nonce,data,value:0n,gasLimit,maxFeePerGas:fee.maxFeePerGas,maxPriorityFeePerGas:fee.maxPriorityFeePerGas});
    return {rawTransaction,transactionHash:keccak256(rawTransaction),nonce,...this.identity};
  }
  private validate(intent:ProofIntent,prepared:Prepared){
    const tx=Transaction.from(prepared.rawTransaction),cap=BigInt(this.config.maxFeeGwei)*1000000000n;
    if(prepared.network!==this.identity.network||getAddress(prepared.contractAddress)!==this.identity.contractAddress||getAddress(prepared.signerAddress)!==this.wallet.address||
      Number(tx.chainId)!==this.identity.network||tx.from!==this.wallet.address||tx.to!==this.identity.contractAddress||tx.value!==0n||tx.data!==calldata(intent)||tx.nonce!==prepared.nonce||
      tx.gasLimit>200000n||tx.maxFeePerGas===null||tx.maxFeePerGas>cap||tx.maxPriorityFeePerGas===null||tx.maxPriorityFeePerGas>cap||keccak256(prepared.rawTransaction)!==prepared.transactionHash)throw new Error('CHAIN_PREPARED_TRANSACTION_MISMATCH');
  }
  async submit(intent:ProofIntent,prepared:Prepared){await this.ready();this.validate(intent,prepared);await this.provider.broadcastTransaction(prepared.rawTransaction);}
  async inspect(intent:ProofIntent,prepared?:Prepared):Promise<Observation>{
    await this.ready();if(prepared)this.validate(intent,prepared);
    const proof=await this.contract.proofs('0x'+intent.effectId),height=await this.provider.getBlockNumber();
    if(proof.blockNumber!==0n){
      if(proof.commitment!=='0x'+intent.commitment||proof.anchorSeq!==BigInt(intent.anchorSeq)||proof.anchorHash!=='0x'+intent.anchorHash||await this.contract.anchors(intent.anchorSeq)!=='0x'+intent.anchorHash)return {status:'RECONCILING',confirmations:0,error:'CHAIN_PROOF_CONFLICT'};
      const blockNumber=Number(proof.blockNumber),logs=await this.provider.getLogs({address:this.identity.contractAddress,fromBlock:blockNumber,toBlock:blockNumber,topics:iface.encodeFilterTopics('ProofRecorded',['0x'+intent.effectId])});
      if(logs.length!==1)return {status:'RECONCILING',confirmations:0,error:'CHAIN_PROOF_RECEIPT_MISSING'};
      if(prepared&&logs[0].transactionHash!==prepared.transactionHash)return {status:'RECONCILING',confirmations:0,error:'CHAIN_EFFECT_TRANSACTION_MISMATCH'};
      const receipt=await this.provider.getTransactionReceipt(logs[0].transactionHash),block=await this.provider.getBlock(blockNumber);
      if(!receipt||receipt.status!==1||!block||block.hash!==receipt.blockHash)return {status:'RECONCILING',confirmations:0,error:'CHAIN_REORG'};
      const confirmations=Math.max(0,height-blockNumber+1);
      return {status:confirmations>=this.config.confirmations?'CONFIRMED':'PENDING',transactionHash:receipt.hash,blockNumber,blockHash:receipt.blockHash,confirmations};
    }
    if(!prepared)return {status:'ABSENT',confirmations:0};
    const receipt=await this.provider.getTransactionReceipt(prepared.transactionHash);
    if(receipt){const block=await this.provider.getBlock(receipt.blockNumber);if(!block||block.hash!==receipt.blockHash)return {status:'RECONCILING',confirmations:0,error:'CHAIN_REORG'};
      return {status:receipt.status===0?'FAILED':'RECONCILING',confirmations:0,error:receipt.status===0?'CHAIN_TRANSACTION_REVERTED':'CHAIN_PROOF_MISSING'};}
    // A consumed nonce with no matching effect must not trigger a newly signed replacement.
    if(await this.provider.getTransactionCount(this.wallet.address,'latest')>prepared.nonce)return {status:'RECONCILING',confirmations:0,error:'CHAIN_NONCE_CONSUMED'};
    return {status:'ABSENT',confirmations:0};
  }
  close(){this.provider.destroy();}
}
export async function amoyFromEnvironment(env:NodeJS.ProcessEnv=process.env):Promise<ChainPort|undefined>{
  const values=[env.AMOY_RPC_URL,env.AMOY_CONTRACT_ADDRESS,env.AMOY_SIGNER_KEY_FILE,env.AMOY_CONTRACT_CODE_HASH];
  if(values.every(v=>!v))return undefined;
  if(values.some(v=>!v))throw new Error('Amoy RPC, contract address, code hash and server signer key file must all be configured');
  if(new URL(env.AMOY_RPC_URL!).protocol!=='https:')throw new Error('Amoy RPC must use HTTPS');
  if(!/^0x[a-fA-F0-9]{64}$/.test(env.AMOY_CONTRACT_CODE_HASH!))throw new Error('Invalid Amoy contract code hash');
  const confirmations=Number(env.AMOY_CONFIRMATIONS??12),maxFeeGwei=Number(env.AMOY_MAX_FEE_GWEI??200);
  if(!Number.isInteger(confirmations)||confirmations<2||confirmations>100||!Number.isInteger(maxFeeGwei)||maxFeeGwei<1||maxFeeGwei>200)throw new Error('Invalid Amoy confirmation or fee policy');
  const privateKey=(await readFile(env.AMOY_SIGNER_KEY_FILE!,'utf8')).trim();
  if(!/^0x[a-fA-F0-9]{64}$/.test(privateKey))throw new Error('Invalid server testnet signer key format');
  try{return new EvmProofPort({rpcUrl:env.AMOY_RPC_URL!,network:80002,contractAddress:env.AMOY_CONTRACT_ADDRESS!,codeHash:env.AMOY_CONTRACT_CODE_HASH!,privateKey,confirmations,maxFeeGwei});}catch{throw new Error('Invalid server testnet signer configuration');}
}
