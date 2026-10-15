import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { createMockApi } from '../mock/mockApi';
import type { CliStatus, Conversation, HarborEvent } from '../../shared/api';
import { entryScore, highlight, matchScore, parseQuery, pushRecent, rankEntries, type PaletteEntry } from '../palette';
import { appearanceModes, contrastTokens, parseAppearance, resolveTheme, themeTokens } from '../appearance';
import { normalizeTag, parseMeta, parseTags, tagCounts } from '../conversationMeta';
import { applySlash, builtinCommands, fillTemplate, matchSlash, slashCommands, slashQuery, slug } from '../slashCommands';
import { classifyFile, notebookToText, quoteTextFile, textFileProblem } from '../attachments';
import { activityToast, addToast, MAX_TOASTS, questionToast } from '../toasts';
import { cliReadiness, onboardingKey, readinessSummary, shouldOfferOnboarding } from '../onboarding';
import { resetNotificationPrefs } from '../notificationPrefs';

beforeEach(() => { localStorage.clear(); resetNotificationPrefs(); window.harbor = createMockApi({ delay: 0 }); });
async function ready() { render(<App/>); await screen.findByRole('heading', { name: 'Build the account page' }); await screen.findByText(/I've assigned/); }
const entry = (id: string, title: string, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({ id, kind: 'action', title, ...extra });

describe('Palette ranking', () => {
  it('orders exact, prefix, word start, substring and letters-in-order matches', () => {
    const exact = matchScore('git', 'Git')!, prefix = matchScore('git', 'Git branches')!, word = matchScore('branch', 'Git branches')!, inside = matchScore('anch', 'Git branches')!, letters = matchScore('nc', 'New conversation')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(letters);
    expect(letters).toBeGreaterThan(0);
    expect(matchScore('zz', 'New conversation')).toBeNull();
    expect(matchScore('', 'anything')).toBe(0);
    expect(matchScore('cafe', 'Café menu')).not.toBeNull(); // accents fold
    expect(matchScore('open settings', 'Settings: open the panel')).not.toBeNull(); // every word somewhere
  });
  it('ranks titles over keywords over details, boosts recent entries and sinks disabled ones', () => {
    const entries = [entry('a', 'Open Settings'), entry('b', 'Review changes', { keywords: ['settings diff'] }), entry('c', 'Archive', { detail: 'settings' }), entry('d', 'Settings sync', { disabled: true })];
    expect(rankEntries(entries, 'settings').map(e => e.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(rankEntries(entries, 'settings', { recent: ['b'] })[0].id).toBe('a'); // a small boost does not beat a much better match
    expect(rankEntries([entry('x', 'Open terminal'), entry('y', 'Open editor')], 'open', { recent: ['y'] }).map(e => e.id)).toEqual(['y', 'x']);
    expect(rankEntries(entries, 'zzz')).toEqual([]);
    expect(rankEntries(entries, '', { limit: 2 })).toHaveLength(2);
    expect(entryScore(entry('k', 'Theme', { keywords: ['appearance'] }), 'appear')).toBeGreaterThan(0);
  });
  it('parses scope prefixes, keeps a bounded recent list and splits highlights', () => {
    expect(parseQuery('> theme')).toEqual({ scope: 'actions', text: 'theme' });
    expect(parseQuery('@store')).toEqual({ scope: 'projects', text: 'store' });
    expect(parseQuery('#bug')).toEqual({ scope: 'tag', text: 'bug' });
    expect(parseQuery('  plain ')).toEqual({ scope: 'all', text: 'plain' });
    expect(pushRecent(['a', 'b', 'c'], 'b', 3)).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
    expect(highlight('Fix the Fix', 'fix')).toEqual([{ text: 'Fix', match: true }, { text: ' the ', match: false }, { text: 'Fix', match: true }]);
    expect(highlight('abc', '')).toEqual([{ text: 'abc', match: false }]);
  });
});

describe('Theme resolution', () => {
  it('follows the system by default and honours an explicit mode', () => {
    expect(parseAppearance(null).mode).toBe('system');
    expect(resolveTheme('system', { dark: true, moreContrast: false })).toEqual({ scheme: 'dark', contrast: false });
    expect(resolveTheme('system', { dark: false, moreContrast: true })).toEqual({ scheme: 'light', contrast: true });
    expect(resolveTheme('contrast', { dark: true, moreContrast: false })).toEqual({ scheme: 'dark', contrast: true });
    expect(resolveTheme('light', { dark: true, moreContrast: true })).toEqual({ scheme: 'light', contrast: false });
    expect(parseAppearance('{"palette":"ocean","mode":"contrast"}').mode).toBe('contrast');
    expect(parseAppearance('{"palette":"unknown","mode":"light","layout":"focus"}')).toEqual({ palette: 'command', mode: 'light', layout: 'focus' });
    expect(appearanceModes).toContain('contrast');
    expect(themeTokens('ocean', { scheme: 'dark', contrast: true })).toEqual(contrastTokens('dark'));
  });
  it('keeps high-contrast text at AAA and controls at AA', () => {
    const lum = (hex: string) => { const [r, g, b] = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return r * .2126 + g * .7152 + b * .0722; };
    const ratio = (a: string, b: string) => { const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y); return (hi + .05) / (lo + .05); };
    for (const scheme of ['light', 'dark'] as const) {
      const t = contrastTokens(scheme);
      for (const surface of ['bg', 'sidebar', 'surface', 'wash']) for (const text of ['ink', 'muted']) expect(ratio(t[`--${surface}`], t[`--${text}`]), `${scheme} ${text} on ${surface}`).toBeGreaterThanOrEqual(7);
      expect(ratio(t['--accent'], t['--on-accent'])).toBeGreaterThanOrEqual(7);
      expect(ratio(t['--accent'], t['--bg'])).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['--rail'], t['--rail-ink'])).toBeGreaterThanOrEqual(7);
      expect(ratio(t['--error'], t['--bg'])).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('Tags, slash commands, attachments, toasts and onboarding (pure)', () => {
  it('normalizes and counts tags', () => {
    expect(normalizeTag('  #Bug Fix! ')).toBe('bug-fix');
    expect(parseTags('#bug, ui  bug release,,')).toEqual(['bug', 'ui', 'release']);
    expect(parseTags('a b c d e f g h i j')).toHaveLength(8);
    expect(parseMeta('{"tags":{"x":["UI","ui",3],"y":[]},"recent":["cmd:git",1]}')).toEqual({ tags: { x: ['ui'] }, recent: ['cmd:git'] });
    expect(parseMeta('not json')).toEqual({ tags: {}, recent: [] });
    expect(tagCounts({ a: ['ui', 'bug'], b: ['ui'], c: ['zeta'] }, ['a', 'b'])).toEqual([{ tag: 'ui', count: 2 }, { tag: 'bug', count: 1 }]);
  });
  it('detects, matches and applies slash commands', () => {
    expect(slashQuery('/de')).toBe('de');
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/deep fix it')).toBeNull();
    expect(slashQuery('hello /deep')).toBeNull();
    const cmds = slashCommands([{ id: '1', title: 'Review', text: 'Mine' }, { id: '2', title: 'Release notes', text: 'Notes for {{project}} on {{date}}' }]);
    expect(cmds.map(c => c.name)).toContain('review-2'); // clashes with the built-in /review
    expect(matchSlash(cmds, 'rel')[0].name).toBe('release-notes');
    expect(matchSlash(cmds, '')).toHaveLength(cmds.length);
    expect(applySlash('/de', builtinCommands[0], {})).toBe('/deep ');
    expect(applySlash('/release-notes', cmds.find(c => c.name === 'release-notes')!, { project: 'Store', now: new Date(2026, 0, 2) })).toBe(`Notes for Store on ${new Date(2026, 0, 2).toLocaleDateString()}`);
    expect(fillTemplate('{{conversation}} {{unknown}}', {})).toBe('this conversation {{unknown}}');
    expect(slug('Ünïcode Title!')).toBe('unicode-title');
  });
  it('classifies files and refuses PDFs, credentials and oversized text', () => {
    expect(classifyFile({ name: 'shot.png', type: 'image/png' })).toBe('image');
    expect(classifyFile({ name: 'build.log', type: '' })).toBe('text');
    expect(classifyFile({ name: 'spec.pdf', type: '' })).toBe('pdf');
    expect(classifyFile({ name: '.env.local', type: 'text/plain' })).toBe('credential');
    expect(classifyFile({ name: 'server.pem', type: '' })).toBe('credential');
    expect(classifyFile({ name: 'archive.zip', type: 'application/zip' })).toBe('unsupported');
    expect(textFileProblem({ name: 'spec.pdf', type: 'application/pdf', size: 10 })).toMatch(/PDFs cannot be attached yet/);
    expect(textFileProblem({ name: 'big.log', type: '', size: 300 * 1024 })).toMatch(/larger than/);
    expect(textFileProblem({ name: 'a.log', type: '', size: 150 * 1024 }, 300 * 1024)).toMatch(/add up to/);
    expect(textFileProblem({ name: 'ok.ts', type: '', size: 10 })).toBe('');
    expect(quoteTextFile('a.md', 'x ```js\ny```')).toContain('````\nx ```js');
  });
  it('raises toasts only for changes seen here and keeps one per conversation', () => {
    const c: Conversation = { id: 'c', projectId: 'p', title: 'Task', updated: 1, agentId: 'a', activity: { state: 'done', updated: 1 } };
    expect(activityToast(undefined, c, 'Proj')).toBeNull();
    expect(activityToast('done', c, 'Proj')).toBeNull();
    expect(activityToast('working', c, 'Proj')).toMatchObject({ kind: 'finished', body: 'Proj · Task', conversationId: 'c' });
    expect(activityToast('stopped', c, 'Proj')).toBeNull();
    expect(activityToast('working', { ...c, activity: { state: 'failed', updated: 2, detail: 'CLI crashed' } }, '')).toMatchObject({ kind: 'failed', body: 'Task: CLI crashed' });
    const q = questionToast({ requestId: 'r', conversationId: 'c', prompt: 'Which?' }, 'Task', 5);
    let list = addToast([], q);
    list = addToast(list, questionToast({ requestId: 'r2', conversationId: 'c', prompt: 'Now?' }, 'Task', 6));
    expect(list.map(t => t.id)).toEqual(['question:r2']);
    for (let i = 0; i < 6; i++) list = addToast(list, { ...q, id: `x${i}`, conversationId: `c${i}` });
    expect(list).toHaveLength(MAX_TOASTS);
  });
  it('reads CLI readiness like Settings and only offers the guide on a real first run', () => {
    const cli = (p: Partial<CliStatus>): CliStatus => ({ id: 'claude', name: 'Claude Code', installed: true, signedIn: true, models: [], ...p });
    expect(cliReadiness(cli({}))).toBe('ready');
    expect(cliReadiness(cli({ signedIn: false, authState: 'signedOut' }))).toBe('signedOut');
    expect(cliReadiness(cli({ signedIn: false, authState: 'unknown' }))).toBe('unknown');
    expect(cliReadiness(cli({ installed: false }))).toBe('missing');
    expect(cliReadiness(cli({}), { routing: 'auto', allowFreeReset: 'ask', cliOverrides: { claude: { enabled: false } } })).toBe('disabled');
    expect(readinessSummary([cli({})]).ready).toBe(1);
    expect(readinessSummary([]).text).toMatch(/no supported CLI/);
    expect(shouldOfferOnboarding({ loading: false, startupError: '', projects: 0, done: false })).toBe(true);
    expect(shouldOfferOnboarding({ loading: false, startupError: 'down', projects: 0, done: false })).toBe(false);
    expect(shouldOfferOnboarding({ loading: false, startupError: '', projects: 1, done: false })).toBe(false);
    expect(shouldOfferOnboarding({ loading: false, startupError: '', projects: 0, done: true })).toBe(false);
  });
});

describe('Navigation flows', () => {
  it('runs a command from the palette by keyboard and remembers it', async () => {
    await ready();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('combobox', { name: 'Search commands, projects and conversations' });
    await userEvent.type(input, '>high contrast');
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Theme: High contrast');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);
    await userEvent.keyboard('{Enter}');
    expect(document.documentElement.dataset.contrast).toBe('more');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Theme: High contrast'); // recently used comes first
    await userEvent.type(screen.getByRole('combobox'), '>light{Enter}');
    expect(document.documentElement.dataset.contrast).toBeUndefined();
  });
  it('finds a conversation by message text with an excerpt', async () => {
    await ready();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await userEvent.type(screen.getByRole('combobox'), 'manage their addresses');
    await waitFor(() => expect(screen.getByRole('option', { name: /Build the account page/ })).toHaveTextContent(/customers can update their profile/));
    expect(within(screen.getByRole('option', { name: /Build the account page/ })).getByText('manage their addresses').tagName).toBe('MARK');
  });
  it('tags a conversation, filters the list by tag and finds it with #', async () => {
    await ready();
    await userEvent.click(screen.getByLabelText('Options for Polish the checkout'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit tags', hidden: true }).find(b => b.closest('details')?.open)!);
    const dialog = await screen.findByRole('dialog', { name: 'Edit tags' });
    await userEvent.type(within(dialog).getByLabelText(/Tags, separated/), 'Release, ui');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save tags' }));
    const nav = within(screen.getByRole('navigation', { name: 'Projects and conversations' }));
    await userEvent.click(nav.getByRole('button', { name: '#release' }));
    expect(nav.getByRole('button', { name: '#release' })).toHaveAttribute('aria-pressed', 'true');
    expect(nav.queryByRole('button', { name: /^Build the account page/ })).not.toBeInTheDocument();
    expect(nav.getByRole('button', { name: /^Polish the checkout/ })).toHaveTextContent('#release');
    expect(JSON.parse(localStorage.getItem('harbor.conversationMeta.v1')!).tags.checkout).toEqual(['release', 'ui']);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await userEvent.type(screen.getByRole('combobox'), '#rel');
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual([expect.stringMatching(/Polish the checkout/)]);
  });
  it('moves between conversations with the arrow keys', async () => {
    await ready();
    const nav = within(screen.getByRole('navigation', { name: 'Projects and conversations' }));
    const first = nav.getByRole('button', { name: /^Build the account page/ });
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(nav.getByRole('button', { name: /^Polish the checkout/ }));
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(nav.getByRole('button', { name: /^Explore product search/ }));
  });
  it('archives into a section that can be shown and restored from the list', async () => {
    await ready();
    await window.harbor.updateConversation('search', { archived: true });
    const nav = within(screen.getByRole('navigation', { name: 'Projects and conversations' }));
    await waitFor(() => expect(nav.queryByRole('button', { name: /^Explore product search/ })).not.toBeInTheDocument());
    await userEvent.click(nav.getByRole('button', { name: 'Show archived (1)' }));
    expect(nav.getByText('Archived')).toBeInTheDocument();
    await userEvent.click(nav.getByLabelText('Options for Explore product search'));
    await userEvent.click(nav.getAllByRole('button', { name: 'Restore', hidden: true }).find(b => b.closest('details')?.open)!);
    await waitFor(() => expect(nav.queryByRole('button', { name: /Show archived|Hide archived/ })).not.toBeInTheDocument());
  });
  it('completes /deep and saved prompts from the slash menu', async () => {
    localStorage.setItem('harbor.workspace.v1', JSON.stringify({ templates: [{ id: 't1', title: 'Release notes', text: 'Write release notes for {{project}}' }] }));
    await ready();
    const box = screen.getByLabelText('Message Harbor');
    await userEvent.type(box, '/de');
    const menu = screen.getByRole('listbox', { name: 'Slash commands' });
    expect(within(menu).getAllByRole('option')[0]).toHaveTextContent('/deep');
    await userEvent.keyboard('{Enter}');
    expect(box).toHaveValue('/deep ');
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, '/release{Tab}');
    expect(box).toHaveValue('Write release notes for Storefront');
    await userEvent.clear(box);
    await userEvent.type(box, '/rev{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument();
    expect(box).toHaveValue('/rev');
  });
  it('attaches any file as a real attachment, chips included, and refuses credentials', async () => {
    await ready();
    const sent: { name: string; mime: string }[][] = [];
    window.harbor.send = async (_id: string, _t: string, a?: { name: string; mime: string }[]) => { sent.push(a ?? []); };
    const picker = screen.getByLabelText('Choose files');
    fireEvent.change(picker, { target: { files: [new File(['{"cells":[]}'], 'analysis.ipynb'), new File(['%PDF-1.7'], 'spec.pdf', { type: 'application/pdf' }), new File(['K=1'], '.env')] } });
    expect(await screen.findByText('analysis.ipynb')).toBeInTheDocument();
    expect(screen.getByText('spec.pdf')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('credential');
    await userEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.map(a => a.name)).toEqual(['analysis.ipynb', 'spec.pdf']);
    expect(sent[0]![1]!.mime).toBe('application/pdf');
  });
  it('takes files dropped anywhere in the window', async () => {
    await ready();
    const file = new File(['x=1'], 'notes.py');
    fireEvent.drop(document.body, { dataTransfer: { files: [file], types: ['Files'] } });
    expect(await screen.findByText('notes.py')).toBeInTheDocument();
  });
  it('shows a finished toast for another conversation and opens it', async () => {
    const api = window.harbor, listeners: Array<(e: HarborEvent) => void> = [], subscribe = api.onEvent;
    api.onEvent = cb => { listeners.push(cb); return subscribe(cb); };
    await ready();
    const task = (await api.listConversations('store')).find(c => c.id === 'checkout')!;
    const deliver = (e: HarborEvent) => act(() => listeners.forEach(cb => cb(e)));
    deliver({ type: 'conversation', conversation: { ...task, activity: { state: 'working', updated: Date.now() } } });
    expect(screen.queryByText('Finished')).not.toBeInTheDocument();
    deliver({ type: 'conversation', conversation: { ...task, activity: { state: 'done', updated: Date.now() } } });
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(within(region).getByText('Finished')).toBeInTheDocument();
    await userEvent.click(within(region).getByRole('button', { name: /^Open conversation: Storefront · Polish the checkout/ }));
    expect(await screen.findByRole('heading', { name: 'Polish the checkout', level: 1 })).toBeInTheDocument();
    expect(within(region).queryByText('Finished')).not.toBeInTheDocument();
  });
  it('guides a first run through connections, the first project and the modes without calling a model', async () => {
    window.harbor = createMockApi({ empty: true, delay: 0 });
    const sent: string[] = [];
    window.harbor.send = async (id: string) => { sent.push(id); };
    render(<App/>);
    expect(await screen.findByRole('dialog', { name: 'Welcome to Harbor' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    const connect = screen.getByRole('dialog', { name: 'Connect your tools' });
    expect(within(connect).getByRole('list', { name: 'Detected CLIs' })).toBeInTheDocument();
    await userEvent.click(within(connect).getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Choose project folder…' }));
    expect(await screen.findByText(/is open/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'How Harbor works' })).toHaveTextContent('/deep');
    await userEvent.click(screen.getByRole('button', { name: /Start working|Finish/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(onboardingKey)).toBe('done');
    expect(sent).toEqual([]);
  });
});

describe('any-file attachments', () => {
  it('treats unknown extensions as text and keeps known binaries out', () => {
    expect(classifyFile({ name: 'model.ipynb', type: '' })).toBe('text');
    expect(classifyFile({ name: 'data.weirdext', type: '' })).toBe('text');
    expect(classifyFile({ name: 'report.xlsx', type: '' })).toBe('unsupported');
  });
  it('quotes a notebook as cells without base64 outputs', () => {
    const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Hi'] }, { cell_type: 'code', source: ['print(1)'], outputs: [{ data: { 'image/png': 'AAAA', 'text/plain': ['<Fig>'] } }] }] });
    const text = notebookToText(nb);
    expect(text).toContain('print(1)');
    expect(text).toContain('# <Fig>');
    expect(text).not.toContain('AAAA');
  });
});
