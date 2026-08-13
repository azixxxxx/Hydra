import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function skill(name: string): Promise<string> {
  return readFile(join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
}

describe('packaged Hydra skills', () => {
  test('hydra-orchestrate routes bounded work and requires local verification', async () => {
    const content = await skill('hydra-orchestrate');
    expect(content).toMatch(/^---\nname: hydra-orchestrate\ndescription: Use when /u);
    expect(content).toContain('hydra_preflight');
    expect(content).toContain('hydra_route');
    expect(content).toContain('hydra_start');
    expect(content).toContain('hydra_status');
    expect(content).toContain('hydra_result');
    expect(content).toContain('maximum three Claude sessions');
    expect(content).toContain('maximum one Fable session');
    expect(content).toMatch(/Verify every accepted claim against local repository evidence/u);
    expect(content).toMatch(/Stop when/u);
  });

  test('hydra-review is read-only and emits only repository-verified structured findings', async () => {
    const content = await skill('hydra-review');
    expect(content).toMatch(/^---\nname: hydra-review\ndescription: Use when /u);
    expect(content).toContain('accessMode: "analyze"');
    expect(content).toContain('Sonnet');
    expect(content).toContain('Opus');
    for (const field of ['path', 'line', 'severity', 'claim', 'evidence', 'uncertainty']) {
      expect(content).toContain(field);
    }
    expect(content).toMatch(/Drop any finding that local evidence does not support/u);
    expect(content).not.toContain('accessMode: "execute"');
  });

  test('hydra-panel defines a real bounded independent and anonymized critique protocol', async () => {
    const content = await skill('hydra-panel');
    expect(content).toMatch(/^---\nname: hydra-panel\ndescription: Use when /u);
    expect(content).toContain('maximum three Claude sessions');
    expect(content).toContain('maximum one Fable session');
    expect(content).toContain('maximum two debate rounds');
    expect(content).toMatch(/Round 1.*independent/su);
    expect(content).toMatch(/Round 2.*anonym/su);
    expect(content).toContain('evidence');
    expect(content).toContain('uncertainty');
    expect(content).toContain('hydra_record_outcome');
    expect(content).not.toMatch(/advisor.*Fable/iu);
    expect(content).not.toContain('ultracode');
  });

  test.each(['hydra-orchestrate', 'hydra-review', 'hydra-panel'])(
    '%s builds one bounded evidence capsule with role deltas',
    async (name) => {
      const content = await skill(name);
      expect(content).toContain('## Context capsule');
      expect(content).toContain('32,768 UTF-8 bytes');
      expect(content).toContain('objective');
      expect(content).toContain('constraints');
      expect(content).toContain('Git root');
      expect(content).toContain('Git SHA');
      expect(content).toContain('evidence references');
      expect(content).toContain('open questions');
      expect(content).toContain('role-specific delta');
      expect(content).toMatch(/measure.*exact.*UTF-8 bytes/iu);
      expect(content).toMatch(/Do not (?:copy|replay) the (?:full )?(?:host )?(?:conversation|transcript)/iu);
    },
  );

  test('ships UI metadata for every skill and no production burn skill', async () => {
    const names = (await readdir(join(pluginRoot, 'skills'))).sort();
    expect(names).toEqual(['hydra-orchestrate', 'hydra-panel', 'hydra-review']);
    for (const name of names) {
      const metadata = await readFile(join(pluginRoot, 'skills', name, 'agents', 'openai.yaml'), 'utf8');
      expect(metadata).toContain(`$${name}`);
    }
  });
});

describe('Hydra README', () => {
  test('documents every acceptance-critical operational boundary', async () => {
    const content = await readFile(join(pluginRoot, 'README.md'), 'utf8');
    for (const heading of [
      '1.0 support boundary',
      'Quick start',
      'Paid-usage boundary',
      'Access modes',
      'Staged routing and context economics',
      'Allowance pacing',
      'Durable state',
      'Cancellation and recovery',
      'Troubleshooting',
    ]) {
      expect(content).toContain(`## ${heading}`);
    }
    expect(content).toContain('claude auth status');
    expect(content).toContain('claude install latest');
    expect(content).toContain('2.1.228');
    expect(content).toContain('Claude Settings > Usage');
    expect(content).toContain('usageCreditsState');
    expect(content).toContain('manualCheckRequired');
    expect(content).toContain('hydra@hydra-local');
    expect(content).toContain('~/.hydra');
    expect(content).toContain('0700');
    expect(content).toContain('0600');
    expect(content).toContain('nine STDIO MCP tools');
    expect(content).toContain('hydra_budget');
    expect(content).toContain('19 matching terminal usage observations');
    expect(content).toContain('Linux code paths exist but are unverified');
  });
});
