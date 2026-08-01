import { execFileSync } from 'node:child_process';
import { validateLocalReleaseState, validateReleaseVersion } from './release-contract.js';

function git(rootDir, args) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim();
}

export function resolveLocalReleaseIdentity(rootDir, versionValue) {
  const version = validateReleaseVersion(versionValue);
  const tag = `v${version}`;
  const sourceCommit = git(rootDir, ['rev-parse', '--verify', 'HEAD']);
  const workingTreeStatus = git(rootDir, ['status', '--porcelain=v1', '--untracked-files=all']);

  let tagObject;
  let tagType;
  let tagCommit;
  try {
    const tagRef = `refs/tags/${tag}`;
    tagObject = git(rootDir, ['for-each-ref', '--format=%(objectname)', tagRef]);
    tagType = tagObject ? git(rootDir, ['cat-file', '-t', tagRef]) : undefined;
    tagCommit = tagObject
      ? git(rootDir, ['rev-parse', '--verify', `${tagRef}^{commit}`])
      : undefined;
  } catch {
    // The contract below maps every missing or malformed ref to one stable error.
  }

  return validateLocalReleaseState({
    versionValue: version,
    sourceCommit,
    workingTreeStatus,
    tagObject,
    tagType,
    tagCommit,
  });
}
