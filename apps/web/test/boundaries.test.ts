import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// One panel that meets unexpected data must not blank the whole workspace: every independent panel on the page sits inside its
// own error boundary. The web tests have no DOM, so this checks the page source; the fallback itself is checked in a browser.
const page=readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');
const PANELS=['DemoCalculationPanel','EarningsStatement','PresenterMarketPanel','PresenterPayoutPanel','BuyerWorkspace','VerifierWorkspace'];
test('every workspace panel is rendered inside its own PanelBoundary',()=>{
  for(const panel of PANELS){
    const uses=page.match(new RegExp(`<${panel}\\b`,'g'))?.length??0;
    const wrapped=page.match(new RegExp(`<PanelBoundary name="[^"]+"[^>]*><${panel}\\b`,'g'))?.length??0;
    assert.ok(uses>0,`${panel} is rendered on the page`);
    assert.equal(wrapped,uses,`${panel}: ${uses-wrapped} use(s) without a boundary`);
  }
});
test('the fallback shows no error details and logs nothing (an error message can carry data)',()=>{
  const boundary=readFileSync(new URL('../src/PanelBoundary.tsx',import.meta.url),'utf8');
  assert.match(boundary,/catchError/);assert.match(boundary,/role="alert"/);
  assert.doesNotMatch(boundary,/error\.message|console\./);
});
