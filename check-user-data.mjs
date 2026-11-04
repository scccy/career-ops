#!/usr/bin/env node
/**
 * check-user-data.mjs — tracked-tree guard against user-layer (private) files.
 *
 * WHY THIS EXISTS
 * `.gitignore` protects nothing that is already tracked. An ignore rule added
 * after a file was committed changes nothing for that file, and `git add -f`
 * bypasses the rules entirely. That exact hole leaked a personal résumé
 * (`output/施辞-数据开发.pdf`, phone + email + full work history) into a public
 * repository: the file was carried by the root commit from a time before
 * `output/*` was ignored, while `.github/workflows/no-user-data.yml` only
 * inspects pull-request diffs — so a direct push to `main` had no check at all.
 *
 * WHAT IT CHECKS
 * The files git currently TRACKS — the HEAD tree by default, or the index with
 * `--staged`, or every path ever added with `--history` — against the
 * user-layer paths in DATA_CONTRACT.md. Scaffolding that legitimately lives
 * under those directories (`.gitkeep` keepers and directory `README.md`) is
 * exempt.
 *
 * USAGE
 *   node check-user-data.mjs             # audit the HEAD tree (default)
 *   node check-user-data.mjs --staged    # audit what is about to be committed
 *   node check-user-data.mjs --history   # audit every path ever added, any ref
 *   node check-user-data.mjs --summary   # human-readable report
 *   node check-user-data.mjs --quiet     # exit code only (pre-commit hook)
 *   node check-user-data.mjs --self-test
 *
 * Exit codes: 0 clean · 1 violations (or git unavailable) · 2 usage error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * User-layer paths, mirroring DATA_CONTRACT.md and USER_PATHS in
 * update-system.mjs. voice-dna.md is deliberately absent: it ships as a
 * populated system default, so edits to it are legitimate.
 */
export const USER_PATHS = [
  /^cv\.md$/,
  /^config\/profile\.yml$/,
  /^modes\/_profile\.md$/,
  /^modes\/_custom\.md$/,
  /^portals\.yml$/,
  /^article-digest\.md$/,
  /^interview-prep\//,
  /^data\//,
  /^reports\//,
  /^output\//,
  /^jds\//,
  /^documents\//,
  /^writing-samples\//,
];

/** Tracked scaffolding that legitimately lives under a user-layer path. */
export function isScaffold(file) {
  return /(^|\/)\.gitkeep$/.test(file) || /(^|\/)README\.md$/.test(file);
}

/** True when `file` is a user-layer path that is not exempt scaffolding. */
export function isUserData(file) {
  const f = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  return USER_PATHS.some((re) => re.test(f)) && !isScaffold(f);
}

/** Split a git-path listing into clean repo-relative paths. */
export function splitPaths(stdout) {
  return String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Split a `git log --name-only` listing: commit headers are already blank
 * (`--pretty=format:`), so only paths survive.
 */
export function splitHistory(stdout) {
  const seen = new Set();
  for (const p of splitPaths(stdout)) seen.add(p);
  return [...seen];
}

function git(args, cwd = ROOT) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    // Large trees (this repo tracks ~2k files) overflow the 1 MB default.
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Tracked files in HEAD. */
export function listHead(cwd = ROOT) {
  return splitPaths(git(['ls-tree', '-r', '--name-only', 'HEAD'], cwd));
}

/** Files staged for the next commit. */
export function listStaged(cwd = ROOT) {
  return splitPaths(
    git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], cwd),
  );
}

/**
 * Every file path ever added or modified on any ref. Uses the commit walk
 * (`--name-only`) rather than `rev-list --objects` on purpose: the latter also
 * emits tree objects, which print as directory names (`data/parser-output`)
 * and would be reported as violations.
 */
export function listHistory(cwd = ROOT) {
  return splitHistory(
    git(['log', '--all', '--pretty=format:', '--name-only', '--diff-filter=ACMR'], cwd),
  );
}

/** Filter a file list down to the violations. */
export function findViolations(files) {
  return files.filter(isUserData).sort();
}

