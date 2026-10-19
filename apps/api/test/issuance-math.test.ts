import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitIssuance} from '../src/modules/registry/domain/quantities.js';
test('whole credits, fractional carry and buffer reconcile exactly',()=>{
  assert.deepEqual(splitIssuance({grossCo2e:'2.5000',bufferCo2e:'0.2500',netCo2e:'2.2500'}),{gross:'2.5000',buffer:'0.2500',net:'2.2500',credits:2,carry:'0.2500'});
  assert.equal(splitIssuance({grossCo2e:'0.9000',bufferCo2e:'0.0900',netCo2e:'0.8100'}).credits,0);
  assert.equal(splitIssuance({grossCo2e:'0.0000',bufferCo2e:'0.0000',netCo2e:'0.0000'}).carry,'0.0000');
  assert.throws(()=>splitIssuance({grossCo2e:'2.5000',bufferCo2e:'0.2000',netCo2e:'2.2500'}));
  assert.throws(()=>splitIssuance({grossCo2e:null,bufferCo2e:null,netCo2e:null}));
});
