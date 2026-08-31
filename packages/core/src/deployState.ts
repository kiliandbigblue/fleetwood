import type { DeployPatterns, MergedConfig } from './config.ts';

/**
 * The merge → build → deploy state machine, with nothing but types around it.
 *
 * A leaf module on purpose: `github.ts` reaches `node:child_process` through
 * `exec.ts`, so a renderer file importing these from there would fail the Vite
 * bundle. Same reason `taskView.ts` exists separately.
 */
/**
 * What the CI on the base branch did with a merge commit.
 *
 * Deliberately not called "deployment status": for most of these repos GitHub
 * holds no such fact. What it holds is the workflow runs attached to the merge
 * commit, and the useful question they *can* answer is whether the trail stops
 * at a built image — which you still have to ship — or at a deploy that ran.
 */
export type DeployState =
  /** Pre-flight runs (test, lint) are still going. */
  | 'checking'
  /** Checks are green and a tag was cut, but no build or deploy run yet. */
  | 'waiting'
  /** A build run is queued or in progress. */
  | 'building'
  /** A deploy run is queued or in progress. */
  | 'deploying'
  /** An image exists and nothing deployed it. This is the one that means work. */
  | 'built'
  /** A deploy run succeeded: the change is live. */
  | 'deployed'
  /** Something red. No tag, no image, or a broken deploy. */
  | 'failed'
  /** No runs on the merge commit — CI elsewhere (Semaphore), or none at all. */
  | 'none';

export type RunRole = 'deploy' | 'build' | 'check';

export interface WorkflowRun {
  /** The workflow's name, which is what the role is read from. */
  name: string;
  role: RunRole;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | cancelled | … ; empty while still running. */
  conclusion: string;
  /**
   * The ref the run was triggered on. For the tag-triggered image builds this is
   * the tag `Autotag` pushed, which is the version you announce.
   */
  headBranch: string;
  url: string;
}

export interface DeployRollup {
  state: DeployState;
  /** The tag a build run reveals, when the trail went through one. */
  tag?: string;
  /** The run that decided the state — where the badge should link. */
  decidedBy?: WorkflowRun;
  runs: WorkflowRun[];
}

const IN_FLIGHT = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED']);
/** `skipped` and `neutral` are not wins: a skipped build built nothing. */
const SUCCEEDED = new Set(['SUCCESS']);
const SKIPPED = new Set(['SKIPPED', 'NEUTRAL', 'STALE', 'ACTION_REQUIRED']);

/**
 * Read a workflow name as deploy / build / pre-flight.
 *
 * Deploy is tested first on purpose: `build_and_deploy` is a deploy, and reading
 * it as a build would tell you to ship a frontend that is already live.
 */
export function classifyRun(name: string, patterns: DeployPatterns): RunRole {
  const match = (source: string): boolean => {
    if (source.trim().length === 0) return false;
    try {
      return new RegExp(source, 'i').test(name);
    } catch {
      // A user-supplied pattern that doesn't compile must not take the list down.
      return false;
    }
  };
  if (match(patterns.deployPattern)) return 'deploy';
  if (match(patterns.buildPattern)) return 'build';
  return 'check';
}

/** Patterns for one repo: the defaults, with that repo's overrides applied. */
export function patternsFor(repo: string, config: MergedConfig): DeployPatterns {
  return {
    deployPattern: config.deployPattern,
    buildPattern: config.buildPattern,
    checkPattern: config.checkPattern,
    ...config.repos[repo],
  };
}

/**
 * Fold a merge commit's workflow runs into one state.
 *
 * `settled` says whether enough time has passed for an absent build to mean
 * "never" rather than "not yet" — the chain is test → autotag → tag push →
 * build, so there is a real window where silence is just latency.
 *
 * Red dominates, as with `summariseChecks`, and that includes a red *check*: a
 * failed `Test and lint` on the base branch means autotag never fires, so no tag
 * and no image are coming. Reporting that as "still checking" would be the one
 * wrong answer.
 */
