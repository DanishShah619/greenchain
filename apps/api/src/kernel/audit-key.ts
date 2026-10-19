export function auditKeyFromEnvironment(env:NodeJS.ProcessEnv=process.env):Buffer {
  const value=env.AUDIT_HMAC_KEY;
  if(!value||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('AUDIT_HMAC_KEY must be a 32-byte base64url secret');
  const key=Buffer.from(value,'base64url');
  if(key.length!==32||key.toString('base64url')!==value)throw new Error('Invalid AUDIT_HMAC_KEY');
  return key;
}
