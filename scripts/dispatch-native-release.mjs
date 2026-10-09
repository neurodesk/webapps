// Start the native builds for an app release: one per release source that follows the app's version.
// Usage: node scripts/dispatch-native-release.mjs APP TAG
import { execFileSync } from 'node:child_process';
import { nativeReleases, portableSpecs } from './lib/native-releases.mjs';

const [app, tag] = process.argv.slice(2);
if (!app || !tag) throw new Error('Usage: dispatch-native-release.mjs APP TAG');
const sources = nativeReleases(await portableSpecs()).get(app) ?? [];
if (!sources.length) console.log(`${app}: no native command line`);
for (const source of sources) {
  if (!source.startsWithAppRelease) {
    console.log(`${app}: dispatch ${source.workflow} by hand once its draft or prerelease exists`);
    continue;
  }
  execFileSync('gh', ['workflow', 'run', source.workflow, '--ref', tag, '-f', `${source.publishInput}=true`], { stdio: 'inherit' });
  console.log(`${app}: started ${source.workflow} at ${tag}`);
}
