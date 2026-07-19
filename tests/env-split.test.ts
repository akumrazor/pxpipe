/**
 * Unit contract for splitEnvByVolatility — the diff-based static/volatile
 * `# Environment` split (replaces blanket relocation of the whole section).
 *
 * The three invariants (also pinned end-to-end in cache-stability-e2e):
 *   1. First-ever sighting is volatile: no history → nothing promotes, so a
 *      fresh session/project never bakes git state into the slab image.
 *   2. The static side is frozen byte-exact per session: a promoted entry
 *      that churns mid-session must NOT change the slab bytes — its fresh
 *      text re-emits on the volatile tail instead, and the next session
 *      demotes it (sticky churn history).
 *   3. No project key → no learning: everything stays volatile.
 *
 * Run just this file:  pnpm vitest run tests/env-split.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetEnvSplitState, splitEnvByVolatility } from '../src/core/transform.js';

const BASE_ENV = [
  '# Environment',
  'You have been invoked in the following environment: ',
  ' - Primary working directory: /repo',
  ' - Is a git repository: true',
  ' - Additional working directories:',
  '  - /tmp',
  '  - /extra',
  ' - Platform: darwin',
  ' - OS Version: Darwin 25.5.0',
  ' - You are powered by the model named Fable 5. The exact model ID is claude-fable-5.',
].join('\n');

const envWithGit = (git: string) => `${BASE_ENV}\n - Git status: ${git}`;

beforeEach(() => resetEnvSplitState());

describe('splitEnvByVolatility', () => {
  it('first-ever sighting: everything volatile, nothing promoted to the slab', () => {
    const r = splitEnvByVolatility(envWithGit('clean'), 'proj', 's1');
    expect(r.staticEnv).toBe('');
    expect(r.volatileEnv).toContain('# Environment');
    expect(r.volatileEnv).toContain('Git status: clean');
    expect(r.volatileEnv).toContain('Platform: darwin');
    expect(r.volatileKeys).toContain('Git status');
    expect(r.volatileKeys).toContain('Platform');
  });

  it('no project key → no learning, whole section passes through volatile', () => {
    // Two stable sightings that WOULD promote under a project key…
    splitEnvByVolatility(BASE_ENV, undefined, 's1');
    const r = splitEnvByVolatility(BASE_ENV, undefined, 's2');
    expect(r.staticEnv).toBe('');
    expect(r.volatileEnv).toBe(BASE_ENV);
  });

  it('empty env is a no-op', () => {
    expect(splitEnvByVolatility('', 'proj', 's1')).toEqual({
      staticEnv: '',
      volatileEnv: '',
      volatileKeys: [],
    });
  });

  it('stable entries promote in the NEXT session; churned entries stay on the tail', () => {
    // Session 1: git state churns turn-to-turn, the rest is stable.
    splitEnvByVolatility(envWithGit('clean'), 'proj', 's1');
    splitEnvByVolatility(envWithGit('M src/a.ts'), 'proj', 's1');

    // Session 2: stable entries ride the slab; git stays volatile.
    const r = splitEnvByVolatility(envWithGit('M src/a.ts'), 'proj', 's2');
    expect(r.staticEnv).toContain('# Environment');
    expect(r.staticEnv).toContain('Platform: darwin');
    expect(r.staticEnv).toContain('Is a git repository: true');
    expect(r.staticEnv).not.toContain('Git status');
    expect(r.volatileEnv).toContain('# Environment'); // header rides both sides
    expect(r.volatileEnv).toContain('Git status: M src/a.ts');
    expect(r.volatileEnv).not.toContain('Platform');
    expect(r.volatileKeys).toEqual(['Git status']);
  });

  it('multi-line entries (nested working directories) travel as one unit', () => {
    splitEnvByVolatility(BASE_ENV, 'proj', 's1');
    const r = splitEnvByVolatility(BASE_ENV, 'proj', 's2');
    expect(r.staticEnv).toContain(' - Additional working directories:\n  - /tmp\n  - /extra');
    expect(r.volatileEnv).toBe(''); // fully stable env → nothing on the tail
  });

  it('identity/catalog lines promote like any stable entry (slab, not tail)', () => {
    splitEnvByVolatility(BASE_ENV, 'proj', 's1');
    const r = splitEnvByVolatility(BASE_ENV, 'proj', 's2');
    expect(r.staticEnv).toContain('You are powered by the model named Fable 5');
    expect(r.volatileEnv).not.toContain('You are powered by');
  });

  it('slab bytes stay frozen all session even when a promoted entry churns', () => {
    splitEnvByVolatility(BASE_ENV, 'proj', 's1');
    const t1 = splitEnvByVolatility(BASE_ENV, 'proj', 's2');
    expect(t1.staticEnv).not.toBe('');

    // Mid-session churn of a promoted entry (e.g. /model switch, OS update).
    const changed = BASE_ENV.replace('Platform: darwin', 'Platform: linux');
    const t2 = splitEnvByVolatility(changed, 'proj', 's2');
    expect(t2.staticEnv).toBe(t1.staticEnv); // invariant 2: never re-renders
    expect(t2.volatileEnv).toContain('Platform: linux'); // fresh copy supersedes
    // …and the stale slab copy is NOT duplicated on the tail.
    expect(t2.volatileEnv).not.toContain('Platform: darwin');

    // Sticky churn history: the next session demotes the entry.
    const s3 = splitEnvByVolatility(changed, 'proj', 's3');
    expect(s3.staticEnv).not.toContain('Platform');
    expect(s3.volatileEnv).toContain('Platform: linux');
  });

  it('an entry appearing mid-session rides the tail without touching the slab', () => {
    splitEnvByVolatility(BASE_ENV, 'proj', 's1');
    const t1 = splitEnvByVolatility(BASE_ENV, 'proj', 's2');
    const t2 = splitEnvByVolatility(`${BASE_ENV}\n - Shell: zsh`, 'proj', 's2');
    expect(t2.staticEnv).toBe(t1.staticEnv);
    expect(t2.volatileEnv).toContain('Shell: zsh');
  });

  it('bare `Key: value` format (no bullets) splits the same way', () => {
    const env = '# Environment\nWorking directory: /repo\nPlatform: darwin\nGit status:\nM src/a.ts';
    splitEnvByVolatility(env, 'proj', 's1');
    const r = splitEnvByVolatility(
      '# Environment\nWorking directory: /repo\nPlatform: darwin\nGit status:\nD src/b.ts',
      'proj',
      's2',
    );
    expect(r.staticEnv).toContain('Working directory: /repo');
    expect(r.staticEnv).not.toContain('Git status');
    expect(r.volatileEnv).toContain('D src/b.ts');
  });

  it('cross-project isolation: sightings under one project never promote another', () => {
    splitEnvByVolatility(BASE_ENV, 'projA', 's1');
    const r = splitEnvByVolatility(BASE_ENV, 'projB', 's2');
    expect(r.staticEnv).toBe('');
    expect(r.volatileEnv).toContain('Platform: darwin');
  });
});
