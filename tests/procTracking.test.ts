import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ child: undefined as (EventEmitter & { pid: number }) | undefined }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => state.child) }));

import { setSpawnObserver, spawnCli } from '../src/main/proc';

afterEach(() => setSpawnObserver(undefined));

describe('spawn tracking', () => {
  it('records the Harbor owner and carries the same spawn identity through exit callbacks', () => {
    state.child = Object.assign(new EventEmitter(), { pid: 123 });
    const spawned = vi.fn();
    const exited = vi.fn();
    setSpawnObserver({ spawned, exited });
    const before = Date.now();
    spawnCli('claude.exe', []);
    const entry = spawned.mock.calls[0][0];
    expect(entry.pid).toBe(123);
    expect(entry.name).toBe('claude');
    expect(entry.started).toBeGreaterThanOrEqual(before);
    expect(entry.owner.pid).toBe(process.pid);
    expect(entry.owner.started).toBeLessThanOrEqual(entry.started);
    state.child.emit('error', new Error('spawn error'));
    state.child.emit('close');
    expect(exited.mock.calls).toEqual([[123, entry.started], [123, entry.started]]);
  });
});
