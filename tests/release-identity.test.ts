import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const repositories: string[] = [];

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function repository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agentboard-release-identity-'));
  repositories.push(directory);
  git(directory, ['init', '--quiet']);
  git(directory, ['config', 'user.name', 'Release Test']);
  git(directory, ['config', 'user.email', 'release@example.test']);
  git(directory, ['config', 'commit.gpgsign', 'false']);
  git(directory, ['config', 'tag.gpgSign', 'false']);
  writeFileSync(path.join(directory, 'source.txt'), 'reviewed source\n');
  git(directory, ['add', 'source.txt']);
  git(directory, ['commit', '--quiet', '-m', 'Reviewed source']);
  return directory;
}

function releaseRepository(tagKind: 'annotated' | 'lightweight' | 'branch' = 'annotated'): string {
  const directory = repository();
  mkdirSync(path.join(directory, 'scripts'));
  for (const file of ['package-release.js', 'release-identity.js', 'github-release.js']) {
    cpSync(path.join(projectRoot, 'scripts', file), path.join(directory, 'scripts', file));
  }
  for (const file of ['LICENSE', 'README.md', 'PRIVACY.md']) {
    writeFileSync(path.join(directory, file), `${file} at reviewed commit\n`);
  }
  writeFileSync(
    path.join(directory, 'package.json'),
    '{"version":"9.9.9","repository":{"url":"https://github.com/example/agentboard.git"}}\n'
  );
  writeFileSync(path.join(directory, '.gitignore'), 'dist/\nrelease/\nnode_modules\n');
  symlinkSync(
    path.join(projectRoot, 'node_modules'),
    path.join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  git(directory, ['add', '.']);
  git(directory, ['commit', '--quiet', '--amend', '--no-edit']);
  if (tagKind === 'annotated') {
    git(directory, ['tag', '-a', 'v9.9.9', '-m', 'AgentBoard v9.9.9']);
  } else if (tagKind === 'lightweight') {
    git(directory, ['tag', 'v9.9.9']);
  } else {
    git(directory, ['branch', 'v9.9.9']);
  }

  const dist = path.join(directory, 'dist');
  mkdirSync(dist);
  writeFileSync(path.join(dist, 'manifest.json'), '{"version":"9.9.9"}\n');
  writeFileSync(path.join(dist, 'app.js'), 'console.log("reviewed build");\n');
  return directory;
}

function packageRelease(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, ['scripts/package-release.js', ...args], {
    cwd: directory,
    encoding: 'utf8',
  });
}

function githubRelease(directory: string, remoteCommit = git(directory, ['rev-parse', 'HEAD'])) {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'agentboard-release-bin-'));
  repositories.push(fakeBin);
  const tagObject = git(directory, ['rev-parse', 'refs/tags/v9.9.9']);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    path.join(fakeBin, 'git'),
    `#!/bin/sh\nif [ "$1" = "ls-remote" ]; then\n  printf '${tagObject}\\trefs/tags/v9.9.9\\n${remoteCommit}\\trefs/tags/v9.9.9^{}\\n'\nelse\n  exec "${realGit}" "$@"\nfi\n`
  );
  writeFileSync(
    path.join(fakeBin, 'gh'),
    '#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$FAKE_GH_ARGS"\n'
  );
  chmodSync(path.join(fakeBin, 'git'), 0o755);
  chmodSync(path.join(fakeBin, 'gh'), 0o755);

  const argsFile = path.join(directory, 'release', 'gh-args.txt');
  const result = spawnSync(process.execPath, ['scripts/github-release.js'], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_ARGS: argsFile,
    },
  });
  return { argsFile, result };
}

