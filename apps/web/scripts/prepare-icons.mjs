import sharp from 'sharp';
import {mkdir} from 'node:fs/promises';
await mkdir('public/icons',{recursive:true});
const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#153e30"/><path d="M256 124 388 256 256 388 124 256Z" fill="none" stroke="#e6ebd5" stroke-width="26"/><path d="M196 278c0-77 54-108 116-103 5 66-28 118-90 117l57-71" fill="#9eb77d"/><path d="m212 300 66-80" fill="none" stroke="#153e30" stroke-width="12" stroke-linecap="round"/></svg>`);
for(const size of [192,512])await sharp(svg).resize(size,size).png().toFile(`public/icons/icon-${size}.png`);
await sharp(svg).png().toFile('public/icons/maskable-512.png');
