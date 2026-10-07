// Start the signed native build for an app release, when the app ships one that follows its version.
// Usage: node scripts/dispatch-native-release.mjs APP TAG
import { execFileSync } from 'node:child_process';
import { nativeReleases, portableSpecs } from './lib/native-releases.mjs';

const [app, tag] = process.argv.slice(2);
if (!app || !tag) throw new Error('Usage: dispatch-native-release.mjs APP TAG');
const release = nativeReleases(await portableSpecs()).get(app);
if (!release) {
  console.log(`${app}: no native command line`);
} else if (!release.startsWithAppRelease) {
  console.log(`${app}: dispatch ${release.workflow} by hand once its draft or prerelease exists`);
} else {
  execFileSync('gh', ['workflow', 'run', release.workflow, '--ref', tag, '-f', 'sign_release=true'], { stdio: 'inherit' });
  console.log(`${app}: started ${release.workflow} at ${tag}`);
}
