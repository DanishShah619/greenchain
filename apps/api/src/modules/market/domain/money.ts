/** Money is integer paise held in BigInt: no floats, and exact beyond Number.MAX_SAFE_INTEGER (docs/09 §5, docs/22 B7). */
export function commissionPaise(gross:bigint,bps:number):bigint{
  if(typeof gross!=='bigint'||gross<0n)throw new Error('gross must be a non-negative bigint');
  if(!Number.isInteger(bps)||bps<0||bps>10000)throw new Error('commission bps must be an integer from 0 to 10000');
  const numerator=gross*BigInt(bps),quotient=numerator/10000n,twiceRemainder=(numerator%10000n)*2n;
  // Half-even: round up above one half, down below it, and to the even neighbour on an exact half.
  if(twiceRemainder>10000n||(twiceRemainder===10000n&&quotient%2n===1n))return quotient+1n;
  return quotient;
}
/** One ledger line (one credit). The net is the exact remainder, so commission + net always equals gross. */
export function ledgerLine(gross:bigint,bps:number){const commission=commissionPaise(gross,bps);return {gross,commission,net:gross-commission};}
