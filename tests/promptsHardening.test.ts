import { describe, expect, it } from 'vitest';
import { isApproval, needsWorkspace } from '../src/main/prompts';

describe('isApproval', () => {
  it('needs a go-ahead word, no question mark and at most a short modifier', () => {
    for (const t of ['yes', 'Yes, build the panel', 'go ahead', 'ok, do it', 'continue', 'lgtm', 'yes please do', 'proceed with that']) expect(isApproval(t), t).toBe(true);
    for (const t of ['yes?', 'ok, do it?', 'continue with the second option, or should I wait?', 'go ahead and refactor the whole storage layer to use sqlite',
      'yes thanks!', 'start with the auth module and then move to the billing code and tests']) expect(isApproval(t), t).toBe(false);
  });
});

describe('needsWorkspace', () => {
  it('is not switched off by a polite opener in front of a request', () => {
    for (const t of ['ok fix the bug', 'thanks, now fix the parser', 'great, build it', 'hi! can you debug the login flow', 'Okay, thanks. Refactor the router.']) expect(needsWorkspace(t), t).toBe(true);
  });
  it('still leaves small talk and status questions to the front desk', () => {
    for (const t of ['thanks', 'ok', 'hi there', 'great, thanks a lot', 'status', 'how is it going', 'is the build done?']) expect(needsWorkspace(t), t).toBe(false);
  });
  it('catches files, stack traces and code fences however the message starts', () => {
    expect(needsWorkspace('thanks, what does src/main/store.ts do')).toBe(true);
    expect(needsWorkspace('hello\n```\nconst x = 1\n```')).toBe(true);
  });
});
