export const METHODOLOGY='demo-practice-ndvi-v1';
export const PARAMETERS='demo-parameters-v1';
export type Preset='standard'|'cloudy'|'no-uplift'|'insufficient';
export const PRESETS:Record<Preset,{project:string;baseline:string;coverage:string;sourceQuality:string;baselineSeasons:number}>={
  standard:{project:'0.6200',baseline:'0.5000',coverage:'0.7500',sourceQuality:'0.9000',baselineSeasons:2},
  cloudy:{project:'0.6200',baseline:'0.5000',coverage:'0.3500',sourceQuality:'0.8000',baselineSeasons:1},
  'no-uplift':{project:'0.4800',baseline:'0.5000',coverage:'0.7500',sourceQuality:'0.9000',baselineSeasons:2},
  insufficient:{project:'0.6200',baseline:'0.5000',coverage:'0.1000',sourceQuality:'0.6000',baselineSeasons:0}
};
export const ASSUMPTIONS={practiceFactors:['0.8000','0.5000'],stackCap:'1.2000',referenceUplift:'0.2000',evidenceShare:'1.0000',confidenceWeights:{coverage:'0.3500',sourceQuality:'0.2500',baseline:'0.2000',practice:'0.2000'},bands:[{minimum:'0.8000',band:'HIGH',buffer:'0.1000'},{minimum:'0.6000',band:'MEDIUM',buffer:'0.2000'},{minimum:'0.4000',band:'LOW',buffer:'0.3000'}],belowThreshold:'NEEDS_VISIT',factorUnit:'tCO2e/ha/demo-cycle',origin:'FIXTURE_SCENARIO'} as const;
export function roundEven(n:bigint,d:bigint):bigint{
  if(n<0n||d<=0n)throw new Error('Invalid rounding operands');
  const q=n/d,r=n%d;return r*2n>d||(r*2n===d&&q%2n===1n)?q+1n:q;
}
function units(value:string){
  if(!/^\d+(?:\.\d{1,4})?$/.test(value))throw new Error('Expected a nonnegative decimal with at most four places');
  const [whole,fraction='']=value.split('.');return BigInt(whole)*10000n+BigInt(fraction.padEnd(4,'0'));
}
const fixed=(value:bigint)=>`${value/10000n}.${String(value%10000n).padStart(4,'0')}`;
export function computeDemo(area:string,preset:Preset){
  const A=units(area);if(A<100n||A>100000000n)throw new Error('Area outside demo bounds');
  const fixture=PRESETS[preset];if(!fixture)throw new Error('Unknown preset');
  const factorSum=ASSUMPTIONS.practiceFactors.map(units).reduce((sum,value)=>sum+value,0n),cap=units(ASSUMPTIONS.stackCap),S=factorSum<cap?factorSum:cap,reference=units(ASSUMPTIONS.referenceUplift);
  const project=units(fixture.project),baseline=units(fixture.baseline),delta=project-baseline;
  const M=delta<=0n?0n:delta>=reference?10000n:roundEven(delta*10000n,reference);
  const baselineScore=roundEven(BigInt(fixture.baselineSeasons)*10000n,3n);
  const weights=ASSUMPTIONS.confidenceWeights;
  const confidence=roundEven(units(fixture.coverage)*units(weights.coverage)+units(fixture.sourceQuality)*units(weights.sourceQuality)+baselineScore*units(weights.baseline)+units(ASSUMPTIONS.evidenceShare)*units(weights.practice),10000n);
  const flags:string[]=[];if(delta<0n)flags.push('BASELINE_EXCEEDS_PROJECT');
  const bandEntry=ASSUMPTIONS.bands.find(entry=>confidence>=units(entry.minimum)),band=bandEntry?.band??null,buffer=bandEntry?units(bandEntry.buffer):null;
  const trace={areaHectares:fixed(A),practiceFactorSum:fixed(factorSum),cappedPracticeFactor:fixed(S),projectNdvi:fixture.project,baselineNdvi:fixture.baseline,referenceUplift:ASSUMPTIONS.referenceUplift,ndviMultiplier:fixed(M),confidenceComponents:{coverage:fixture.coverage,sourceQuality:fixture.sourceQuality,baseline:fixed(baselineScore),practice:ASSUMPTIONS.evidenceShare},confidenceWeights:weights,formula:'gross = area × capped practice factor × NDVI multiplier',rounding:'4 decimal places, round half to even; net = rounded gross minus rounded buffer'};
  if(buffer===null){flags.push('INSUFFICIENT_SIMULATED_EVIDENCE');return {outcome:'NEEDS_VISIT',confidence:fixed(confidence),band,grossCo2e:null,bufferRate:null,bufferCo2e:null,netCo2e:null,wholeTonnes:null,fractionalTonnes:null,flags,trace};}
  const gross=roundEven(A*S*M,100000000n),withheld=roundEven(gross*buffer,10000n),net=gross-withheld;
  return {outcome:'CALCULATED',confidence:fixed(confidence),band,grossCo2e:fixed(gross),bufferRate:fixed(buffer),bufferCo2e:fixed(withheld),netCo2e:fixed(net),wholeTonnes:String(net/10000n),fractionalTonnes:fixed(net%10000n),flags,trace};
}
