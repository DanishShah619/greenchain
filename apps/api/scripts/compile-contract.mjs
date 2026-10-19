import solc from 'solc';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function compileContract(){
  const content=await readFile(resolve(root,'contracts/DemoProofRegistry.sol'),'utf8');
  const result=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'DemoProofRegistry.sol':{content}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}})));
  const errors=(result.errors??[]).filter(e=>e.severity==='error');if(errors.length)throw new Error(errors.map(e=>e.formattedMessage).join('\n'));
  const contract=result.contracts['DemoProofRegistry.sol'].DemoProofRegistry;
  return {compiler:solc.version(),abi:contract.abi,bytecode:'0x'+contract.evm.bytecode.object};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const artifact=await compileContract(),folder=resolve(root,'../../.local/contracts');await mkdir(folder,{recursive:true});
  await writeFile(resolve(folder,'DemoProofRegistry.json'),JSON.stringify(artifact,null,2));
  console.log('DemoProofRegistry compiled locally. Artifact: .local/contracts/DemoProofRegistry.json');
}
