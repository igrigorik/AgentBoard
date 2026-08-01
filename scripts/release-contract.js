import { createHash } from 'node:crypto';

export const RELEASE_METADATA_FILE = 'RELEASE-METADATA.json';
export const RELEASE_SOURCE_FILES = ['LICENSE', 'README.md', 'PRIVACY.md'];

export function validateReleaseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('package.json version must be three numeric components');
  }
  return value;
}

export function validateLocalReleaseState({
  versionValue,
  sourceCommit,
  workingTreeStatus,
  tagObject,
  tagType,
  tagCommit,
}) {
  const version = validateReleaseVersion(versionValue);
  const tag = `v${version}`;
  if (workingTreeStatus) throw new Error('Release requires a clean working tree.');
  if (!tagObject || tagType !== 'tag' || !tagCommit) {
    throw new Error(`Annotated local tag ${tag} is missing or invalid.`);
  }
  if (tagCommit !== sourceCommit) throw new Error(`Local tag ${tag} does not point to HEAD.`);
  return { version, tag, sourceCommit, tagObject };
}

export function releaseMetadataBytes(identity, files) {
  const inventory = files.map((file) => ({
    path: file.path,
    size: file.bytes.byteLength,
    sha256: createHash('sha256').update(file.bytes).digest('hex'),
  }));
  return Buffer.from(
    `${JSON.stringify(
      {
        formatVersion: 1,
        version: identity.version,
        tag: identity.tag,
        sourceCommit: identity.sourceCommit,
        files: inventory,
      },
      null,
      2
    )}\n`
  );
}

export function validateRemoteReleaseIdentity(remoteTags, identity) {
  const remoteRefs = new Map(
    remoteTags
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [object, ref] = line.split(/\s+/, 2);
        return [ref, object];
      })
  );
  const remoteTagObject = remoteRefs.get(`refs/tags/${identity.tag}`);
  const remoteTagCommit = remoteRefs.get(`refs/tags/${identity.tag}^{}`);
  if (!remoteTagObject || !remoteTagCommit) {
    throw new Error(`Annotated remote tag ${identity.tag} is missing.`);
  }
  if (remoteTagObject !== identity.tagObject || remoteTagCommit !== identity.sourceCommit) {
    throw new Error(`Remote tag ${identity.tag} does not match the reviewed local tag and HEAD.`);
  }
}

export function validateReleaseChecksum(checksumLine, zipName, zipBytes) {
  const checksumMatch = /^([a-f0-9]{64})  (\S+)$/.exec(checksumLine.trim());
  if (!checksumMatch || checksumMatch[2] !== zipName) {
    throw new Error('Checksum sidecar has invalid content.');
  }
  const actualChecksum = createHash('sha256').update(zipBytes).digest('hex');
  if (checksumMatch[1] !== actualChecksum) {
    throw new Error('Release ZIP does not match its SHA-256 sidecar.');
  }
  return actualChecksum;
}

export function validateReleaseMetadata(metadata, manifest, identity) {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    metadata.formatVersion !== 1 ||
    metadata.version !== identity.version ||
    metadata.tag !== identity.tag ||
    metadata.sourceCommit !== identity.sourceCommit ||
    !Array.isArray(metadata.files)
  ) {
    throw new Error('Release ZIP metadata does not match clean tagged HEAD.');
  }
  if (!manifest || typeof manifest !== 'object' || manifest.version !== identity.version) {
    throw new Error(`Release ZIP manifest version does not match ${identity.version}.`);
  }
}

export function repositoryName(repositoryUrl) {
  try {
    const url = new URL(repositoryUrl);
    const parts = url.pathname
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      parts.length !== 2 ||
      !parts.every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part))
    ) {
      throw new Error('unsupported repository URL');
    }
    return parts.join('/');
  } catch {
    throw new Error('package.json must declare a canonical HTTPS GitHub repository URL');
  }
}

export function draftReleaseArgs({ tag, zipFile, checksumFile, repository }) {
  return [
    'release',
    'create',
    tag,
    zipFile,
    checksumFile,
    '--repo',
    repository,
    '--title',
    `AgentBoard ${tag}`,
    '--draft',
    '--verify-tag',
    '--generate-notes',
  ];
}
