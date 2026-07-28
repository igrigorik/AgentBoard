import { execFileSync } from 'node:child_process';

export const RELEASE_METADATA_FILE = 'RELEASE-METADATA.json';
export const RELEASE_SOURCE_FILES = ['LICENSE', 'README.md', 'PRIVACY.md'];

export function validateReleaseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('package.json version must be three numeric components');
  }
  return value;
}

function git(rootDir, args) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim();
}

export function resolveLocalReleaseIdentity(rootDir, versionValue) {
  const version = validateReleaseVersion(versionValue);
  const tag = `v${version}`;
  const sourceCommit = git(rootDir, ['rev-parse', '--verify', 'HEAD']);
  if (git(rootDir, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('Release requires a clean working tree.');
  }

  const tagRef = `refs/tags/${tag}`;
  let tagObject;
  let tagCommit;
  try {
    tagObject = git(rootDir, ['for-each-ref', '--format=%(objectname)', tagRef]);
    if (!tagObject || git(rootDir, ['cat-file', '-t', tagRef]) !== 'tag') {
      throw new Error('not an annotated tag');
    }
    tagCommit = git(rootDir, ['rev-parse', '--verify', `${tagRef}^{commit}`]);
  } catch {
    throw new Error(`Annotated local tag ${tag} is missing or invalid.`);
  }
  if (tagCommit !== sourceCommit) throw new Error(`Local tag ${tag} does not point to HEAD.`);

  return { version, tag, sourceCommit, tagObject };
}
