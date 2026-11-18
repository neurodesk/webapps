// SMOKE_APPS narrows the checks that run over the built site (the interface
// audit, the composite, mobile, runtime-startup and workflow smokes) to a
// comma-separated list of app ids. Unset or empty, every check covers the whole
// catalogue, as `pnpm audit:interfaces` and the other local commands do.
// ci.yml sets it from the app plan (siteCheckApps) on pull requests and pushes.

// One app of each shell runs every scoped check, so a regression in shared
// shell, layout or runtime code shows even when the plan selected no app of
// that shell. test/smoke-apps.test.mjs requires one per registered shell.
export const CANARY_APPS = Object.freeze({
  'static-html': 'seedseg',
  react: 'dicompare',
  'imaging-workspace': 'syncro',
});

// The registered apps a site check runs on, in registry order, and whether
// SMOKE_APPS narrowed them. An unknown or empty id is an error, never a pass
// over fewer apps.
export function smokeApps(apps, value = process.env.SMOKE_APPS) {
  const text = (value ?? '').trim();
  if (!text) return { apps, filtered: false };
  const ids = text.split(',').map((id) => id.trim());
  if (ids.includes('')) throw new Error(`SMOKE_APPS has an empty entry: "${value}"`);
  const unknown = ids.filter((id) => !apps.some((app) => app.id === id));
  if (unknown.length) throw new Error(`SMOKE_APPS names apps the registry does not have: ${unknown.join(', ')}`);
  const wanted = new Set(ids);
  return { apps: apps.filter((app) => wanted.has(app.id)), filtered: true };
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
  const canaries = Object.values(CANARY_APPS);
  const ids = registry.apps.map((app) => app.id).filter((id) => selected.includes(id) || canaries.includes(id));
  const added = canaries.filter((id) => !selected.includes(id));
  return {
    value: ids.join(','),
    reason: `${selected.length ? `the selected apps (${selected.join(', ')})` : 'no selected app'} and the canaries ${added.join(', ') || 'among them'}`,
  };
}
