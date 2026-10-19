import pg from 'pg';
import type { Database } from '../kernel/database.js';
export function connectDatabase(url: string, auditKey?:Buffer) {
  const pool = new pg.Pool({connectionString:url,max:10,connectionTimeoutMillis:5000,statement_timeout:10000});
  // An idle client can fail (database restart, network drop); without a listener Node treats the emitted 'error' as fatal and exits.
  // The pool discards the broken client and opens a new one on demand. Log without the error object, which may carry connection details.
  pool.on('error',() => {console.error('Database pool: idle connection error; the pool will reconnect on next use.');});
  const db: Database = {
    auditKey,
    query: async (sql, values) => pool.query(sql,values),
    transaction: async work => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Database = {auditKey,query: async (sql,values) => client.query(sql,values), transaction: () => {throw new Error('Nested transactions are prohibited');}};
        const result = await work(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally {client.release();}
    }
  };
  return {db,close:()=>pool.end()};
}
