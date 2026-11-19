import { certainOwnStart, dispatchDecision, mainWorkflow, startsItself } from './workflow-gate.mjs';

// The selection native.yml's gate makes (scripts/workflow-gate.mjs --native):
// the workflows it calls for a pull request, or sweeps nightly.
//
// The decision has one boundary. Every eligible workflow starts selected, and
// each stage that throws, times out or cannot be read leaves the workflows it
// was deciding selected, as the old per-workflow gate ran a workflow it could
// not decide for. A selection is narrower than every eligible workflow only
// where the decision read everything it needed: a pull request's diff and a
// workflow's own filters establish that GitHub started the workflow itself
// (certainOwnStart), and the gate's answer that a change does not reach it.
// The stages are injected, so that a test can make each of them fail.

const runs = (reason) => ({ run: true, reason });
const describe = (error) => (error instanceof Error ? error.message : String(error));

function selection(eligible) {
  const decisions = new Map(eligible.map((name) => [name, runs('the decision did not reach it')]));
  return {
    decisions,
    // Every workflow still selected, or those of `names`, runs for `reason`.
    open(reason, names = [...decisions.keys()]) {
      for (const name of names) if (decisions.get(name).run) decisions.set(name, runs(reason));
    },
  };
}

// A pull request. Stages: readDiff() gives readChangedPaths's answer,
// readFlow(name) a parsed workflow file, readContext(diff) what decideWorkflow
// reads besides the flow and the diff (manifests, registry, graph, root),
// decide({ name, flow, diff, ...context }) one workflow's decision, and
// budget(context, diff) the full-plan verdict ({ withheld, reason }). `deadline`
// is a time from `clock`; a workflow not decided by then runs.
export async function pullRequestSelection({ eligible, readDiff, readFlow, readContext, decide = defaultDecide, budget, deadline = Infinity, clock = Date.now }) {
  const { decisions, open } = selection(eligible);
  let diff;
  try {
    diff = await readDiff();
  } catch (error) {
    diff = { ok: false, reason: describe(error) };
  }
  if (!diff?.ok) {
    open(`the changed paths are unknown (${diff?.reason ?? 'no answer'})`);
    return { decisions };
  }
  // A workflow GitHub certainly started itself is left to its own run; every other one is decided.
  const flows = new Map();
  for (const name of eligible) {
    let flow;
    try {
      flow = await readFlow(name);
    } catch (error) {
      open(`its workflow file could not be read (${describe(error)})`, [name]);
      continue;
    }
    let own = null;
    try {
      own = certainOwnStart(flow, diff);
    } catch {
      // Not established: it is decided.
    }
    if (own) decisions.set(name, { run: false, reason: startsItself(own) });
    else flows.set(name, flow);
  }
  let context;
  try {
    context = await readContext(diff);
  } catch (error) {
    open(`the decision could not read its inputs (${describe(error)})`, [...flows.keys()]);
    return { decisions };
  }
  for (const [name, flow] of flows) {
    if (!(clock() < deadline)) {
      open('the decision ran out of time before reaching it', [name]);
      continue;
    }
    try {
      const decision = await decide({ name, flow, diff, ...context });
      if (typeof decision?.run !== 'boolean') throw new Error(`no decision (${JSON.stringify(decision)})`);
      decisions.set(name, decision);
    } catch (error) {
      open(`the gate could not decide (${describe(error)})`, [name]);
    }
  }
  if (![...decisions.values()].some((decision) => decision.run)) return { decisions };
  // The budget is read within the same deadline. An answer that is not a
  // confirmed denial (a check that fails, times out or is not reached) runs
  // the workflows, as budgetedDecision does for one workflow.
  let verdict = { withheld: false };
  if (budget && clock() < deadline) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ withheld: false }), Math.max(0, deadline - clock()));
    });
    try {
      verdict = (await Promise.race([budget(context, diff), late])) ?? verdict;
    } catch {
      verdict = { withheld: false };
    } finally {
      clearTimeout(timer);
    }
  }
  return { decisions, withheld: verdict.withheld === true ? verdict.reason ?? 'the full-plan budget is spent' : null };
}

function defaultDecide({ flow, diff, ...context }) {
  return dispatchDecision({ flow, changedPaths: diff.paths, renamed: diff.renamed, ...context });
}

// The nightly sweep. Stages: readRegistry(), readFlow(name), readBase(name,
// flow) the commit the workflow last finished green at ({ base, reason }),
// and readRange(base) readChangedPaths's answer with `manifests`. A workflow
// whose base is unknown, whose range is unreadable, or that the decision has
// not reached by `deadline` runs.
export async function sweepSelection({ eligible, readRegistry, readFlow, readBase, readRange, decide = mainWorkflow, deadline = Infinity, clock = Date.now }) {
  const { decisions, open } = selection(eligible);
  let registry;
  try {
    registry = await readRegistry();
  } catch (error) {
    open(`the app registry could not be read (${describe(error)})`);
    return { decisions };
  }
  for (const name of eligible) {
    if (!(clock() < deadline)) {
      open('its history was not read before the deadline', [name]);
      continue;
    }
    try {
      const flow = await readFlow(name);
      const tested = await readBase(name, flow);
      if (!tested?.base) {
        open(tested?.reason ?? 'the commit it last finished green at is unknown', [name]);
        continue;
      }
      const range = await readRange(tested.base);
      if (!range?.ok) {
        open(`the changed paths are unknown (${range?.reason ?? 'no answer'})`, [name]);
        continue;
      }
      const decision = decide({ flow, changedPaths: range.paths, manifests: range.manifests, registry, event: 'schedule' });
      if (typeof decision?.run !== 'boolean') throw new Error(`no decision (${JSON.stringify(decision)})`);
      decisions.set(name, decision);
    } catch (error) {
      open(`the base it diffs from is unknown (${describe(error)})`, [name]);
    }
  }
  return { decisions };
}

// What the gate passes on, the confirmed denial first: `writeOutput` puts
// `withheld=true` in the step's outputs before anything else, so no later
// failure can erase it. Otherwise the answer is the skip list: the names whose
// verdict is an explicit skip, which pr-gate.yml checks against the workflows
// native.yml may call before it passes it on. A workflow missing from it runs,
// so a dropped, unknown or truncated name can only run more. A summary that
// cannot be written changes neither the verdict nor the exit code, which it
// returns.
export async function publishNative({ eligible, result, writeOutput, writeSkips, writeSummary }) {
  if (result.withheld) {
    await writeOutput('withheld=true');
    console.log(`::error title=Full plan withheld::native: ${result.withheld}`);
  } else {
    await writeSkips(JSON.stringify(eligible.filter((name) => result.decisions.get(name)?.run === false)));
  }
  const lines = eligible.map((name) => {
    const decision = result.decisions.get(name);
    return `${name} ${decision?.run === false ? 'is skipped' : 'runs'}: ${decision?.reason ?? 'the decision did not reach it'}`;
  });
  try {
    await writeSummary(lines);
  } catch (error) {
    console.error(`native: the summary could not be written (${describe(error)})`);
  }
  return result.withheld ? 1 : 0;
}
