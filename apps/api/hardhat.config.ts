import {defineConfig} from 'hardhat/config';
export default defineConfig({networks:{local:{type:'edr-simulated',chainId:31337,chainType:'generic'}}});
