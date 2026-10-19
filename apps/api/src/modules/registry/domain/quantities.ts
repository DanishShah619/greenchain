export function units(value:unknown):bigint{
  if(typeof value!=='string'||!/^\d+\.\d{4}$/.test(value))throw new Error('Invalid fixed-scale carbon quantity');
  const [whole,fraction]=value.split('.');return BigInt(whole)*10000n+BigInt(fraction);
}
export const fixed=(value:bigint)=>`${value/10000n}.${String(value%10000n).padStart(4,'0')}`;
export function splitIssuance(result:{grossCo2e:unknown;bufferCo2e:unknown;netCo2e:unknown}){
  const gross=units(result.grossCo2e),buffer=units(result.bufferCo2e),net=units(result.netCo2e);
  if(gross!==buffer+net||gross>120000000n)throw new Error('Carbon quantities do not reconcile');
  return {gross:fixed(gross),buffer:fixed(buffer),net:fixed(net),credits:Number(net/10000n),carry:fixed(net%10000n)};
}
