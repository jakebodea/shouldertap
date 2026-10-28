import { parse } from "yaml";

// A job whose `if:` has no status function gets an implicit success(), which
// GitHub checks against every job up its needs chain, not just its direct
// needs. Behind an aggregate that runs with always()/!cancelled(), that
// silently skips the job whenever any upstream skipped: prod deploy was
// skipped on every push to main because PR-only `preview` skips on push.
const STATUS_FUNCTION = /\b(?:success|failure|always|cancelled)\(\)/u;

interface Job {
  needs?: string | string[];
  if?: string;
}

const needsOf = (job: Job | undefined) =>
  job?.needs === undefined ? [] : [job.needs].flat();

const hasStatusFunction = (job: Job | undefined) =>
  STATUS_FUNCTION.test(String(job?.if ?? ""));

export const findImplicitGatesBehindAggregates = (
  file: string,
  text: string
): string[] => {
  const jobs: Record<string, Job> = parse(text)?.jobs ?? {};
  const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
    for (const need of needsOf(jobs[name])) {
      if (!seen.has(need)) {
        seen.add(need);
        ancestors(need, seen);
      }
    }
    return seen;
  };
  return Object.keys(jobs).flatMap((name) => {
    if (hasStatusFunction(jobs[name])) {
      return [];
    }
    return [...ancestors(name)]
      .filter((aggregate) => hasStatusFunction(jobs[aggregate]))
      .map(
        (aggregate) =>
          `${file}: job "${name}" has an implicit success() over everything ${aggregate} tolerates; gate on \${{ !cancelled() && needs.${aggregate}.result == 'success' }}`
      );
  });
};
