export type ReleaseLevel = "patch" | "minor" | "major";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

export function parseVersion(text: string): { major: number; minor: number; patch: number; rc: number | undefined } | undefined {
  const m = SEMVER.exec(text.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), rc: m[4] === undefined ? undefined : Number(m[4]) };
}

function bump(base: { major: number; minor: number; patch: number }, level: ReleaseLevel): string {
  if (level === "major") return `${base.major + 1}.0.0`;
  if (level === "minor") return `${base.major}.${base.minor + 1}.0`;
  return `${base.major}.${base.minor}.${base.patch + 1}`;
}

/**
 * Next release-candidate version for the release branch.
 * `mainVersion` is the last shipped version; `branchVersion` is what the release branch holds now.
 */
export function nextCandidate(mainVersion: string, branchVersion: string, level: ReleaseLevel): string {
  const main = parseVersion(mainVersion);
  const branch = parseVersion(branchVersion);
  if (!main) throw new Error(`cannot parse version ${mainVersion}`);
  const target = bump(main, level);
  if (branch?.rc !== undefined && `${branch.major}.${branch.minor}.${branch.patch}` === target) return `${target}-rc.${branch.rc + 1}`;
  return `${target}-rc.1`;
}

/** Final version when the release lands on main. */
export function nextFinal(mainVersion: string, level: ReleaseLevel): string {
  const main = parseVersion(mainVersion);
  if (!main) throw new Error(`cannot parse version ${mainVersion}`);
  return bump(main, level);
}

export function highestLevel(levels: ReleaseLevel[]): ReleaseLevel {
  if (levels.includes("major")) return "major";
  if (levels.includes("minor")) return "minor";
  return "patch";
}

export function levelFromLabels(labels: string[]): ReleaseLevel {
  if (labels.includes("release:major")) return "major";
  if (labels.includes("release:minor")) return "minor";
  return "patch";
}
