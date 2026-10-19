import {connectDatabase} from './database.js';
import {buildApp} from './app.js';
import {config} from './config.js';
import {auditKeyFromEnvironment} from '../kernel/audit-key.js';
const settings=config(),database=connectDatabase(settings.url,auditKeyFromEnvironment());
const app=await buildApp(database.db,settings);
app.addHook('onClose',database.close);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>void app.close());
await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4000)});
