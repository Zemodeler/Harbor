import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  appDocument, externalUrl, isAppDocumentUrl, isTrustedInvoke, navigationDecision, permissionAllowed, windowOpenDecision,
  type ContentsRef, type FrameRef
} from '../src/main/windowSecurity';

const outDir = resolve('C:/Program Files/Harbor/resources/app.asar/out');
const indexFile = join(outDir, 'renderer/index.html');
const fileDoc = appDocument(indexFile);
const indexUrl = pathToFileURL(indexFile).href;
const devDoc = appDocument(indexFile, 'http://localhost:5173/');

describe('app document', () => {
  it('accepts only loopback http(s) dev servers', () => {
    expect(devDoc).toEqual({ kind: 'dev', origin: 'http://localhost:5173', pathname: '/' });
    expect(appDocument(indexFile, 'http://127.0.0.1:5173')).toMatchObject({ kind: 'dev', origin: 'http://127.0.0.1:5173' });
    for (const bad of ['http://example.com:5173', 'file:///C:/x/index.html', 'http://user:pw@localhost:5173', 'http://localhost.evil.com/', 'not a url']) {
      expect(() => appDocument(indexFile, bad), bad).toThrow();
    }
  });
});

describe('isAppDocumentUrl (production file)', () => {
  it('accepts the bundled renderer, with query or hash, in any drive-letter case', () => {
    expect(isAppDocumentUrl(indexUrl, fileDoc)).toBe(true);
    expect(isAppDocumentUrl(`${indexUrl}?firstRun#x`, fileDoc)).toBe(true);
    expect(isAppDocumentUrl(indexUrl.replace('file:///C:', 'file:///c:'), fileDoc)).toBe(true);
  });

  it('rejects other local files, including traversal and encoded variants that resolve elsewhere', () => {
    const others = [
      pathToFileURL(join(outDir, 'renderer/other.html')).href,
      pathToFileURL(join(outDir, 'renderer/index.html.evil')).href,
      pathToFileURL('C:/Users/me/Downloads/index.html').href,
      `${pathToFileURL(join(outDir, 'renderer')).href}/../../../../evil/index.html`,
      `${pathToFileURL(join(outDir, 'renderer')).href}/%2e%2e/renderer2/index.html`,
      `${pathToFileURL(join(outDir, 'renderer')).href}%2Findex.html`,
      `${pathToFileURL(join(outDir, 'renderer')).href}%5Cindex.html`,
      `${indexUrl}%00.png`,
      indexUrl.replace('file:///', 'file://attacker/'),
      'file:///',
      'file://'
    ];
    for (const url of others) expect(isAppDocumentUrl(url, fileDoc), url).toBe(false);
  });

  it('accepts a dot-segment URL only when it resolves back to the same document', () => {
    expect(isAppDocumentUrl(`${pathToFileURL(join(outDir, 'renderer')).href}/../renderer/index.html`, fileDoc)).toBe(true);
    expect(isAppDocumentUrl(`${pathToFileURL(join(outDir, 'renderer')).href}/%2e%2e/renderer/index.html`, fileDoc)).toBe(true);
  });

  it('rejects remote, dev, and scriptable URLs in production', () => {
    for (const url of ['https://example.com/', 'http://localhost:5173/', 'javascript:alert(1)', 'data:text/html,<p>x</p>', 'about:blank', 'devtools://devtools/x', '']) {
      expect(isAppDocumentUrl(url, fileDoc), url).toBe(false);
    }
  });
});

describe('isAppDocumentUrl (dev server)', () => {
  it('accepts the dev root and its index.html', () => {
    expect(isAppDocumentUrl('http://localhost:5173/', devDoc)).toBe(true);
    expect(isAppDocumentUrl('http://localhost:5173/index.html?x#y', devDoc)).toBe(true);
  });

  it('rejects other origins, ports, schemes, paths and the production file', () => {
    for (const url of [
      'http://localhost:5174/', 'https://localhost:5173/', 'http://127.0.0.1:5173/', 'http://localhost.evil.com:5173/',
      'http://localhost:5173/evil.html', 'http://localhost:5173/x/../evil.html', 'http://localhost:5173/%2e%2e/evil',
      'http://user@localhost:5173/', indexUrl
    ]) expect(isAppDocumentUrl(url, devDoc), url).toBe(false);
  });

  it('honours a non-root dev path exactly', () => {
    const doc = appDocument(indexFile, 'http://localhost:5173/app/');
    expect(isAppDocumentUrl('http://localhost:5173/app/', doc)).toBe(true);
    expect(isAppDocumentUrl('http://localhost:5173/app/index.html', doc)).toBe(true);
    expect(isAppDocumentUrl('http://localhost:5173/', doc)).toBe(false);
    expect(isAppDocumentUrl('http://localhost:5173/apps/', doc)).toBe(false);
  });
});

