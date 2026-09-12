import {neurodeskViteConfig} from '../../scripts/lib/vite-app-config.mjs';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {isolationFallback} from '../../scripts/lib/isolation-fallback-plugin.mjs';
const require=createRequire(import.meta.url),mindgrabRoot=dirname(require.resolve('@brainchop/mindgrab/package.json')),mindgrabDist=join(mindgrabRoot,'dist');
const syncroPackage=JSON.parse(await readFile(new URL('../../packages/syncro/package.json',import.meta.url),'utf8'));
const appPackage=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8'));
if(syncroPackage.version!==appPackage.version)throw new Error('SYNcro app and package versions must match.');
function assets(){return {name:'syncro-assets',async generateBundle(){
 for(const name of ['syncro-registration.mjs','syncro-registration.wasm'])this.emitFile({type:'asset',fileName:'registration/'+name,source:await readFile(new URL('../../packages/registration/wasm/'+name,import.meta.url))});
 for(const name of ['brainchop-mindgrab-gpu.js','brainchop-mindgrab-gpu.wasm','brainchop-mindgrab-gl.js','brainchop-mindgrab-gl.wasm','brainchop-mindgrab.js','brainchop-mindgrab.wasm'])this.emitFile({type:'asset',fileName:'mindgrab/'+name,source:await readFile(join(mindgrabDist,name))});
 this.emitFile({type:'asset',fileName:'mindgrab/LICENSE',source:await readFile(join(mindgrabRoot,'LICENSE'))});
 for(const name of ['FSL-LICENSE.txt'])this.emitFile({type:'asset',fileName:'data/'+name,source:await readFile(new URL('../../packages/syncro/data/'+name,import.meta.url))});
 execFileSync('node',['scripts/build.mjs'],{cwd:new URL('../../packages/syncro/',import.meta.url),stdio:'inherit'});
 const temporary=await mkdtemp(join(tmpdir(),'syncro-pack-'));
 try {const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',temporary],{cwd:new URL('../../packages/syncro/',import.meta.url),encoding:'utf8'}));
 this.emitFile({type:'asset',fileName:'downloads/'+packed[0].filename,source:await readFile(join(temporary,packed[0].filename))});}finally{await rm(temporary,{recursive:true,force:true});}
}};}
export default neurodeskViteConfig({appId:'syncro',plugins:[assets(),isolationFallback()],define:{__SYNCRO_PACKAGE_VERSION__:JSON.stringify(syncroPackage.version)},build:{target:'esnext'},optimizeDeps:{exclude:['onnxruntime-web']},server:{host:'127.0.0.1',port:5175},preview:{host:'127.0.0.1',port:5175}});
