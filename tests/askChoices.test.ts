import { describe, expect, it } from 'vitest';
import { isReadOnlyQuestion, proseAsk, toAsk } from '../src/main/prompts';

describe('toAsk', () => {
  it('reads multiSelect and follow-up questions', () => {
    const a = toAsk({ question: 'Pick', options: ['a', 'b'], multiSelect: true, questions: [{ question: 'Also?', options: ['x', 'y'] }, { nope: 1 }] });
    expect(a?.multi).toBe(true);
    expect(a?.more).toEqual([{ question: 'Also?', options: ['x', 'y'], allowText: false }]);
  });
  it('ignores multiSelect without several options', () => {
    expect(toAsk({ question: 'Q', options: ['only'], multiSelect: true })?.multi).toBeUndefined();
  });
});

describe('proseAsk', () => {
  it('turns a question followed by a list into buttons', () => {
    const a = proseAsk('Done with the audit.\n\nWhich direction should I take?\n1. Quick fix\n2. **Full refactor**\n3. Leave it');
    expect(a?.question).toBe('Which direction should I take?');
    expect(a?.options).toEqual(['Quick fix', 'Full refactor', 'Leave it']);
  });
  it('also takes a list that comes before the closing question', () => {
    expect(proseAsk('- Option A\n- Option B\n\nWhich do you prefer?')?.options).toEqual(['Option A', 'Option B']);
  });
  it('leaves plain questions and one-item lists alone', () => {
    expect(proseAsk('Should I continue?')).toBeUndefined();
    expect(proseAsk('Notes:\n- one thing\nShould I continue?')).toBeUndefined();
  });
});

describe('isReadOnlyQuestion', () => {
  it('accepts status questions and refuses edit requests', () => {
    expect(isReadOnlyQuestion('Look at Chronicle. Latest run. What is happening?')).toBe(true);
    expect(isReadOnlyQuestion('What does the router do?')).toBe(true);
    expect(isReadOnlyQuestion('Can you fix the router?')).toBe(false);
    expect(isReadOnlyQuestion('Build me a page')).toBe(false);
  });
});
