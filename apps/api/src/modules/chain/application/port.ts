export type ProofIntent={effectId:string;commitment:string;anchorSeq:string;anchorHash:string};
export type Prepared={rawTransaction:string;transactionHash:string;nonce:number;network:number;contractAddress:string;signerAddress:string};
export type Observation={status:'ABSENT'|'PENDING'|'CONFIRMED'|'RECONCILING'|'FAILED';transactionHash?:string;blockNumber?:number;blockHash?:string;confirmations:number;error?:string};
export interface ChainPort {
  readonly identity:{network:number;contractAddress:string;signerAddress:string};
  prepare(intent:ProofIntent):Promise<Prepared>;
  submit(intent:ProofIntent,prepared:Prepared):Promise<void>;
  inspect(intent:ProofIntent,prepared?:Prepared):Promise<Observation>;
  close():void;
}
