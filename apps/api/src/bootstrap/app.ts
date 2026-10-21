import Fastify, {type FastifyServerOptions} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import {createHash, randomBytes} from 'node:crypto';
import type {Database} from '../kernel/database.js';
import {verifyPassword} from '../kernel/password.js';
import {capture,KeyReuse,type Actor,type CaptureInput} from '../modules/capture/application/capture.js';
import {WorkflowError} from '../modules/review/domain/errors.js';
import {registerReviewRoutes} from '../modules/review/http/routes.js';
import {registerDemoCalculationRoutes} from '../modules/mrv/http/routes.js';
import {approvedDemoInputs,requireCase} from '../modules/review/application/workflow.js';
import {candidate,approveCandidate} from '../modules/mrv/application/demo.js';
import {status as calculationReviewStatus} from '../modules/calculation-review/application/demo.js';
import {registerCalculationReviewRoutes} from '../modules/calculation-review/http/routes.js';
import {issue} from '../modules/registry/application/demo.js';
import {registerDemoRegistryRoutes} from '../modules/registry/http/routes.js';
import {registerAuditRoutes} from '../modules/audit/http/routes.js';
import {registerMarketRoutes,WEBHOOK_PATH,type MarketRoutesConfig} from '../modules/market/http/routes.js';
import {DEFAULT_MARKET} from '../modules/market/application/orders.js';
import {DEFAULT_PAYMENTS} from '../modules/market/application/payments.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function buildApp(db: Database, config: {origin:string; secure:boolean; trustProxy?:number; market?:MarketRoutesConfig}) {
  // Without market configuration there is no webhook secret, so the webhook and the simulator are not registered.
  const market:MarketRoutesConfig=config.market??{market:DEFAULT_MARKET,payments:{...DEFAULT_PAYMENTS,secrets:[]},demoMode:false};
  // trustProxy is the number of trusted reverse-proxy hops (unset = none), so request.ip is the real client address and the login limiter is per client, not per proxy.
  // Typed explicitly so TypeScript keeps the plain HTTP/1 server overload of Fastify() when trustProxy is added.
  const options:FastifyServerOptions={bodyLimit:16384,trustProxy:config.trustProxy?(_address:string,hop:number)=>hop<config.trustProxy!:false,logger:{redact:['req.headers.cookie','req.headers.authorization','req.headers.x-csrf-token','req.headers.x-greenchain-signature']},ajv:{customOptions:{removeAdditional:false}}};
  const app = Fastify(options);
  await app.register(cookie);
  await app.register(cors,{origin:config.origin,credentials:true});
  app.setErrorHandler((error,request,reply) => {
    // Framework-level client errors (oversize body, malformed JSON, unsupported media type) carry their own 4xx status.
    const framework = error && typeof error === 'object' && 'statusCode' in error && Number.isInteger((error as {statusCode:unknown}).statusCode) && (error as {statusCode:number}).statusCode >= 400 && (error as {statusCode:number}).statusCode < 500 ? (error as {statusCode:number}).statusCode : undefined;
    const status = error && typeof error === 'object' && 'validation' in error ? 400 : error instanceof WorkflowError ? error.status : error instanceof KeyReuse ? 409 : framework ?? 500;
    if(status>=500) request.log.error({err:error},'Request failed');
    const code = error instanceof WorkflowError ? error.code : error instanceof KeyReuse ? 'KEY_REUSE' : status===400 ? 'INVALID_INPUT' : status===413 ? 'PAYLOAD_TOO_LARGE' : status>=400 && status<500 ? 'REQUEST_REJECTED' : 'INTERNAL_ERROR';
    reply.code(status).send({code,correlationId:request.id,retryable:status>=500});
  });
  app.addHook('onRequest',async (request,reply) => {
    if(request.url.startsWith('/api/v1/')&&!request.url.startsWith('/api/v1/showcase')&&!request.url.startsWith('/api/v1/health'))reply.header('Cache-Control','no-store');
    // The payment provider is a server, not a browser: it sends no Origin and is authenticated by its signature instead.
    const webhook = request.method==='POST' && request.url.split('?')[0]===WEBHOOK_PATH;
    if(!webhook && ['POST','PUT','PATCH','DELETE'].includes(request.method) && request.headers.origin !== config.origin)
      return reply.code(403).send({code:'UNTRUSTED_ORIGIN',retryable:false});
  });
  const session = async (token?: string) => {
    if (!token) return undefined;
    const result = await db.query(`SELECT u.id,u.scenario_id,u.role,u.institution_id,s.csrf FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,[hash(token)]);
    return result.rows[0];
  };
  app.get('/api/v1/health',async (_request,reply) => {
    try {await db.query('SELECT 1'); return {status:'ready',demo:true};}
    catch {return reply.code(503).send({status:'unavailable'});}
  });
  app.post<{Body:{password:string;account?:'presenter'|'buyer'|'verifier'}}>('/api/v1/session', {schema:{body:{type:'object',additionalProperties:false,required:['password'],properties:{password:{type:'string',minLength:1,maxLength:256},account:{enum:['presenter','buyer','verifier']}}}}},async (request,reply) => {
    // Only failed attempts count; a successful login clears the counter, so legitimate users sharing an address are not locked out by their own successes.
    const recent = (await db.query(`SELECT attempts FROM login_attempts WHERE ip=$1 AND window_start>=now()-interval '15 minutes'`,[request.ip])).rows[0];
    if(recent && recent.attempts>=10) return reply.header('Retry-After','900').code(429).send({code:'RATE_LIMITED',retryable:true});
    const user = (await db.query('SELECT * FROM users WHERE id=$1',[request.body.account??'presenter'])).rows[0];
    if(!user || !verifyPassword(request.body.password,user.password_hash)) {
      await db.query(`INSERT INTO login_attempts(ip,attempts,window_start) VALUES ($1,1,now())
        ON CONFLICT(ip) DO UPDATE SET attempts=CASE WHEN login_attempts.window_start<now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,
        window_start=CASE WHEN login_attempts.window_start<now()-interval '15 minutes' THEN now() ELSE login_attempts.window_start END`,[request.ip]);
      return reply.code(401).send({code:'INVALID_CREDENTIALS',retryable:false});
    }
    await db.query('DELETE FROM login_attempts WHERE ip=$1',[request.ip]);
    const token = randomBytes(32).toString('hex'), csrf=randomBytes(24).toString('hex');
    await db.transaction(async tx => {
      if(request.cookies.session) await tx.query('DELETE FROM sessions WHERE token_hash=$1',[hash(request.cookies.session)]);
      await tx.query(`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES ($1,$2,$3,now()+interval '8 hours')`,[hash(token),user.id,csrf]);
    });
    reply.setCookie('session',token,{httpOnly:true,sameSite:'strict',secure:config.secure,path:'/',maxAge:28800});
    return {actorId:user.id,role:user.role,csrf};
  });
  app.get('/api/v1/session',async (request,reply) => {
    const user=await session(request.cookies.session);
    return user ? {actorId:user.id,role:user.role,csrf:user.csrf} : reply.code(401).send({code:'LOGIN_REQUIRED',retryable:false});
  });
  app.delete('/api/v1/session',async (request,reply) => {
    const user=await session(request.cookies.session);
    if(!user) return reply.code(401).send({code:'LOGIN_REQUIRED',retryable:false});
    if(request.headers['x-csrf-token']!==user.csrf) return reply.code(403).send({code:'CSRF_FAILED',retryable:false});
    await db.query('DELETE FROM sessions WHERE token_hash=$1',[hash(request.cookies.session!)]);
    reply.clearCookie('session',{path:'/'}).code(204).send();
  });
  app.get('/api/v1/showcase',async () => ({demo:true,captures:(await db.query(`SELECT farmer_label,village,area_hectares,status FROM captures WHERE scenario_id='showcase' ORDER BY created_at,event_id LIMIT 50`)).rows}));
  app.get('/api/v1/captures',async (request,reply) => {
    const user=await session(request.cookies.session);
    if(!user) return reply.code(401).send({code:'LOGIN_REQUIRED',retryable:false});
    if(user.role!=='agent') return reply.code(403).send({code:'FORBIDDEN',retryable:false});
    return {captures:(await db.query(`SELECT c.event_id,c.farmer_label,c.village,c.area_hectares,c.status,c.onboarding,r.state AS review_state,p.area_hectares AS calculated_area
      FROM captures c LEFT JOIN review_cases r ON r.scenario_id=c.scenario_id AND r.capture_id=c.event_id LEFT JOIN plots p ON p.scenario_id=c.scenario_id AND p.capture_id=c.event_id
      WHERE c.scenario_id=$1 AND c.actor_id=$2 ORDER BY c.created_at DESC,c.event_id LIMIT 50`,[user.scenario_id,user.id])).rows};
  });
  app.post<{Body:CaptureInput}>('/api/v1/captures',{schema:{body:{type:'object',additionalProperties:false,required:['eventId','farmerLabel','village','areaHectares','consent'],properties:{
    eventId:{type:'string',format:'uuid'},farmerLabel:{type:'string',minLength:1,maxLength:80,pattern:'\\S'},village:{type:'string',minLength:1,maxLength:80,pattern:'\\S'},
    areaHectares:{type:'string',pattern:'^(?:0\\.(?:0[1-9]|[1-9][0-9])|[1-9][0-9]{0,3}\\.[0-9]{2})$'},consent:{const:true},
    onboarding:{type:'object',additionalProperties:false,
      required:['version','language','district','plotLabel','landRight','crop','season','consentVersion','purpose'],
      properties:{version:{const:1},language:{enum:['en','hi','bn']},district:{type:'string',minLength:1,maxLength:80,pattern:'\\S'},plotLabel:{type:'string',minLength:1,maxLength:80,pattern:'\\S'},landRight:{enum:['owner','consented_cultivator']},crop:{type:'string',minLength:1,maxLength:80,pattern:'\\S'},season:{enum:['kharif','rabi','zaid','perennial']},consentVersion:{enum:['demo-consent-v1','demo-consent-v2']},purpose:{const:'demo-onboarding'}}}
  }}}},async (request,reply) => {
    const user=await session(request.cookies.session);
    if(!user) return reply.code(401).send({code:'LOGIN_REQUIRED',retryable:false});
    if(user.role!=='agent') return reply.code(403).send({code:'FORBIDDEN',retryable:false});
    if(request.headers['x-csrf-token']!==user.csrf) return reply.code(403).send({code:'CSRF_FAILED',retryable:false});
    const actor:Actor={id:user.id,scenarioId:user.scenario_id,role:user.role,institutionId:user.institution_id};
    const result=await capture(db,actor,request.body);
    return reply.code(result.replayed?200:201).send(result);
  });
  const resolveActor=async(request:import('fastify').FastifyRequest,write=false):Promise<Actor>=>{
    const user=await session(request.cookies.session);
    if(!user)throw new WorkflowError('LOGIN_REQUIRED',401);
    if(write&&request.headers['x-csrf-token']!==user.csrf)throw new WorkflowError('CSRF_FAILED',403);
    return {id:user.id,scenarioId:user.scenario_id,role:user.role,institutionId:user.institution_id};
  };
  await registerReviewRoutes(app,db,resolveActor);
  await registerDemoCalculationRoutes(app,db,resolveActor,approvedDemoInputs,requireCase,calculationReviewStatus);
  await registerCalculationReviewRoutes(app,db,resolveActor,{case:approvedDemoInputs,candidate,approve:approveCandidate,issue});
  await registerDemoRegistryRoutes(app,db,resolveActor,requireCase);
  await registerAuditRoutes(app,db,resolveActor,requireCase);
  await registerMarketRoutes(app,db,resolveActor,market);
  return app;
}
