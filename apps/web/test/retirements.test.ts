import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isCertificateNumber,verifyQuery} from '../src/certificates';
import {defaultReportingPeriod,heldCount,RETIRE_MESSAGES,retiredLine,validPurpose,validReportingPeriod} from '../src/retirements';
// Retirement helpers for the buyer workspace and the public verify page (docs/25 T8).
test('reporting periods: an Indian financial year of consecutive years, or a calendar year, defaulting to the current FY',()=>{
  for(const ok of ['FY2026-27','FY2029-30','FY2099-00','2026'])assert.ok(validReportingPeriod(ok),ok);
  for(const no of ['FY2026-28','2026-27','FY26-27','1999','fy2026-27','FY2026-27 ','',' 2026'])assert.ok(!validReportingPeriod(no),no);
  assert.equal(defaultReportingPeriod(new Date('2026-10-29T12:00:00+05:30')),'FY2026-27');
  assert.equal(defaultReportingPeriod(new Date('2027-03-31T23:30:00+05:30')),'FY2026-27','31 March is still the previous FY in India');
  assert.equal(defaultReportingPeriod(new Date('2027-04-01T00:30:00+05:30')),'FY2027-28','1 April IST starts the next FY, even while it is 31 March in UTC');
});
test('the public purpose is optional, short and plain text',()=>{
  assert.ok(validPurpose(''));assert.ok(validPurpose('Scope 3 offset, FY2026-27 report'));assert.ok(validPurpose("Company's annual report (draft) & notes: 2026/27"));
  for(const no of ['<script>x</script>','x'.repeat(121),'emoji 🌱','line\nbreak','a"quote'])assert.ok(!validPurpose(no),no);
});
test('retirement numbers verify like purchase numbers; counts and errors read plainly',()=>{
  assert.ok(isCertificateNumber('GC-RETIRE-0123-ABCD'));assert.ok(!isCertificateNumber('GC-RETIRED-0123-ABCD'));
  assert.deepEqual(verifyQuery('?n=GC-RETIRE-7K4Q-9XW2'),{number:'GC-RETIRE-7K4Q-9XW2',hash:null});
  assert.equal(heldCount([{retired:true},{retired:false},{retired:false}]),2);
  assert.equal(retiredLine({credits:0,of:3}),null,'nothing to say until something is retired');
  assert.equal(retiredLine({credits:2,of:3}),'2 of these 3 credits have since been retired.');
  assert.equal(retiredLine({credits:1,of:1}),'This credit has since been retired.');
  for(const code of ['NOT_ENOUGH_CREDITS','CREDIT_NOT_RETIRABLE','ORDER_NOT_FULFILLED','SCENARIO_RETIRED','KEY_REUSE'])assert.ok(RETIRE_MESSAGES[code],code);
});
// The web tests have no DOM, so the wiring is checked in the source; the screens themselves are checked in a browser.
const source=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
test('a paid order offers retirement, marks retired credits, and the summary shows purchased, retired and held',()=>{
  const workspace=source('../src/BuyerWorkspace.tsx'),panel=source('../src/RetirePanel.tsx');
  assert.match(workspace,/o\.state==='FULFILLED'&&<RetirePanel\b/);assert.match(workspace,/<RetirementSummary\b/);
  assert.match(workspace,/c\.retired\?/,'each purchased credit shows whether it is retired');
  assert.match(panel,/shown publicly/i,'the buyer is told the purpose is public');
  assert.match(panel,/validReportingPeriod\(/);assert.match(panel,/validPurpose\(/);
  assert.doesNotMatch(panel,/dangerouslySetInnerHTML/);
});
test('the certificate view and the verify page understand retirement certificates',()=>{
  const view=source('../src/CertificateView.tsx'),verify=source('../app/verify/page.tsx');
  assert.match(view,/kind==='RETIREMENT'/);assert.match(view,/Certificate of retirement/);
  assert.match(verify,/kind==='RETIREMENT'/);assert.match(verify,/retiredLine\(/);assert.match(verify,/GC-RETIRE-XXXX-XXXX/);
});
