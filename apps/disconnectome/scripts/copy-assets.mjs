// Stage the MNI152 template SYNcro already ships, so a lesion dropped without an anatomical
// scan still has a brain underneath. public/template is gitignored: one copy in the repo.
import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../../../packages/syncro/data/', import.meta.url);
const target = new URL('../public/template/', import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ['MNI152_T1_1mm_brain.nii.gz', 'FSL-LICENSE.txt']) {
  await cp(new URL(name, source), new URL(name, target));
}
