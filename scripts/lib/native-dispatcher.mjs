// Naming contract for the sharded native dispatcher workflows (native.yml,
// native-2.yml, ...). Kept dependency-free so scripts that run without
// `pnpm install` (such as scripts/ci-usage-report.mjs) can classify them
// without loading the app planner or YAML parser.
export const DISPATCHER = 'native';
export const dispatcherName = (index) => (index === 0 ? DISPATCHER : `${DISPATCHER}-${index + 1}`);
export const isDispatcher = (name) => name === DISPATCHER || /^native-(?:[2-9]|[1-9]\d+)$/.test(name);
