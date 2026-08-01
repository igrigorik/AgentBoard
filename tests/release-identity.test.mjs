// @vitest-environment node

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  RELEASE_METADATA_FILE,
  RELEASE_SOURCE_FILES,
  draftReleaseArgs,
  releaseMetadataBytes,
  repositoryName,
  validateLocalReleaseState,
  validateReleaseChecksum,
  validateReleaseMetadata,
  validateReleaseVersion,
  validateRemoteReleaseIdentity,
} from '../scripts/release-contract.js';

const identity = {
  version: '9.9.9',
  tag: 'v9.9.9',
  sourceCommit: 'c'.repeat(40),
  tagObject: 'a'.repeat(40),
};

const localState = {
  versionValue: identity.version,
  sourceCommit: identity.sourceCommit,
  workingTreeStatus: '',
  tagObject: identity.tagObject,
  tagType: 'tag',
  tagCommit: identity.sourceCommit,
};

describe('release contract', () => {
  it('accepts only one clean annotated tag at HEAD', () => {
    expect(validateReleaseVersion('1.2.3')).toBe('1.2.3');
    expect(() => validateReleaseVersion('v1.2.3')).toThrow(
      'package.json version must be three numeric components'
    );
    expect(validateLocalReleaseState(localState)).toEqual(identity);
    expect(() =>
      validateLocalReleaseState({ ...localState, workingTreeStatus: '?? untracked.txt' })
    ).toThrow('Release requires a clean working tree');
    for (const invalidTag of [{ tagType: 'commit' }, { tagCommit: undefined }]) {
      expect(() => validateLocalReleaseState({ ...localState, ...invalidTag })).toThrow(
        'Annotated local tag v9.9.9 is missing or invalid'
      );
    }
    expect(() => validateLocalReleaseState({ ...localState, tagCommit: 'b'.repeat(40) })).toThrow(
      'Local tag v9.9.9 does not point to HEAD'
    );
  });

  it('binds release metadata to the exact payload bytes', () => {
    const files = [
      { path: 'app.js', bytes: Buffer.from('reviewed build') },
      { path: 'manifest.json', bytes: Buffer.from('{"version":"9.9.9"}') },
    ];
    const metadata = releaseMetadataBytes(identity, files);
    const parsed = JSON.parse(metadata.toString('utf8'));

    expect(RELEASE_METADATA_FILE).toBe('RELEASE-METADATA.json');
    expect(RELEASE_SOURCE_FILES).toEqual(['LICENSE', 'README.md', 'PRIVACY.md']);
    expect(parsed).toMatchObject({
      formatVersion: 1,
      version: identity.version,
      tag: identity.tag,
      sourceCommit: identity.sourceCommit,
    });
    expect(parsed.files[0]).toEqual({
      path: 'app.js',
      size: 14,
      sha256: '34e2628f119bfc3ea9d3d1629190cfed47d49b4fb5701cf498ab02a3207010ba',
    });
    expect(parsed.files.map(({ path }) => path)).toEqual(['app.js', 'manifest.json']);
    expect(
      releaseMetadataBytes(identity, [
        { ...files[0], bytes: Buffer.from('changed build!') },
        files[1],
      ]).equals(metadata)
    ).toBe(false);
  });

  it('requires the remote annotated tag object and commit to match locally', () => {
    const remoteRefs = `${identity.tagObject}\trefs/tags/${identity.tag}\n${identity.sourceCommit}\trefs/tags/${identity.tag}^{}\n`;
    expect(() => validateRemoteReleaseIdentity(remoteRefs, identity)).not.toThrow();
    expect(() =>
      validateRemoteReleaseIdentity(`${identity.tagObject}\trefs/tags/${identity.tag}\n`, identity)
    ).toThrow('Annotated remote tag v9.9.9 is missing');
    expect(() =>
      validateRemoteReleaseIdentity(
        `${identity.tagObject}\trefs/tags/${identity.tag}\n${'0'.repeat(40)}\trefs/tags/${identity.tag}^{}\n`,
        identity
      )
    ).toThrow('Remote tag v9.9.9 does not match the reviewed local tag and HEAD');
  });

  it('rejects mismatched checksums and embedded release identity', () => {
    const zipName = 'agentboard-9.9.9.zip';
    const zipBytes = Buffer.from('release archive');
    const checksum = createHash('sha256').update(zipBytes).digest('hex');
    expect(validateReleaseChecksum(`${checksum}  ${zipName}\n`, zipName, zipBytes)).toBe(checksum);
    expect(() => validateReleaseChecksum(`${checksum}  wrong.zip\n`, zipName, zipBytes)).toThrow(
      'Checksum sidecar has invalid content'
    );
    expect(() =>
      validateReleaseChecksum(`${checksum}  ${zipName}\n`, zipName, Buffer.from('tampered'))
    ).toThrow('Release ZIP does not match its SHA-256 sidecar');

    const metadata = { ...identity, formatVersion: 1, files: [] };
    expect(() =>
      validateReleaseMetadata(metadata, { version: identity.version }, identity)
    ).not.toThrow();
    expect(() => validateReleaseMetadata(null, { version: identity.version }, identity)).toThrow(
      'Release ZIP metadata does not match clean tagged HEAD'
    );
    expect(() =>
      validateReleaseMetadata(
        { ...metadata, sourceCommit: '0'.repeat(40) },
        { version: identity.version },
        identity
      )
    ).toThrow('Release ZIP metadata does not match clean tagged HEAD');
    for (const manifest of [null, { version: '1.0.0' }]) {
      expect(() => validateReleaseMetadata(metadata, manifest, identity)).toThrow(
        'Release ZIP manifest version does not match 9.9.9'
      );
    }
  });

  it('targets one canonical repository with a draft-only GitHub command', () => {
    expect(repositoryName('https://github.com/example/agentboard.git')).toBe('example/agentboard');
    for (const invalid of [
      'http://github.com/example/agentboard.git',
      'https://example.com/example/agentboard.git',
      'https://github.com/example/agentboard/extra',
    ]) {
      expect(() => repositoryName(invalid)).toThrow(
        'package.json must declare a canonical HTTPS GitHub repository URL'
      );
    }

    expect(
      draftReleaseArgs({
        tag: identity.tag,
        zipFile: '/release/agentboard-9.9.9.zip',
        checksumFile: '/release/agentboard-9.9.9.zip.sha256',
        repository: 'example/agentboard',
      })
    ).toEqual([
      'release',
      'create',
      'v9.9.9',
      '/release/agentboard-9.9.9.zip',
      '/release/agentboard-9.9.9.zip.sha256',
      '--repo',
      'example/agentboard',
      '--title',
      'AgentBoard v9.9.9',
      '--draft',
      '--verify-tag',
      '--generate-notes',
    ]);
  });
});
