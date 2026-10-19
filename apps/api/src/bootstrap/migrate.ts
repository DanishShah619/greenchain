import {connectDatabase} from './database.js';
import {migrate} from '../kernel/migrate.js';
// Applies pending SQL migrations from apps/api/migrations. Safe to run repeatedly and from several hosts at once.
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const database=connectDatabase(process.env.DATABASE_URL);
try {
  const result=await migrate(database.db);
  console.log(`Migrations ${result.applied.length?`applied: ${result.applied.join(', ')}`:'already current'}${result.baselined?' (existing database recorded as baseline 0001)':''}; schema version ${result.current}.`);
} finally {await database.close();}
