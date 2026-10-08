import { describe, expect, it } from 'vitest';
import { INVOKE_METHODS } from '../src/shared/ipc';
import { createStubService } from '../src/main/service';

describe('contract', () => {
  it('service implements every IPC method', () => {
    const s = createStubService() as unknown as Record<string, unknown>;
    for (const m of INVOKE_METHODS) expect(typeof s[m]).toBe('function');
  });
});
