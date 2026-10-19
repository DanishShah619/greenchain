import {PGlite} from '@electric-sql/pglite';
import type {Database} from '../../src/kernel/database.js';
import {migrate} from '../../src/kernel/migrate.js';
/**
 * In-process PostgreSQL (single connection). Fast and dependency-free, so it suits logic and constraint tests,
 * but it cannot prove lock ordering or races between connections: use test/pg for those.
 */
export function pgliteDatabase(auditKey:Buffer=Buffer.alloc(32,7)):{pg:PGlite;db:Database}{
  const pg=new PGlite();
  const wrap=(client:{query:Function;exec:Function}):Database=>({
    auditKey,
    query:async(sql,values)=>(await client.query(sql,values)) as any,
    exec:async sql=>{await client.exec(sql);},
    transaction:async work=>pg.transaction(async tx=>work(wrap(tx)))
  });
  return {pg,db:wrap(pg)};
}
/** A PGlite database brought to the latest schema by the real migration runner. */
export async function migratedPglite(auditKey?:Buffer){
  const created=pgliteDatabase(auditKey);
  await migrate(created.db);
  return created;
}
