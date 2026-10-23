import {backoffSeconds,withDeadline as kernelDeadline} from '../../../kernel/retry.js';
/** Tunable behaviour of the proof worker. Defaults suit the Amoy testnet demo; all values are validated at startup. */
export type ChainPolicy={
  /** Consecutive failures before a proof that never produced a transaction is parked as FAILED (needs an operator to requeue). */
  maxFailures:number;
  baseDelaySeconds:number;maxDelaySeconds:number;
  /** How often to re-check a proof that is progressing normally. */
  pollSeconds:number;
  /** Upper bound for one call into the chain port (each call may make several RPC requests). */
  portCallDeadlineMs:number;
  /** The signer lease is renewed before every port call, so it only has to outlive one call. */
  leaseSeconds:number;
};
export const DEFAULT_POLICY:ChainPolicy={maxFailures:8,baseDelaySeconds:30,maxDelaySeconds:900,pollSeconds:30,portCallDeadlineMs:45000,leaseSeconds:90};
function integer(env:NodeJS.ProcessEnv,name:string,fallback:number,min:number,max:number){
  const raw=env[name];if(raw===undefined||raw==='')return fallback;
  const value=Number(raw);
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
/** Rejects a combination that could let the lease expire in the middle of a port call. */
export function assertPolicy(policy:ChainPolicy):ChainPolicy{
  if(policy.leaseSeconds*1000<policy.portCallDeadlineMs+15000)throw new Error('The signer lease must outlive one port call by at least 15 seconds');
  if(policy.baseDelaySeconds>policy.maxDelaySeconds)throw new Error('The base retry delay cannot exceed the maximum');
  return policy;
}
export function policyFromEnvironment(env:NodeJS.ProcessEnv=process.env):ChainPolicy{
  return assertPolicy({
    maxFailures:integer(env,'PROOF_MAX_FAILURES',DEFAULT_POLICY.maxFailures,1,50),
    baseDelaySeconds:integer(env,'PROOF_RETRY_BASE_SECONDS',DEFAULT_POLICY.baseDelaySeconds,1,600),
    maxDelaySeconds:integer(env,'PROOF_RETRY_MAX_SECONDS',DEFAULT_POLICY.maxDelaySeconds,1,86400),
    pollSeconds:integer(env,'PROOF_POLL_SECONDS',DEFAULT_POLICY.pollSeconds,5,3600),
    portCallDeadlineMs:integer(env,'PROOF_CALL_DEADLINE_MS',DEFAULT_POLICY.portCallDeadlineMs,1000,120000),
    leaseSeconds:integer(env,'PROOF_LEASE_SECONDS',DEFAULT_POLICY.leaseSeconds,30,600)
  });
}
/**
 * Exponential backoff with jitter: base * 2^(n-1), capped, then scaled by a random factor in [0.8, 1.2] so several
 * workers or proofs do not retry in lock-step. `random` is injectable for deterministic tests.
 */
export function retryDelaySeconds(failureCount:number,policy:ChainPolicy,random:()=>number=Math.random):number{
  return backoffSeconds(failureCount,policy.baseDelaySeconds,policy.maxDelaySeconds,random);
}
/** Safe, bounded-cardinality error codes. Anything not recognised becomes CHAIN_UNKNOWN; raw messages are never kept. */
const OWN_CODES=new Set(['CHAIN_NETWORK_MISMATCH','CHAIN_CONTRACT_MISMATCH','CHAIN_WRITER_MISMATCH','CHAIN_GAS_LIMIT','CHAIN_FEE_LIMIT','CHAIN_PREPARED_TRANSACTION_MISMATCH','CHAIN_ORIGINAL_TRANSACTION_REQUIRED','CHAIN_LEASE_LOST','CHAIN_CYCLE_TIMEOUT']);
const ETHERS_CODES:Record<string,string>={TIMEOUT:'CHAIN_RPC_TIMEOUT',NETWORK_ERROR:'CHAIN_RPC_UNAVAILABLE',SERVER_ERROR:'CHAIN_RPC_UNAVAILABLE',BAD_DATA:'CHAIN_RPC_BAD_RESPONSE',CALL_EXCEPTION:'CHAIN_CALL_REVERTED',INSUFFICIENT_FUNDS:'CHAIN_INSUFFICIENT_FUNDS',NONCE_EXPIRED:'CHAIN_NONCE_CONFLICT',REPLACEMENT_UNDERPRICED:'CHAIN_NONCE_CONFLICT',TRANSACTION_REPLACED:'CHAIN_NONCE_CONFLICT'};
const SYSTEM_CODES=new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','ETIMEDOUT','EAI_AGAIN','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']);
export function classifyChainError(error:unknown,depth=0):string{
  if(error instanceof Error){
    if(OWN_CODES.has(error.message))return error.message;
    const code=(error as {code?:unknown}).code;
    if(typeof code==='string'){
      if(ETHERS_CODES[code])return ETHERS_CODES[code];
      if(SYSTEM_CODES.has(code))return 'CHAIN_RPC_UNAVAILABLE';
    }
    const cause=(error as {cause?:unknown}).cause;
    if(depth<3&&cause instanceof Error&&cause!==error)return classifyChainError(cause,depth+1);
  }
  return 'CHAIN_UNKNOWN';
}
/** Bounds one chain-port call. The underlying work cannot be cancelled, so callers must treat the outcome as unknown and re-inspect. */
export function withDeadline<T>(work:Promise<T>,ms:number):Promise<T>{return kernelDeadline(work,ms,'CHAIN_CYCLE_TIMEOUT');}
