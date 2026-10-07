import {neurodeskViteConfig} from '../../scripts/lib/vite-app-config.mjs';
import {readFile} from 'node:fs/promises';
import {isolationFallback} from '../../scripts/lib/isolation-fallback-plugin.mjs';
const syncroPackage=JSON.parse(await readFile(new URL('../../packages/syncro/package.json',import.meta.url),'utf8'));
const appPackage=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
if(syncroPackage.version!==appPackage.version)throw new Error('SYNcro app and package versions must match.');
// MindGrab, Greedy and registration runtime assets are staged into public/ by scripts/copy-runtime-assets.mjs.
function assets(){return {name:'syncro-assets',async generateBundle(){
 for(const name of ['FSL-LICENSE.txt'])this.emitFile({type:'asset',fileName:'data/'+name,source:await readFile(new URL('../../packages/syncro/data/'+name,import.meta.url))});
}};}
export default neurodeskViteConfig({appId:'syncro',plugins:[assets(),isolationFallback()],build:{target:'esnext'},optimizeDeps:{exclude:['onnxruntime-web','@neurodesk/runtime-support/niimath']},server:{host:'127.0.0.1',port:5175},preview:{host:'127.0.0.1',port:5175}});
