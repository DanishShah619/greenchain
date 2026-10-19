import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {connectDatabase} from '../../src/bootstrap/database.js';
import {migrate} from '../../src/kernel/migrate.js';
import type {Database} from '../../src/kernel/database.js';
/**
 * Real PostgreSQL for the tests that need several connections at once (races, locks, leases).
 * TEST_DATABASE_URL must point at an admin-capable database on a server you do not mind creating throwaway
 * databases on, for example the compose service: postgres://greenchain:local-demo-only@127.0.0.1:5432/postgres
 * Each call creates its own database and drops it on close, so test files cannot interfere with each other.
 */
export const testDatabaseUrl=process.env.TEST_DATABASE_URL;
export async function createTestDatabase(options:{migrate?:boolean;auditKey?:Buffer}={}){
  if(!testDatabaseUrl)throw new Error('TEST_DATABASE_URL is not set');
  const name=`gc_test_${randomUUID().replace(/-/g,'')}`;
  const admin=new pg.Client({connectionString:testDatabaseUrl});await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url=new URL(testDatabaseUrl);url.pathname=`/${name}`;
  const handles:Array<{close():Promise<void>}>=[];
  const connect=():Database=>{const handle=connectDatabase(url.toString(),options.auditKey??Buffer.alloc(32,7));handles.push(handle);return handle.db;};
  const db:Database=connect();
  if(options.migrate!==false)await migrate(db);
  return {name,url:url.toString(),db,
    /** An extra, independent pool: a separate "process" talking to the same database. */
    connect,
    async close(){for(const h of handles)await h.close().catch(()=>{});await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();}};
}
/** Runs the same async function n times concurrently and returns every outcome, fulfilled or rejected. */
export async function race<T>(count:number,work:(index:number)=>Promise<T>){
  return Promise.allSettled(Array.from({length:count},(_,i)=>work(i)));
}
