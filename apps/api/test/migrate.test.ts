import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {checksum,loadMigrations,migrate,MigrationError} from '../src/kernel/migrate.js';
import {pgliteDatabase} from './support/pglite.js';
function folder(files:Record<string,string>){
  const dir=mkdtempSync(join(tmpdir(),'greenchain-migrations-'));
  for(const [name,sql] of Object.entries(files))writeFileSync(join(dir,name),sql);
  return {url:pathToFileURL(dir+'/'),dir,edit:(name:string,sql:string)=>writeFileSync(join(dir,name),sql),done:()=>rmSync(dir,{recursive:true,force:true})};
}
const rejectsWith=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(error:unknown)=>error instanceof MigrationError&&error.code===code);
test('a fresh database is migrated once and a second run is a no-op',async()=>{
  const {pg,db}=pgliteDatabase();
  try{
    const latest=loadMigrations().map(m=>m.version);
    const first=await migrate(db);
    assert.deepEqual([first.applied,first.baselined,first.current],[latest,false,latest.at(-1)]);
    const recorded=(await db.query('SELECT version,name,checksum,baselined FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(recorded.map(r=>r.version),latest);
    assert.ok(recorded.every(r=>r.baselined===false&&/^[a-f0-9]{64}$/.test(r.checksum)));
    assert.deepEqual((await migrate(db)).applied,[]);
  }finally{await pg.close();}
});
test('an applied migration that was edited afterwards is refused',async()=>{
  const dir=folder({'0001_first.sql':'CREATE TABLE t1(id integer);'}),{pg,db}=pgliteDatabase();
  try{
    await migrate(db,dir.url);
    dir.edit('0001_first.sql','CREATE TABLE t1(id integer, extra text);');
    await rejectsWith(migrate(db,dir.url),'MIGRATION_CHECKSUM_MISMATCH');
  }finally{dir.done();await pg.close();}
});
test('a failing migration leaves nothing behind (all-or-nothing)',async()=>{
  const dir=folder({'0001_ok.sql':'CREATE TABLE kept(id integer);','0002_bad.sql':'CREATE TABLE half(id integer); SELECT * FROM does_not_exist;'}),{pg,db}=pgliteDatabase();
  try{
    await assert.rejects(migrate(db,dir.url));
    const left=(await db.query(`SELECT to_regclass('kept') AS kept,to_regclass('half') AS half,to_regclass('schema_migrations') AS history`)).rows[0];
    assert.deepEqual([left.kept,left.half,left.history],[null,null,null]);
  }finally{dir.done();await pg.close();}
});
test('gaps, duplicates and unexpected file names are refused before anything runs',async()=>{
  const cases:[Record<string,string>,string][]=[
    [{'0001_a.sql':'SELECT 1;','0003_c.sql':'SELECT 1;'},'MIGRATION_GAP'],
    [{'0002_b.sql':'SELECT 1;'},'MIGRATION_GAP'],
    [{'0001_a.sql':'SELECT 1;','0001_b.sql':'SELECT 1;'},'MIGRATION_DUPLICATE'],
    [{'0001_a.sql':'SELECT 1;','notes.sql':'SELECT 1;'},'MIGRATION_BAD_FILENAME']
  ];
  for(const [files,code] of cases){
    const dir=folder(files);
    try{assert.throws(()=>loadMigrations(dir.url),(error:unknown)=>error instanceof MigrationError&&error.code===code);}finally{dir.done();}
  }
});
test('a database that is ahead of the code is refused',async()=>{
  const both=folder({'0001_a.sql':'CREATE TABLE a(id integer);','0002_b.sql':'CREATE TABLE b(id integer);'}),older=folder({'0001_a.sql':'CREATE TABLE a(id integer);'}),{pg,db}=pgliteDatabase();
  try{
    await migrate(db,both.url);
    await rejectsWith(migrate(db,older.url),'MIGRATION_UNKNOWN_APPLIED');
  }finally{both.done();older.done();await pg.close();}
});
test('line endings do not change a migration checksum',()=>{
  assert.equal(checksum('CREATE TABLE a(\r\n  id integer\r\n);\r\n'),checksum('CREATE TABLE a(\n  id integer\n);\n'));
  assert.notEqual(checksum('CREATE TABLE a(id integer);'),checksum('CREATE TABLE a(id bigint);'));
});
test('a half-built legacy database is refused rather than guessed at',async()=>{
  const {pg,db}=pgliteDatabase();
  try{
    await db.query('CREATE TABLE scenarios(id text PRIMARY KEY)');
    await assert.rejects(migrate(db),(error:unknown)=>error instanceof MigrationError&&error.code==='LEGACY_SCHEMA_INCOMPLETE'&&/missing tables/.test(error.message));
  }finally{await pg.close();}
});
test('a database built by the old setup script is baselined and then brought up to date',async()=>{
  const {pg,db}=pgliteDatabase();
  try{
    const all=loadMigrations(),later=all.slice(1).map(m=>m.version);
    // A legacy database: exactly the 0001 objects exist, but no migration history was ever recorded.
    await db.exec!(all[0].sql);
    const result=await migrate(db);
    assert.equal(result.baselined,true);
    // 0001 is recorded, not re-run (re-running would fail on the existing tables); every later migration is applied on top.
    assert.deepEqual(result.applied,later);
    const history=(await db.query('SELECT version,baselined FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(history.map(r=>[r.version,r.baselined]),[[1,true],...later.map(v=>[v,false])]);
  }finally{await pg.close();}
});
