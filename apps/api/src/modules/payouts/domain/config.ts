/**
 * Ledger configuration (docs/23 P4) and synthetic payee tokens (P2). Version 0 is the built-in default: it is never a row,
 * and lots and batches record it like any other version.
 */
export type LedgerConfig={version:number;holdbackDays:number;reserveBps:number;minPayoutPaise:bigint;payoutLimitPaise:bigint;backoffBaseSeconds:number;idempotencyWindowSeconds:number};
export const DEFAULT_LEDGER_CONFIG:LedgerConfig={version:0,holdbackDays:7,reserveBps:2000,minPayoutPaise:10000n,payoutLimitPaise:5000000n,backoffBaseSeconds:5,idempotencyWindowSeconds:86400};
/** The suffix selects the sandbox rail's behaviour (docs/23 P9); 00 settles normally. */
export const SANDBOX_SUFFIXES=['00','02','03','04','05','06','10','11','12'] as const;
export type SandboxSuffix=typeof SANDBOX_SUFFIXES[number];
/** A synthetic token derived from the payee id: no bank data exists anywhere. Migration 0008's backfill builds the same string. */
export function sandboxToken(payeeGroupId:string,suffix:SandboxSuffix='00'):string{
  return `SANDBOX-${payeeGroupId.replace(/-/g,'').slice(0,8).toUpperCase()}-${suffix}`;
}
/** The demo clock runs at most a year ahead and moves at most 30 days per step (docs/23 P7). */
export const CLOCK_MAX_OFFSET_SECONDS=31_536_000,CLOCK_MAX_STEP_SECONDS=30*86_400;
