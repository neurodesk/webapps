import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const executableIndex=process.argv.indexOf('--executable');
const executable=executableIndex>=0?resolve(process.argv[executableIndex+1]):process.execPath;
const prefix=executableIndex>=0?[]:[resolve(process.argv[2]||'packages/syncro/bin/syncro.js')];
const work=await mkdtemp(join(tmpdir(),'syncro-package-check-'));
function run(args){const r=spawnSync(executable,[...prefix,...args],{encoding:'utf8',timeout:30000});if(r.error)throw r.error;return r;}
try {
 assert.equal(run(['--help']).status,0);
 const selfCheck=run(['self-check']);assert.equal(selfCheck.status,0,selfCheck.stderr);assert.equal(JSON.parse(selfCheck.stdout).executable.length>0,true);
 const input=join(work,'input.nii'),output=join(work,'existing');
 await writeFile(input,Buffer.from('Validation is rejected before inference.'));
 await mkdir(output);await writeFile(join(output,'keep.txt'),'preserve');
 let r=run([input,output,'--offline']);assert.notEqual(r.status,0);assert.match(r.stderr,/already exists/);
 assert.equal(await readFile(join(output,'keep.txt'),'utf8'),'preserve');
 r=run([input,join(work,'new'),'--threads','0']);assert.notEqual(r.status,0);assert.match(r.stderr,/positive integer/);
 r=run(['download-models','--offline','--cache-dir',join(work,'empty-cache')]);assert.notEqual(r.status,0);assert.match(r.stderr,/missing from the offline installation/);
 r=run([input,output,'--resume','--offline']);assert.notEqual(r.status,0);
 assert.equal(await readFile(join(output,'keep.txt'),'utf8'),'preserve');
 console.log('PASS installed package: self-check, help, output preservation, thread validation, offline cache failure, invalid resume');
}finally{await rm(work,{recursive:true,force:true});}
