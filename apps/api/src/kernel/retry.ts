/**
 * Exponential backoff with jitter: base * 2^(attempt-1), capped at max, then scaled by a random factor in [0.8, 1.2] so several
 * workers do not retry in lock-step. `random` is injectable for deterministic tests.
 */
export function backoffSeconds(attempt:number,baseSeconds:number,maxSeconds:number,random:()=>number=Math.random):number{
  const n=Math.max(1,Math.floor(attempt));
  const exponential=Math.min(maxSeconds,baseSeconds*2**Math.min(n-1,20));
  return Math.round(exponential*(0.8+0.4*random()));
}
/**
 * Bounds one outbound call. The underlying work cannot be cancelled, so callers must treat a timeout as an unknown outcome
 * and re-inspect before doing anything else. `code` becomes the error message (a safe, machine-readable code).
 */
export function withDeadline<T>(work:Promise<T>,ms:number,code:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(code)),ms);});
  return Promise.race([work,timeout]).finally(()=>clearTimeout(timer));
}
