export interface Database {
  /** Server-only audit signing context; propagated to every transaction. */
  auditKey?: Buffer;
  query<T extends Record<string, any> = Record<string, any>>(sql: string, values?: any[]): Promise<{ rows: T[] }>;
  /** Runs one or more statements without parameters (simple protocol). Needed for migration files; adapters without it cannot migrate. */
  exec?(sql: string): Promise<void>;
  transaction<T>(work: (db: Database) => Promise<T>): Promise<T>;
}
