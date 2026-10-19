import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateBoundary} from './index.mjs';
const polygon=ring=>({type:'Polygon',coordinates:[ring]});
test('square has independently bounded area and orientation does not change it',()=>{
  const ring=[[88,23],[88.001,23],[88.001,23.001],[88,23.001],[88,23]];
  // ~111.2 m north/south by ~102.4 m east/west at 23 degrees latitude.
  const result=validateBoundary(polygon(ring));
  assert.ok(Number(result.areaHectares)>1.13&&Number(result.areaHectares)<1.15);
  assert.equal(validateBoundary(polygon([...ring].reverse())).areaHectares,result.areaHectares);
});
test('crossed, open, degenerate, out-of-region and oversized boundaries fail',()=>{
  for(const ring of [
    [[88,23],[88.001,23.001],[88.001,23],[88,23.001],[88,23]],
    [[88,23],[88.001,23],[88.001,23.001],[88,23.001]],
    [[88,23],[88.001,23],[88.002,23],[88,23]],
    [[0,0],[1,0],[1,1],[0,0]],
    [[88,23],[89,23],[89,24],[88,24],[88,23]],
  ])assert.throws(()=>validateBoundary(polygon(ring)));
});
