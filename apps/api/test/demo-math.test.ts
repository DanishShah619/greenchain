import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeDemo,roundEven} from '../src/modules/mrv/domain/demo.js';
test('placeholder worked example reproduces gross, confidence, buffer and net exactly',()=>{
  const result=computeDemo('1.2500','standard');
  assert.equal(result.grossCo2e,'0.9000');assert.equal(result.confidence,'0.8208');
  assert.equal(result.bufferRate,'0.1000');assert.equal(result.bufferCo2e,'0.0900');assert.equal(result.netCo2e,'0.8100');
  assert.equal(result.wholeTonnes,'0');assert.equal(result.fractionalTonnes,'0.8100');
  assert.deepEqual(computeDemo('1.25','standard'),result);
});
test('zero uplift is a valid zero result and low confidence never invents tonnes',()=>{
  const zero=computeDemo('1.25','no-uplift');assert.equal(zero.grossCo2e,'0.0000');assert.equal(zero.netCo2e,'0.0000');assert.deepEqual(zero.flags,['BASELINE_EXCEEDS_PROJECT']);
  const insufficient=computeDemo('1.25','insufficient');assert.equal(insufficient.outcome,'NEEDS_VISIT');assert.equal(insufficient.confidence,'0.3850');assert.equal(insufficient.grossCo2e,null);assert.equal(insufficient.netCo2e,null);
  const cloudy=computeDemo('1.25','cloudy');assert.equal(cloudy.confidence,'0.5892');assert.equal(cloudy.band,'LOW');assert.equal(cloudy.bufferRate,'0.3000');assert.equal(cloudy.netCo2e,'0.6300');
});
test('rounding uses half-even and bounded fixed-scale arithmetic',()=>{
  assert.equal(roundEven(5n,2n),2n);assert.equal(roundEven(7n,2n),4n);
  assert.throws(()=>computeDemo('0.0099','standard'));assert.throws(()=>computeDemo('10000.0001','standard'));assert.throws(()=>computeDemo('NaN','standard'));
  const result=computeDemo('10000.0000','standard');assert.equal(result.grossCo2e,'7200.0000');assert.equal(result.netCo2e,'6480.0000');
});
