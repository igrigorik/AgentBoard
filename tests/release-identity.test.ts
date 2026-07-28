import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  for (const file of ['package-release.js', 'release-identity.js']) {
    cpSync(path.join(projectRoot, 'scripts', file), path.join(directory, 'scripts', file));
  }
  for (const file of ['LICENSE', 'README.md', 'PRIVACY.md']) {
    writeFileSync(path.join(directory, file), `${file} at reviewed commit\n`);
  }
  writeFileSync(path.join(directory, 'package.json'), '{"version":"9.9.9"}\n');
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
});