function selfTest() {
  const checks = [];
  const t = (name, cond) => checks.push({ name, ok: Boolean(cond) });

  // Violations
  t('cv.md is user data', isUserData('cv.md'));
  t('a résumé PDF under output/ is user data', isUserData('output/施辞-数据开发.pdf'));
  t('output/cv-x.pdf is user data', isUserData('output/cv-2026-10-14.pdf'));
  t('story-bank is user data', isUserData('interview-prep/story-bank.md'));
  t('tracker is user data', isUserData('data/applications.md'));
  t('a report is user data', isUserData('reports/001-acme-2026-01-01.md'));
  t('an archived JD is user data', isUserData('jds/acme-data-engineer.md'));
  t('an intake document is user data', isUserData('documents/diploma.pdf'));
  t('a portals config is user data', isUserData('portals.yml'));
  t('windows separators are normalised', isUserData('output\\cv-x.pdf'));
  t('a ./-prefixed path is normalised', isUserData('./output/cv-x.pdf'));

  // Exemptions
  t('.gitkeep under output/ is scaffolding', !isUserData('output/.gitkeep'));
  t('README under documents/ is scaffolding', !isUserData('documents/README.md'));
  t('session README is scaffolding', !isUserData('interview-prep/sessions/README.md'));

  // Not user data at all
  t('system script is fine', !isUserData('scan.mjs'));
  t('workflow is fine', !isUserData('.github/workflows/test.yml'));
  t('templates are fine', !isUserData('templates/cv-template.html'));

  // Parsing
  t(
    'splitHistory dedupes and keeps paths only',
    JSON.stringify(
      splitHistory('output/cv-x.pdf\ndata\nreports/001-a.md\noutput/cv-x.pdf\n'),
    ) === JSON.stringify(['output/cv-x.pdf', 'data', 'reports/001-a.md']),
  );
  t('findViolations sorts and filters', JSON.stringify(findViolations([
    'scan.mjs',
    'output/b.pdf',
    'output/.gitkeep',
    'output/a.pdf',
  ])) === JSON.stringify(['output/a.pdf', 'output/b.pdf']));

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name}`);
  if (failed.length) {
    console.error(`\ncheck-user-data self-test: ${failed.length}/${checks.length} failed`);
    process.exit(1);
  }
  console.log(`\ncheck-user-data self-test: all ${checks.length} assertions passed`);
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: node check-user-data.mjs [--staged|--history] [--summary] [--quiet] [--self-test]',
    );
    process.exit(0);
  }
  if (args.includes('--self-test')) return selfTest();

  const staged = args.includes('--staged');
  const history = args.includes('--history');
  const summary = args.includes('--summary');
  const quiet = args.includes('--quiet');
  const unknown = args.filter(
    (a) => !['--staged', '--history', '--summary', '--quiet', '--self-test'].includes(a),
  );
  if (unknown.length) {
    console.error(`check-user-data: unknown argument(s): ${unknown.join(' ')}`);
    process.exit(2);
  }

  let files;
  let scope;
  try {
    if (!existsSync(join(ROOT, '.git'))) throw new Error('not a git repository');
    if (history) {
      files = listHistory();
      scope = 'history';
    } else if (staged) {
      files = listStaged();
      scope = 'staged';
    } else {
      files = listHead();
      scope = 'HEAD';
    }
  } catch (e) {
    if (!quiet) console.error(`check-user-data: cannot read git state: ${e.message}`);
    process.exit(1);
  }

  const violations = findViolations(files);

  if (quiet) process.exit(violations.length ? 1 : 0);

  if (summary) {
    if (!violations.length) {
      console.log(`✅ no user-layer files are tracked (scope: ${scope}, ${files.length} paths)`);
    } else {
      console.log(
        `❌ ${violations.length} user-layer file(s) tracked (scope: ${scope}) — these live only on your machine per DATA_CONTRACT.md:\n`,
      );
      for (const v of violations) console.log(`  ${v}`);
      console.log(
        '\nRemove with: git rm --cached -- <path>   (the file stays on disk)' +
          '\nIf it is already in history, it must be purged from history too —' +
          ' deleting it now does not remove it from earlier commits.',
      );
    }
    process.exit(violations.length ? 1 : 0);
  }

  console.log(
    JSON.stringify(
      { scope, scanned: files.length, violations, clean: violations.length === 0 },
      null,
      2,
    ),
  );
  process.exit(violations.length ? 1 : 0);
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