afterEach(() => {
  for (const directory of repositories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('release identity', () => {
  it('requires a clean HEAD with an annotated version tag', () => {
    const branchOnly = packageRelease(releaseRepository('branch'), '--stamp');
    expect(branchOnly.status).toBe(1);
    expect(branchOnly.stderr).toContain('Annotated local tag v9.9.9 is missing or invalid');

    const lightweight = packageRelease(releaseRepository('lightweight'), '--stamp');
    expect(lightweight.status).toBe(1);
    expect(lightweight.stderr).toContain('Annotated local tag v9.9.9 is missing or invalid');

    const dirty = releaseRepository();
    writeFileSync(path.join(dirty, 'untracked.txt'), 'not reviewed\n');
    const dirtyStamp = packageRelease(dirty, '--stamp');
    expect(dirtyStamp.status).toBe(1);
    expect(dirtyStamp.stderr).toContain('Release requires a clean working tree');

    const staleTag = releaseRepository();
    writeFileSync(path.join(staleTag, 'source.txt'), 'later source\n');
    git(staleTag, ['add', 'source.txt']);
    git(staleTag, ['commit', '--quiet', '-m', 'Later source']);
    const staleStamp = packageRelease(staleTag, '--stamp');
    expect(staleStamp.status).toBe(1);
    expect(staleStamp.stderr).toContain('Local tag v9.9.9 does not point to HEAD');
  });

  it('packages exactly the stamped payload and tagged release documents', () => {
    const directory = releaseRepository();
    const stamped = packageRelease(directory, '--stamp');
    expect(stamped.status, stamped.stderr).toBe(0);

    const metadata = JSON.parse(
      readFileSync(path.join(directory, 'dist', 'RELEASE-METADATA.json'), 'utf8')
    );
    expect(metadata).toMatchObject({
      formatVersion: 1,
      version: '9.9.9',
      tag: 'v9.9.9',
      sourceCommit: git(directory, ['rev-parse', 'HEAD']),
    });
    expect(metadata.files.map(({ path: file }: { path: string }) => file)).toEqual([
      'app.js',
      'manifest.json',
    ]);

    const packaged = packageRelease(directory);
    expect(packaged.status, packaged.stderr).toBe(0);
    const zip = path.join(directory, 'release', 'agentboard-9.9.9.zip');
    expect(
      execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort()
    ).toEqual(
      [
        'LICENSE',
        'PRIVACY.md',
        'README.md',
        'RELEASE-METADATA.json',
        'app.js',
        'manifest.json',
      ].sort()
    );
    expect(readFileSync(`${zip}.sha256`, 'utf8')).toMatch(
      /^[a-f0-9]{64} {2}agentboard-9\.9\.9\.zip\n$/
    );
    expect(
      spawnSync('shasum', ['-a', '256', '-c', `${path.basename(zip)}.sha256`], {
        cwd: path.dirname(zip),
      }).status
    ).toBe(0);
  });

  it('rejects payload changes made after the browser-test stamp', () => {
    const directory = releaseRepository();
    expect(packageRelease(directory, '--stamp').status).toBe(0);
    writeFileSync(path.join(directory, 'dist', 'app.js'), 'console.log("changed after tests");\n');

    const packaged = packageRelease(directory);
    expect(packaged.status).toBe(1);
    expect(packaged.stderr).toContain('Release payload changed after it was stamped');
  });

  it('rejects symbolic links in the release payload', () => {
    const directory = releaseRepository();
    symlinkSync('app.js', path.join(directory, 'dist', 'linked.js'));

    const stamped = packageRelease(directory, '--stamp');
    expect(stamped.status).toBe(1);
    expect(stamped.stderr).toContain('symbolic link');
  });

  it('drafts against the exact remote annotated tag with both release artifacts', () => {
    const directory = releaseRepository();
    expect(packageRelease(directory, '--stamp').status).toBe(0);
    expect(packageRelease(directory).status).toBe(0);

    const { argsFile, result } = githubRelease(directory);
    expect(result.status, result.stderr).toBe(0);
    const zip = realpathSync(path.join(directory, 'release', 'agentboard-9.9.9.zip'));
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      'release',
      'create',
      'v9.9.9',
      zip,
      `${zip}.sha256`,
      '--repo',
      'example/agentboard',
      '--title',
      'AgentBoard v9.9.9',
      '--draft',
      '--verify-tag',
      '--generate-notes',
    ]);
  });

  it('does not call GitHub when the remote tag resolves to different source', () => {
    const directory = releaseRepository();
    expect(packageRelease(directory, '--stamp').status).toBe(0);
    expect(packageRelease(directory).status).toBe(0);

    const { argsFile, result } = githubRelease(directory, '0'.repeat(40));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the reviewed local tag and HEAD');
    expect(existsSync(argsFile)).toBe(false);
  });

  it('does not call GitHub when a retagged HEAD still has the old artifact', () => {
    const directory = releaseRepository();
    expect(packageRelease(directory, '--stamp').status).toBe(0);
    expect(packageRelease(directory).status).toBe(0);
    writeFileSync(path.join(directory, 'source.txt'), 'retagged source\n');
    git(directory, ['add', 'source.txt']);
    git(directory, ['commit', '--quiet', '-m', 'Retagged source']);
    git(directory, ['tag', '-fa', 'v9.9.9', '-m', 'Retagged v9.9.9']);

    const { argsFile, result } = githubRelease(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('metadata does not match clean tagged HEAD');
    expect(existsSync(argsFile)).toBe(false);
  });

  it('does not call GitHub when the ZIP changed after checksum creation', () => {
    const directory = releaseRepository();
    expect(packageRelease(directory, '--stamp').status).toBe(0);
    expect(packageRelease(directory).status).toBe(0);
    appendFileSync(path.join(directory, 'release', 'agentboard-9.9.9.zip'), 'tampered');

    const { argsFile, result } = githubRelease(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match its SHA-256 sidecar');
    expect(existsSync(argsFile)).toBe(false);
  });
});
