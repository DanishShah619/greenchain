import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import type {Database} from './database.js';

/** A versioned, forward-only schema change loaded from apps/api/migrations/NNNN_name.sql. */
export type Migration={version:number;name:string;sql:string;checksum:string};
export type MigrationResult={applied:number[];baselined:boolean;current:number};

/** Stable machine-readable code first; detail carries names/versions only, never SQL or data. */
export class MigrationError extends Error{
  constructor(public code:string,detail?:string){super(detail?`${code}: ${detail}`:code);}
}

const FILE=/^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
// Resolves to apps/api/migrations from both src/kernel (tsx) and dist/kernel (compiled).
export const defaultMigrationsDir=new URL('../../migrations/',import.meta.url);
// Serialises concurrent runners (two API/worker instances starting together). Transaction-scoped, so it is released on commit or rollback.
const MIGRATION_LOCK=4746017;

/** Tables the pre-migration setup script created; used to recognise (and refuse half-built) legacy databases. */
const LEGACY_TABLES=['scenarios','users','sessions','login_attempts','captures','audit_events','jobs','review_mandates','review_cases','plots','boundary_receipts','evidence_uploads','evidence_chunks','review_decisions','demo_namespaces','demo_calculation_runs','demo_calculation_receipts','demo_calculation_state','demo_calculation_reviews','demo_issuance_batches','demo_credits','demo_registry_events','demo_candidate_receipts','audit_chain_state','audit_chain_links','chain_worker_lease','demo_chain_proofs'];
const LEGACY_COLUMNS:[string,string][]=[['captures','onboarding'],['captures','institution_id'],['users','institution_id'],['audit_events','signed_record'],['audit_events','row_mac']];

/** Line endings are normalised so a Windows (CRLF) checkout and a Linux (LF) checkout hash identically. */
export function checksum(sql:string):string{
  return createHash('sha256').update(sql.replace(/^﻿/,'').replace(/\r\n/g,'\n')).digest('hex');
}

/** Reads and validates the migration directory: strict NNNN_name.sql names, contiguous from 0001, no duplicates. */
export function loadMigrations(dir:URL=defaultMigrationsDir):Migration[]{
  const names=readdirSync(dir).filter(name=>name.endsWith('.sql')).sort();
  const migrations:Migration[]=[];
  for(const file of names){
    const match=FILE.exec(file);
    if(!match)throw new MigrationError('MIGRATION_BAD_FILENAME',file);
    const sql=readFileSync(new URL(file,dir),'utf8');
    migrations.push({version:Number(match[1]),name:match[2],sql,checksum:checksum(sql)});
  }
  migrations.forEach((migration,index)=>{
    if(index>0&&migration.version===migrations[index-1].version)throw new MigrationError('MIGRATION_DUPLICATE',String(migration.version));
    if(migration.version!==index+1)throw new MigrationError('MIGRATION_GAP',`expected ${index+1} found ${migration.version}`);
  });
  return migrations;
}

async function exec(db:Database,sql:string){
  if(!db.exec)throw new MigrationError('MIGRATION_EXEC_UNSUPPORTED','Database adapter has no exec()');
  await db.exec(sql);
}

/** True when the database was built by the old setup script: every expected table and column exists. Half-built is refused. */
async function legacyState(db:Database):Promise<'fresh'|'complete'>{
  const tables=new Set((await db.query<{table_name:string}>(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'`)).rows.map(row=>row.table_name));
  const present=LEGACY_TABLES.filter(table=>tables.has(table));
  if(present.length===0)return 'fresh';
  const missing=LEGACY_TABLES.filter(table=>!tables.has(table));
  if(missing.length)throw new MigrationError('LEGACY_SCHEMA_INCOMPLETE',`missing tables: ${missing.join(', ')}`);
  const columns=(await db.query<{table_name:string;column_name:string}>(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema()`)).rows;
  const absent=LEGACY_COLUMNS.filter(([table,column])=>!columns.some(row=>row.table_name===table&&row.column_name===column));
  if(absent.length)throw new MigrationError('LEGACY_SCHEMA_INCOMPLETE',`missing columns: ${absent.map(([t,c])=>`${t}.${c}`).join(', ')}`);
  return 'complete';
}

/**
 * Brings the database to the latest migration, all-or-nothing in one transaction.
 *  - concurrent runners wait on an advisory lock, then find nothing left to do;
 *  - an applied migration whose file changed, or a database ahead of the code, is refused (fail closed);
 *  - a database made by the old setup script is recorded as already at 0001 instead of re-running it.
 * Migrations needing CREATE INDEX CONCURRENTLY or other non-transactional DDL are not supported here.
 */
export async function migrate(db:Database,dir:URL=defaultMigrationsDir):Promise<MigrationResult>{
  const migrations=loadMigrations(dir);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock($1)',[MIGRATION_LOCK]);
    await tx.query(`SET LOCAL lock_timeout='30s'`);
    await tx.query(`SET LOCAL statement_timeout='300s'`);
    await exec(tx,`CREATE TABLE IF NOT EXISTS schema_migrations(
      version integer PRIMARY KEY CHECK(version>0), name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), baselined boolean NOT NULL DEFAULT false)`);
    let recorded=(await tx.query<{version:number;checksum:string}>('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
    let baselined=false;
    if(recorded.length===0&&await legacyState(tx)==='complete'){
      const first=migrations[0];
      await tx.query('INSERT INTO schema_migrations(version,name,checksum,baselined) VALUES ($1,$2,$3,true)',[first.version,first.name,first.checksum]);
      recorded=[{version:first.version,checksum:first.checksum}];baselined=true;
    }
    for(const row of recorded){
      const file=migrations.find(migration=>migration.version===row.version);
      if(!file)throw new MigrationError('MIGRATION_UNKNOWN_APPLIED',`version ${row.version} is applied but has no file (database is ahead of this code)`);
      if(file.checksum!==row.checksum)throw new MigrationError('MIGRATION_CHECKSUM_MISMATCH',`version ${row.version} (${file.name}) changed after it was applied; add a new migration instead`);
    }
    const current=recorded.length?recorded[recorded.length-1].version:0;
    const applied:number[]=[];
    for(const migration of migrations.filter(item=>item.version>current)){
      await exec(tx,migration.sql);
      await tx.query('INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,$2,$3)',[migration.version,migration.name,migration.checksum]);
      applied.push(migration.version);
    }
    return {applied,baselined,current:migrations[migrations.length-1].version};
  });
}
