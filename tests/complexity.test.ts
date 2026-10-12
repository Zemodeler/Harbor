import { describe, expect, it } from 'vitest';
import { combineComplexity, estimateComplexity, pathsIn } from '../src/main/complexity';

const est = (text: string, extra: object = {}) => estimateComplexity({ text, ...extra });

describe('estimateComplexity: realistic prompts', () => {
  const low = [
    'Explain how the router picks a model',
    'What does the usage ledger do?',
    'where is the retry logic for failed helpers?',
    'Fix the typo in README.md',
    'rename the variable foo to bar in src/utils.ts',
    'run prettier on the settings panel',
    'status',
    'add a docstring to parseConcierge',
    'show me the list of IPC methods',
    'Why does the build print a warning about chunk size?',
    'bump the version in package.json'
  ];
  const medium = [
    'Fix the failing login test in src/auth.test.ts',
    'Add a dark mode toggle to the settings page',
    'The export button does nothing when the project has no commits, can you look into it?',
    'Write a unit test for the headroom curve',
    'Update the sidebar so archived conversations are hidden by default',
    'Make the login handler reject empty passwords',
    'Explain the concurrency model in the scheduler'
  ];
  const high = [
    'Refactor the orchestrator into smaller modules without changing behavior',
    'Rewrite the storage layer to use SQLite',
    'Migrate the whole app from Webpack to Vite',
    'Find the root cause of the flaky logout test and fix it',
    'There is a race condition between the lead turn and the helper scheduler, track it down',
    'Add retry with backoff across the codebase wherever we call the network',
    'Design a plugin system for adapters, then implement the feature end-to-end',
    'Review the security of the permission prompts and fix anything exploitable',
    'Rework src/main/router.ts, src/main/usage.ts, src/main/orchestrator.ts and src/main/store.ts so usage is tracked per window'
  ];
  it.each(low)('low: %s', (t) => expect(est(t).complexity).toBe('low'));
  it.each(medium)('medium: %s', (t) => expect(est(t).complexity).toBe('medium'));
  it.each(high)('high: %s', (t) => expect(est(t).complexity).toBe('high'));
});

describe('estimateComplexity: transparency and structure', () => {
  it('returns the signals that decided it', () => {
    const e = est('Refactor the session handling across the codebase');
    expect(e.complexity).toBe('high');
    expect(e.signals).toEqual(expect.arrayContaining(['+2 refactor', '+2 across the codebase']));
    expect(est('fix the typo in docs/guide.md').signals).toEqual(['low: typo or formatting']);
    expect(est('make the button blue').signals).toEqual(['no strong signal']);
  });
  it('a long multi-paragraph spec is high even without a hard word', () => {
    const spec = Array.from({ length: 4 }, (_, i) => `Paragraph ${i + 1}: the settings page needs a new section with several fields, validation messages, a reset button and persistence between runs.`).join('\n\n');
    const e = est(spec + '\n\n' + 'x'.repeat(400));
    expect(e.complexity).toBe('high');
    expect(e.signals.join(' ')).toMatch(/long spec/);
  });
  it('many file paths push it up; one or two do not', () => {
    expect(pathsIn('see src/a.ts, src/b.ts, lib\\c.js and d.py')).toHaveLength(4);
    expect(est('change the label in src/a.ts, src/b.ts, src/c.ts and src/d.ts').complexity).toBe('high');
    expect(est('change the label in src/a.ts and src/b.ts').complexity).toBe('medium');
  });
  it('plan and goal modes are high; default and auto leave the wording alone', () => {
    expect(est('tidy the header', { mode: 'plan' }).complexity).toBe('high');
    expect(est('tidy the header', { mode: 'goal' }).complexity).toBe('high');
    expect(est('tidy the header', { mode: 'auto' }).complexity).toBe('medium');
  });
  it('asking about a hard topic is not hard work, but two hard signals still are', () => {
    expect(est('explain the race condition handling').complexity).toBe('medium');
    expect(est('explain the race condition handling and the flaky tests, then fix them all across the repo').complexity).toBe('high');
  });
  it('a large project makes one hard word count for more; attachments alone do not', () => {
    expect(est('make the app faster').complexity).toBe('medium');
    expect(est('make the app faster', { projectFileCount: 4000 }).complexity).toBe('high');
    expect(est('what is in this screenshot', { attachments: 4 }).complexity).toBe('medium');
  });
});

describe('combineComplexity: the orchestrator rule', () => {
  it('without a concierge the estimate stands, and the note carries the signals', () => {
    const c = combineComplexity(est('rename foo to bar in src/x.ts'), undefined);
    expect(c.complexity).toBe('low');
    expect(c.note).toMatch(/complexity low estimated from the request \(low: small mechanical edit/);
  });
  it('a concierge rating is only ever raised to high, never lowered', () => {
    const hard = est('refactor the whole module and migrate its data');
    const easy = est('fix the typo in README.md');
    expect(combineComplexity(hard, 'low').complexity).toBe('high');
    expect(combineComplexity(hard, 'medium').complexity).toBe('high');
    expect(combineComplexity(hard, 'low').note).toMatch(/raised low → high/);
    expect(combineComplexity(easy, 'high').complexity).toBe('high');
    expect(combineComplexity(easy, 'medium').complexity).toBe('medium');
    expect(combineComplexity(est('make the button blue'), 'low').complexity).toBe('low');
  });
});
