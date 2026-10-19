import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../../../kernel/database.js';
import {appendAudit} from '../../audit/application/audit.js';
export type Onboarding = {
  version: 1; language: 'en'|'hi'|'bn'; district: string; plotLabel: string;
  landRight: 'owner'|'consented_cultivator'; crop: string; season: 'kharif'|'rabi'|'zaid'|'perennial';
  consentVersion: 'demo-consent-v1'|'demo-consent-v2'; purpose: 'demo-onboarding';
};
export type CaptureInput = {eventId: string; farmerLabel: string; village: string; areaHectares: string; consent: true; onboarding?:Onboarding};
export type Actor = {id: string; scenarioId: string; role: string; institutionId?:string};
export class KeyReuse extends Error {}
export async function capture(db: Database, actor: Actor, input: CaptureInput) {
  // Preserve legacy fingerprints so already queued captures can still replay.
  const facts:unknown[]=[input.farmerLabel,input.village,input.areaHectares,input.consent];
  if(input.onboarding){const o=input.onboarding;facts.push([o.version,o.language,o.district,o.plotLabel,o.landRight,o.crop,o.season,o.consentVersion,o.purpose]);}
  const fingerprint = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return db.transaction(async tx => {
    const inserted = await tx.query(`INSERT INTO captures
      (scenario_id,event_id,actor_id,fingerprint,farmer_label,village,area_hectares,onboarding,institution_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING event_id`,
      [actor.scenarioId,input.eventId,actor.id,fingerprint,input.farmerLabel,input.village,input.areaHectares,input.onboarding?JSON.stringify(input.onboarding):null,actor.institutionId??'demo-institution']);
    if (!inserted.rows.length) {
      const previous = await tx.query('SELECT fingerprint,actor_id FROM captures WHERE scenario_id=$1 AND event_id=$2', [actor.scenarioId,input.eventId]);
      if (previous.rows[0]?.fingerprint !== fingerprint || previous.rows[0]?.actor_id !== actor.id) throw new KeyReuse();
      return {eventId:input.eventId,status:'CAPTURED',replayed:true};
    }
    await appendAudit(tx,actor,input.eventId,'capture.received');
    await tx.query('INSERT INTO review_cases(scenario_id,capture_id) VALUES ($1,$2)',[actor.scenarioId,input.eventId]);
    await tx.query('INSERT INTO jobs(id,scenario_id,capture_id,type) VALUES ($1,$2,$3,$4)',
      [randomUUID(),actor.scenarioId,input.eventId,'capture.received']);
    return {eventId:input.eventId,status:'CAPTURED',replayed:false};
  });
}