describe('external links', () => {
  it('passes only http(s) links with a host and no credentials', () => {
    expect(externalUrl('https://example.com/a?b#c', fileDoc)).toBe('https://example.com/a?b#c');
    expect(externalUrl('http://example.com', fileDoc)).toBe('http://example.com/');
    for (const url of [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'file:///C:/Windows/System32/calc.exe', indexUrl,
      'ms-settings:', 'vbscript:x', 'smb://host/share', 'https://user:pw@example.com/', 'mailto:a@b.c', 'about:blank', 'not a url'
    ]) expect(externalUrl(url, fileDoc), url).toBeUndefined();
  });

  it('never sends the dev server itself to the browser', () => {
    expect(externalUrl('http://localhost:5173/other', devDoc)).toBeUndefined();
    expect(externalUrl('https://example.com/', devDoc)).toBe('https://example.com/');
  });

  it('denies every new window, opening only web links externally', () => {
    expect(windowOpenDecision('https://example.com/', fileDoc)).toEqual({ action: 'deny', openExternal: 'https://example.com/' });
    expect(windowOpenDecision(indexUrl, fileDoc)).toEqual({ action: 'deny' });
    expect(windowOpenDecision('javascript:alert(1)', fileDoc)).toEqual({ action: 'deny' });
    expect(windowOpenDecision('file:///C:/Windows/System32/calc.exe', fileDoc)).toEqual({ action: 'deny' });
  });
});

describe('navigation', () => {
  it('allows reloading the app document (production load and dev reload)', () => {
    expect(navigationDecision(indexUrl, true, fileDoc)).toEqual({ action: 'allow' });
    expect(navigationDecision('http://localhost:5173/', true, devDoc)).toEqual({ action: 'allow' });
  });

  it('keeps the window on Harbor and sends main-frame web links to the browser', () => {
    expect(navigationDecision('https://example.com/', true, fileDoc)).toEqual({ action: 'deny', openExternal: 'https://example.com/' });
    expect(navigationDecision('file:///C:/Users/me/evil.html', true, fileDoc)).toEqual({ action: 'deny' });
    expect(navigationDecision('data:text/html,x', true, fileDoc)).toEqual({ action: 'deny' });
    expect(navigationDecision('http://localhost:5173/evil.html', true, devDoc)).toEqual({ action: 'deny' });
  });

  it('never opens anything for subframe navigations', () => {
    expect(navigationDecision('https://example.com/', false, fileDoc)).toEqual({ action: 'deny' });
  });
});

describe('permissions', () => {
  it('grants only clipboard writes to the app main frame', () => {
    expect(permissionAllowed('clipboard-sanitized-write', indexUrl, true, fileDoc)).toBe(true);
    expect(permissionAllowed('clipboard-sanitized-write', indexUrl, false, fileDoc)).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', 'https://example.com/', true, fileDoc)).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', undefined, true, fileDoc)).toBe(false);
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'hid', 'serial', 'usb', 'fileSystem', 'display-capture', 'unknown']) {
      expect(permissionAllowed(p, indexUrl, true, fileDoc), p).toBe(false);
    }
  });
});

describe('isTrustedInvoke', () => {
  const frame = (over: Partial<FrameRef> = {}): FrameRef => ({ url: indexUrl, parent: null, processId: 4, routingId: 1, ...over });
  const contents = (id: number, mainFrame: FrameRef, destroyed = false): ContentsRef => ({ id, mainFrame, isDestroyed: () => destroyed });
  const main = frame();
  const win = contents(1, main);

  it('trusts the main frame of the current window on the app document', () => {
    expect(isTrustedInvoke({ sender: win, senderFrame: main }, win, fileDoc)).toBe(true);
  });

  it('rejects other windows, subframes, lost frames and destroyed or missing windows', () => {
    const other = contents(2, frame({ processId: 9 }));
    expect(isTrustedInvoke({ sender: other, senderFrame: other.mainFrame }, win, fileDoc)).toBe(false);
    // Same id is not enough: it must be the very WebContents Harbor created.
    expect(isTrustedInvoke({ sender: contents(1, main), senderFrame: main }, win, fileDoc)).toBe(false);
    expect(isTrustedInvoke({ sender: win, senderFrame: frame({ parent: main, routingId: 2 }) }, win, fileDoc)).toBe(false);
    expect(isTrustedInvoke({ sender: win, senderFrame: frame({ routingId: 7 }) }, win, fileDoc)).toBe(false);
    expect(isTrustedInvoke({ sender: win, senderFrame: null }, win, fileDoc)).toBe(false);
    expect(isTrustedInvoke({ sender: win, senderFrame: main }, undefined, fileDoc)).toBe(false);
    const dead = contents(1, main, true);
    expect(isTrustedInvoke({ sender: dead, senderFrame: main }, dead, fileDoc)).toBe(false);
  });

  it('rejects the right frame once it shows another document', () => {
    for (const url of ['https://example.com/', pathToFileURL('C:/Users/me/evil.html').href, 'about:blank', 'http://localhost:5173/']) {
      const navigated = frame({ url });
      const w = contents(1, navigated);
      expect(isTrustedInvoke({ sender: w, senderFrame: navigated }, w, fileDoc), url).toBe(false);
    }
  });
});
