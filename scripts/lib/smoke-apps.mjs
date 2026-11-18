// SMOKE_APPS narrows the checks that run over the built site (the interface
// audit, the composite, mobile, runtime-startup and workflow smokes) to a
// comma-separated list of app ids. Unset or empty, every check covers the whole
// catalogue, as `pnpm audit:interfaces` and the other local commands do.
// ci.yml sets it from the app plan (siteCheckApps) on pull requests and pushes.
// The plan already holds every app a change reaches, including apps whose
// pages carry another app's registry data or files (scripts/lib/app-plan.mjs);
// a check adds the apps it compares or reads beyond that through `needs`.

// One app of each shell runs every scoped check, so a regression in shared
// shell, layout or runtime code shows even when the plan selected no app of
// that shell. siteCheckApps fails unless each is a registered app of its shell
// and every registered shell has one.
export const CANARY_APPS = Object.freeze({
  'static-html': 'seedseg',
  react: 'dicompare',
  'imaging-workspace': 'syncro',
});

// The registered apps a site check runs on, in registry order, and whether
// SMOKE_APPS narrowed them. An unknown or empty id is an error, never a pass
// over fewer apps.
//
// A check whose result for one app depends on another app (it compares their
// outputs, or reads a file from the other app's directory) declares that in
// `needs(id, listed)`: the ids of the other apps it must also run when `id` is
// listed (`listed` is the set SMOKE_APPS names), or null when it cannot tell,
// which runs the check over every app. `added` lists the ids it brought in.
export function smokeApps(apps, value = process.env.SMOKE_APPS, needs = () => []) {
  const text = (value ?? '').trim();
  if (!text) return { apps, filtered: false, added: [] };
  const ids = text.split(',').map((id) => id.trim());
  if (ids.includes('')) throw new Error(`SMOKE_APPS has an empty entry: "${value}"`);
  const unknown = (list) => list.filter((id) => !apps.some((app) => app.id === id));
  if (unknown(ids).length) throw new Error(`SMOKE_APPS names apps the registry does not have: ${unknown(ids).join(', ')}`);
  const listed = new Set(ids);
  const wanted = new Set(ids);
  for (const id of ids) {
    const extra = needs(id, listed);
    if (extra === null) return { apps, filtered: false, added: [], widened: id };
    if (unknown(extra).length) throw new Error(`A check of ${id} needs apps the registry does not have: ${unknown(extra).join(', ')}`);
    for (const other of extra) wanted.add(other);
  }
  return {
    apps: apps.filter((app) => wanted.has(app.id)),
    filtered: true,
    added: apps.map((app) => app.id).filter((id) => wanted.has(id) && !listed.has(id)),
  };
}

// The `needs` of a check that reads files from app directories to check other
// apps: `readers` maps each repository path the check reads to the app ids
// whose result depends on it, so listing the app that owns the path runs those.
export function appFileReaders(readers) {
  const owners = Object.entries(readers).map(([path, ids]) => {
    const owner = path.match(/^apps\/([^/]+)\//)?.[1];
    if (!owner) throw new Error(`${path} is not a file of an app directory`);
    return [owner, ids];
  });
  return (id) => owners.filter(([owner]) => owner === id).flatMap(([, ids]) => ids);
}

// A narrowed check that found nothing to check fails: an empty pass would hide
// a selection that missed every app the check covers.
export function requireChecked(checked, selection, label) {
  if (selection.filtered && checked === 0) {
    throw new Error(`${label}: none of the apps SMOKE_APPS lists (${selection.apps.map((app) => app.id).join(', ')}) has anything this check covers`);
  }
}

// The SMOKE_APPS value for ci.yml's site checks: '' (the whole catalogue) on
// the nightly, on a dispatch with scope all or site, when the plan selected
// every app, and when the change reaches code the site jobs run (the checks
// themselves, the composite build); otherwise the apps the plan selected and
// the canaries. `plan` holds the app-plan job's outputs as strings.
export function siteCheckApps(registry, { event, scope, plan }) {
  const canaries = canaryApps(registry);
  const whole = (reason) => ({ value: '', reason: `every app: ${reason}` });
  if (event === 'schedule') return whole('the nightly run checks the whole catalogue');
  if (event === 'workflow_dispatch' && ['all', 'site'].includes(scope)) return whole(`a dispatch with scope ${scope}`);
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(event)) return whole(`${event} is not a planned event`);
  if (plan.all_apps === 'true') return whole('the plan selected every app');
  if (plan.site_code === 'true') return whole('the change reaches code the site jobs run');
  if (plan.site_code !== 'false') return whole('the plan does not say whether the change reaches code the site jobs run');
  const selected = JSON.parse(plan.selected_ids);
  // Rejects an id the registry does not have.
  smokeApps(registry.apps, selected.join(','));
  const ids = registry.apps.map((app) => app.id).filter((id) => selected.includes(id) || canaries.includes(id));
  const added = canaries.filter((id) => !selected.includes(id));
  return {
    value: ids.join(','),
    reason: `${selected.length ? `the selected apps (${selected.join(', ')})` : 'no selected app'} and the canaries ${added.join(', ') || 'among them'}`,
  };
}

// The canary ids, once each is a registered app of the shell it stands for and
// every registered shell has one: a canary that is missing or of another shell
// would leave that shell's code unchecked while the summary still named it.
function canaryApps(registry) {
  const errors = [];
  for (const [shell, id] of Object.entries(CANARY_APPS)) {
    const app = registry.apps.find((candidate) => candidate.id === id);
    if (!app) errors.push(`the ${shell} canary ${id} is not a registered app`);
    else if (app.shell !== shell) errors.push(`the ${shell} canary ${id} is a ${app.shell} app`);
  }
  for (const shell of new Set(registry.apps.map((app) => app.shell))) {
    if (!Object.hasOwn(CANARY_APPS, shell)) errors.push(`no canary stands for the ${shell} shell`);
  }
  if (errors.length) throw new Error(`CANARY_APPS in scripts/lib/smoke-apps.mjs: ${errors.join('; ')}`);
  return Object.values(CANARY_APPS);
}