export function summariseDeploy(runs: WorkflowRun[], opts: { settled: boolean }): DeployRollup {
  const concluded = (run: WorkflowRun): string => run.conclusion.toUpperCase();
  const inFlight = (run: WorkflowRun): boolean =>
    IN_FLIGHT.has(run.status.toUpperCase()) || run.conclusion.trim().length === 0;
  const won = (run: WorkflowRun): boolean => !inFlight(run) && SUCCEEDED.has(concluded(run));
  const lost = (run: WorkflowRun): boolean =>
    !inFlight(run) && !SUCCEEDED.has(concluded(run)) && !SKIPPED.has(concluded(run));

  const deploys = runs.filter((r) => r.role === 'deploy');
  const builds = runs.filter((r) => r.role === 'build');
  const checks = runs.filter((r) => r.role === 'check');
  const outcomes = [...deploys, ...builds];

  // The tag is worth surfacing even when the build failed — it is what you'd
  // name in the Slack message, and what you'd re-run.
  const tagged = builds.find((r) => r.headBranch.trim().length > 0 && /\d/.test(r.headBranch));
  const tag = tagged?.headBranch;

  const decide = (state: DeployState, decidedBy?: WorkflowRun): DeployRollup => ({
    state,
    tag,
    decidedBy,
    runs,
  });

  const brokenOutcome = outcomes.find(lost);
  if (brokenOutcome) return decide('failed', brokenOutcome);
  // Only when nothing downstream ran: a green build after a flaky-then-fixed
  // check is not a failure.
  if (outcomes.length === 0) {
    const brokenCheck = checks.find(lost);
    if (brokenCheck) return decide('failed', brokenCheck);
  }

  const deploying = deploys.find(inFlight);
  if (deploying) return decide('deploying', deploying);
  const building = builds.find(inFlight);
  if (building) return decide('building', building);

  const deployed = deploys.find(won);
  if (deployed) return decide('deployed', deployed);
  const built = builds.find(won);
  if (built) return decide('built', built);

  // Nothing downstream ran, or everything downstream was skipped.
  const checking = checks.find(inFlight);
  if (checking) return decide('checking', checking);
  if (runs.length === 0) return decide(opts.settled ? 'none' : 'checking');
  // A green autotag means a tag exists, so a build is genuinely expected.
  const autotag = checks.find((r) => /autotag/i.test(r.name) && won(r));
  if (autotag && !opts.settled) return decide('waiting', autotag);
  return decide(opts.settled ? 'none' : 'checking');
}

/** True once an absent build or deploy run means "never", not "not yet". */
export function isSettled(mergedAt: string, settleMinutes: number, now = Date.now()): boolean {
  const at = Date.parse(mergedAt);
  if (Number.isNaN(at)) return true;
  return now - at > settleMinutes * 60_000;
}

/** No further run will change these, so they never need re-querying. */
export function isTerminal(state: DeployState): boolean {
  return state === 'deployed' || state === 'built' || state === 'failed' || state === 'none';
}


/**
 * Nothing more is owed on this one.
 *
 * Either a deploy run succeeded, or you said you shipped it. Both the sort order
 * and the "to deploy" count are built on this, so they cannot disagree.
 *
 * Structurally typed rather than taking a `MergedPr`, which lives in `github.ts`
 * — that would put the import cycle back.
 */
export function isDone(pr: { deploy: { state: DeployState }; deployedByHand?: number }): boolean {
  return pr.deployedByHand !== undefined || pr.deploy.state === 'deployed';
}

/** Still owed: merged, an image exists, and nothing has deployed it. */
export function needsDeploy(pr: { deploy: { state: DeployState }; deployedByHand?: number }): boolean {
  return !isDone(pr) && pr.deploy.state === 'built';
}

/** Newest first, with anything still owed above anything already finished. */
export function byUrgencyThenRecency(
  a: { deploy: { state: DeployState }; deployedByHand?: number; mergedAt: string },
  b: { deploy: { state: DeployState }; deployedByHand?: number; mergedAt: string },
): number {
  const done = Number(isDone(a)) - Number(isDone(b));
  return done !== 0 ? done : b.mergedAt.localeCompare(a.mergedAt);
}

/**
 * Finished, and finished before `since` (epoch seconds).
 *
 * The rows the merged list can hide: what you dealt with on a day you have
 * already stopped thinking about. A hand-mark carries its own moment, so a PR
 * merged last week but shipped this morning still counts as today's — that is
 * the whole point of the mark. A CI deploy carries none, so the merge stands in
 * for it; the run happened minutes later, which never crosses a day boundary
 * that the merge did not.
 */
export function doneBefore(
  pr: { deploy: { state: DeployState }; deployedByHand?: number; mergedAt: string },
  since: number,
): boolean {
  if (!isDone(pr)) return false;
  const at = pr.deployedByHand ?? Math.floor(Date.parse(pr.mergedAt) / 1000);
  // An unparseable date is not evidence of age — leave the row in view.
  return Number.isFinite(at) && at < since;
}

/** Local midnight before `now` (ms), in epoch seconds: the cut between today and before. */
export function startOfDay(now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return Math.floor(midnight.getTime() / 1000);
}
