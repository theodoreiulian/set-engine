#!/usr/bin/env node
// The version the next release gets, printed as GITHUB_OUTPUT lines:
//
//   version=1.0.41
//   released=false
//
// Every merge to master is a release (.github/workflows/release.yml), so the
// number can't depend on someone remembering to edit package.json. MAJOR.MINOR
// come from package.json — bump those by hand when a release deserves it — and
// PATCH is the number of commits on the branch, which only ever goes up. It is
// also kept above every existing tag, so even a rewritten history can't produce
// a version that installed apps would consider old.
//
// A commit that is already tagged (the workflow was re-run) reports that tag's
// version with released=true, and the workflow publishes nothing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { nextVersion, parseVersion, compareVersions, formatVersion } from './release-lib.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

if (git('rev-parse', '--is-shallow-repository') === 'true') {
  console.error('This is a shallow clone, so the commit count is wrong. Check out with fetch-depth: 0.');
  process.exit(1);
}

const onHead = lines(git('tag', '--points-at', 'HEAD', '--list', 'v*'))
  .map(parseVersion).filter(Boolean).sort(compareVersions).pop();

if (onHead) {
  console.log(`version=${formatVersion(onHead)}`);
  console.log('released=true');
} else {
  const version = nextVersion({
    packageVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
    commitCount: Number(git('rev-list', '--count', 'HEAD')),
    tags: lines(git('tag', '--list', 'v*')),
  });
  console.log(`version=${version}`);
  console.log('released=false');
}
