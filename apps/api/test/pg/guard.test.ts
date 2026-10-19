import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase,testDatabaseUrl} from '../support/pg.js';
import {loadMigrations} from '../../src/kernel/migrate.js';
// `npm run test:pg` is the real-PostgreSQL suite. An unset URL is a failure here, not a silent skip, so CI cannot pass without running the races.
test('TEST_DATABASE_URL is set and the server accepts a throwaway database',async()=>{
  assert.ok(testDatabaseUrl,'TEST_DATABASE_URL is not set. Start the compose database and set it, see README "Integration tests on real PostgreSQL".');
  const t=await createTestDatabase();
  try{
    const version=(await t.db.query('SELECT version() AS v')).rows[0].v as string;
    assert.match(version,/PostgreSQL 1[5-9]/);
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,(await loadMigrations()).length);
  }finally{await t.close();}
});
