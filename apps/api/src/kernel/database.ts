export interface Database {
  /** Server-only audit signing context; propagated to every transaction. */
  auditKey?: Buffer;
  query<T extends Record<string, any> = Record<string, any>>(sql: string, values?: any[]): Promise<{ rows: T[] }>;
  transaction<T>(work: (db: Database) => Promise<T>): Promise<T>;
}
