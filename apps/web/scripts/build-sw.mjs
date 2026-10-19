import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
async function walk(dir){const files=[];for(const item of await readdir(dir,{withFileTypes:true})){const path=`${dir}/${item.name}`;if(item.isDirectory())files.push(...await walk(path));else files.push(path);}return files;}
const assets=['/','/manifest.webmanifest',...(await walk('out/icons')).map(path=>path.slice(3)),...(await walk('out/_next/static')).map(path=>path.slice(3))];
const hash=createHash('sha256');
for(const url of assets)hash.update(await readFile(url==='/'?'out/index.html':`out${url}`));
const version=hash.digest('hex').slice(0,16);
const worker=await readFile('src/service-worker.js','utf8');
await writeFile('out/sw.js',`const CACHE_NAME='greenchain-shell-${version}';\nconst ASSETS=${JSON.stringify(assets)};\n${worker}`);
console.log(`PWA shell ${version}: ${assets.length} precached assets.`);
