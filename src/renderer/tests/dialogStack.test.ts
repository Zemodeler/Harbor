import { describe, expect, it } from 'vitest';
import { topDialog } from '../dialogStack';

describe('topDialog', () => {
  it('is undefined when nothing is open', () => expect(topDialog({})).toBeUndefined());
  it('lets what the user just asked for cover interruptions', () => {
    expect(topDialog({ welcome: true, ready: true })).toBe('welcome');
    expect(topDialog({ welcome: true, ready: true, panel: true })).toBe('panel');
    expect(topDialog({ welcome: true, palette: true })).toBe('palette');
    expect(topDialog({ palette: true, rename: true })).toBe('rename');
  });
  it('shows the next one again once the top one closes', () => {
    const open = { tags: true, menu: true, viewer: true };
    expect(topDialog(open)).toBe('tags');
    expect(topDialog({ ...open, tags: false })).toBe('menu');
  });
});
