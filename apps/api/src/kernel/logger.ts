import pino from 'pino';
/** The slice of a structured logger the application depends on; pino satisfies it, and tests can pass a stub. */
export interface Logger {
  debug(fields:Record<string,unknown>,message:string):void;
  info(fields:Record<string,unknown>,message:string):void;
  warn(fields:Record<string,unknown>,message:string):void;
  error(fields:Record<string,unknown>,message:string):void;
}
/** Field names that must never reach a log line, at any depth we log. Belt and braces: callers also avoid passing them. */
const REDACT=['privateKey','password','secret','signature','token','*.signature','authorization','cookie','rawTransaction','signerKeyFile','rpcUrl','databaseUrl','*.privateKey','*.password','*.secret','*.token','*.rawTransaction','*.rpcUrl'];
/** One JSON object per line on stdout (or the given stream), ISO timestamps, secrets censored. */
export function createLogger(name:string,destination?:NodeJS.WritableStream,level=process.env.LOG_LEVEL??'info'):Logger{
  const instance=pino({name,level,redact:{paths:REDACT,censor:'[redacted]'},timestamp:pino.stdTimeFunctions.isoTime},destination as pino.DestinationStream|undefined);
  return {
    debug:(fields,message)=>instance.debug(fields,message),
    info:(fields,message)=>instance.info(fields,message),
    warn:(fields,message)=>instance.warn(fields,message),
    error:(fields,message)=>instance.error(fields,message)
  };
}
export const silentLogger:Logger={debug(){},info(){},warn(){},error(){}};
