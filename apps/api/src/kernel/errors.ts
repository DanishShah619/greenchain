export class WorkflowError extends Error{
  constructor(public code:string,public status=409){super(code);}
}
/**
 * The only error details that may be logged or stored: the error's class name and a short machine code.
 * Never the message, stack or cause, which can carry connection strings, RPC URLs with API keys, SQL or user data.
 */
export function safeErrorFields(error:unknown):{errorName:string;errorCode?:string}{
  if(!(error instanceof Error))return {errorName:typeof error};
  const code=(error as {code?:unknown}).code;
  return {errorName:error.name.slice(0,60),...(typeof code==='string'&&/^[A-Za-z0-9_.:-]{1,40}$/.test(code)?{errorCode:code}:{})};
}
