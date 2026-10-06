import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { nativeReleases, portableSpecs } from '../scripts/lib/native-releases.mjs';
import { catalogReleases, importReleases, parseReleases } from '../scripts/lib/standalone-import.mjs';

const CATALOG_DISPATCH = 'gh api "repos/$GITHUB_REPOSITORY/dispatches" -f event_type=standalone-catalog -f "client_payload[releases]=$RELEASE"';

async function workflow(name) {
  return YAML.parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
}

function asset(name, digit = 'a') {
  return { name, digest: `sha256:${digit.repeat(64)}`, size: 10, browser_download_url: `https://github.com/neurodesk/webapps/releases/download/x/${name}` };
}

const spec = {
  app: 'tool',
  run: 'input.nii.gz results',
  targets: {
    'linux-x64': { archive: 'tar.gz', executable: 'tool' },
    'windows-x64': { archive: 'zip', executable: 'tool.exe' },
    'macos-arm64': { archive: 'pkg', executable: 'tool' },
  },
};

function verifiedRelease(names) {
  return { tag_name: 'tool-v0.2.20261006', draft: false, assets: names.flatMap((name) => [asset(name), asset(`${name}.validation.txt`, 'b')]) };
}

const archives = ['tool-0.2.20261006-linux-x64.tar.gz', 'tool-0.2.20261006-windows-x64.zip', 'tool-0.2.20261006-macos-arm64.pkg'];

test('a verified portable release becomes one download per target with its install commands', async () => {
  const catalog = { apps: { tool: { downloads: [] } } };
  const release = verifiedRelease(archives);
  release.assets.push(asset('tool-0.2.20261006-macos-arm64-adhoc.pkg'));
  await importReleases(catalog, parseReleases(['tool@0.2.20261006']), {
    fetchRelease: async (tag) => (tag === 'tool-v0.2.20261006' ? release : assert.fail(tag)),
    specs: new Map([['tool', { packageDir: 'packages/elsewhere', spec }]]),
  });
  const downloads = catalog.apps.tool.downloads;
  assert.deepEqual(downloads.map((download) => download.platform), ['linux-x64', 'windows-x64', 'macos-arm64']);
  assert.ok(downloads.every((download) => download.modelsIncluded && download.validationUrl.endsWith('.validation.txt')));
  assert.match(downloads[2].command, /^sudo installer -pkg tool-0\.2\.20261006-macos-arm64\.pkg -target \//);
});

test('an incomplete, unverified or draft release never reaches the catalog', async () => {
  const specs = new Map([['tool', { packageDir: 'packages/tool', spec }]]);
  const run = (release) => importReleases({ apps: { tool: { downloads: [] } } }, parseReleases(['tool@0.2.20261006']), { fetchRelease: async () => release, specs });
  await assert.rejects(run(verifiedRelease(archives.slice(0, 2))), /lacks macos-arm64/);
  const unverified = verifiedRelease(archives);
  unverified.assets = unverified.assets.filter((item) => !item.name.endsWith('.zip.validation.txt'));
  await assert.rejects(run(unverified), /no validation receipt/);
  await assert.rejects(run({ ...verifiedRelease(archives), draft: true }), /still a draft/);
  assert.throws(() => parseReleases(['tool@latest']), /app@MAJOR\.MINOR\.YYYYMMDD/);
});

test('a refresh re-imports what the catalog already lists and keeps embedded-model notes for Rust tools', async () => {
  const catalog = { apps: { synthsr: { downloads: [{ kind: 'cli', platform: 'linux-x64', version: '0.3.20260910', modelsIncluded: true }] }, other: { downloads: [] } } };
  assert.deepEqual(catalogReleases(catalog), [{ id: 'synthsr', version: '0.3.20260910' }]);
  const release = { tag_name: 'synthsr-v0.3.20260910', draft: false, assets: [asset('synthsr-0.3.20260910-linux-x64.tar.gz')] };
  await importReleases(catalog, catalogReleases(catalog), { fetchRelease: async () => release, specs: new Map() });
  assert.equal(catalog.apps.synthsr.downloads[0].modelsIncluded, true);
  assert.equal(catalog.apps.synthsr.downloads[0].command, undefined);
});

test('release specs are found by app, wherever their package lives', async () => {
  const specs = await portableSpecs();
  for (const [app, { packageDir, spec: found }] of specs) {
    assert.equal(found.app, app);
    assert.match(packageDir, /^packages\//);
  }
  assert.equal(specs.get('topofit').packageDir, 'packages/topofit');
});

test('an app release starts every portable command line build, which then publishes to the catalog', async () => {
  const release = await workflow('release.yml');
  assert.equal(release.permissions.actions, 'write');
  const start = release.jobs.release.steps.find((step) => step.name === 'Start the signed native build');
  assert.match(start.run, /node scripts\/dispatch-native-release\.mjs "\$APP" "\$\{APP\}-v\$\{VERSION\}"/);
  for (const [app, native] of await nativeReleases()) {
    const flow = await workflow(native.workflow);
    assert.equal(native.startsWithAppRelease, Boolean(native.spec), `${app}: only portable builds start from the app release`);
    assert.equal(flow.on.workflow_dispatch.inputs.sign_release.type, 'boolean', `${app}: dispatched with sign_release`);
    if (native.spec) {
      const job = flow.jobs.portable;
      assert.equal(job.uses, './.github/workflows/node-cli-portable.yml', `${app}: uses the shared packager`);
      assert.equal(job.with.package, native.packageDir);
      assert.equal(job.with.sign_release, "${{ github.event_name == 'workflow_dispatch' && inputs.sign_release }}");
      assert.equal(job.permissions.contents, 'write');
    } else {
      const publish = flow.jobs.release.steps.at(-1);
      assert.equal(publish.run, CATALOG_DISPATCH, `${app}: its release job announces the archives`);
      assert.equal(publish.env.RELEASE, '${{ steps.target.outputs.release }}');
    }
  }
  const shared = await workflow('node-cli-portable.yml');
  const publish = shared.jobs.release.steps.at(-1);
  assert.equal(publish.run, CATALOG_DISPATCH);
  assert.ok(shared.jobs.release.steps.find((step) => step.id === 'target').run.includes('echo "release='));
});

test('the catalog workflow imports, commits to main and redeploys the site', async () => {
  const flow = await workflow('standalone-catalog.yml');
  assert.deepEqual(flow.on.repository_dispatch, { types: ['standalone-catalog'] });
  assert.equal(flow.concurrency['cancel-in-progress'], false);
  const steps = flow.jobs.publish.steps;
  assert.equal(steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref, 'main');
  assert.ok(steps.some((step) => step.run?.includes('node scripts/desktop/import-native-releases.mjs')));
  assert.ok(steps.some((step) => step.run?.includes('git push origin HEAD:main')));
  assert.equal(steps.at(-1).run, 'gh workflow run deploy-pages.yml --ref main');
  assert.deepEqual(flow.jobs.publish.permissions, { contents: 'write', actions: 'write' });
});
