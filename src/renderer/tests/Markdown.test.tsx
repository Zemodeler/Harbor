import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../components/Markdown';

const roadmap = [
  '| ID | Item | Priority | Size | Owner |',
  '|---|---|---|---|---|',
  '| **0.1 Adapter verification** | Verify Claude and Codex start | P0 · L | Core | Core |',
  '| **0.2 Restart without duplicate work** | Persist pending delivery | P0 · L | Core | Core |',
].join('\n');

describe('Markdown tables', () => {
  it('renders the roadmap pipe text as a semantic table', () => {
    const { container } = render(<Markdown text={roadmap + '\n\n**Exit condition:** done.'}/>);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['ID', 'Item', 'Priority', 'Size', 'Owner']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('0.1 Adapter verification').tagName).toBe('STRONG');
    expect(container.textContent).not.toContain('|---');
    expect(screen.getByText('Exit condition:').tagName).toBe('STRONG');
  });
  it('wraps the table in a focusable, labelled scroll region', () => {
    render(<Markdown text={roadmap}/>);
    const region = screen.getByRole('region', { name: /table/i });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });
  it('applies column alignment from the separator row', () => {
    render(<Markdown text={'| L | C | R | N |\n|:--|:-:|--:|---|\n| a | b | c | d |'}/>);
    const cells = screen.getAllByRole('cell');
    expect(cells.map(c => c.getAttribute('data-align'))).toEqual(['left', 'center', 'right', null]);
  });
  it('keeps escaped pipes and pipes in inline code inside their cell', () => {
    render(<Markdown text={'| a | b |\n|---|---|\n| x \\| y | `p|q` |'}/>);
    const cells = screen.getAllByRole('cell');
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe('x | y');
    expect(cells[1].querySelector('code')?.textContent).toBe('p|q');
  });
  it('pads short rows and drops extra cells', () => {
    render(<Markdown text={'| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |'}/>);
    expect(screen.getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell').length)).toEqual([2, 2]);
  });
  it('stays readable text while a table is still streaming in', () => {
    for (const partial of ['| ID | Item |', '| ID | Item |\n|---|']) {
      const { container, unmount } = render(<Markdown text={partial}/>);
      expect(screen.queryByRole('table')).toBeNull();
      expect(container.querySelector('p')).not.toBeNull();
      unmount();
    }
    const header = render(<Markdown text={'| ID | Item |\n|---|--'}/>);
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    header.unmount();
    render(<Markdown text={'| ID | Item |\n|---|---|\n| 1 | par'}/>);
    expect(screen.getAllByRole('cell').map(c => c.textContent)).toEqual(['1', 'par']);
  });
  it('leaves ordinary prose containing pipes unchanged', () => {
    const { container } = render(<Markdown text={'Use a | b to pipe output.\nNext line | here.'}/>);
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('Use a | b to pipe output.\nNext line | here.');
  });
  it('ends a table at the first non-pipe line', () => {
    render(<Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |\nafter the table'}/>);
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('after the table').tagName).toBe('P');
  });
});

describe('Markdown lists and paragraphs', () => {
  it('renders numbered lists as ol, honouring the start number', () => {
    const { container } = render(<Markdown text={'Steps:\n1. First\n2. Second\n\n3) Third'}/>);
    expect(container.querySelector('ol')).toHaveAttribute('start', '1');
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['First', 'Second', 'Third']);
    expect(screen.getByText('Steps:').tagName).toBe('P');
    const later = render(<Markdown text={'4. Four\n5. Five'}/>);
    expect(later.container.querySelector('ol')).toHaveAttribute('start', '4');
  });
  it('separates a paragraph from the list that follows and keeps bullets as ul', () => {
    const { container } = render(<Markdown text={'Intro line\n- one\n- **two**\nOutro'}/>);
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelector('ul li strong')?.textContent).toBe('two');
  });
  it('switches between ordered and bullet lists', () => {
    const { container } = render(<Markdown text={'1. a\n- b'}/>);
    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
  });
  it('still renders headings, bold and inline code', () => {
    render(<Markdown text={'## Title\nBody with `code` and **bold**.'}/>);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });
  it('does not treat a numbered-looking year or version as a list', () => {
    const { container } = render(<Markdown text={'Released in 2024. Version 1.2 ships.'}/>);
    expect(container.querySelector('ol')).toBeNull();
  });
});

describe('Markdown code and safety', () => {
  it('keeps pipes and list syntax in code fences literal', () => {
    const { container } = render(<Markdown text={'```md\n| a | b |\n|---|---|\n1. x\n```'}/>);
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('ol')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe('| a | b |\n|---|---|\n1. x');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });
  it('renders HTML and links inside table cells and lists as inert text', () => {
    const { container } = render(<Markdown text={'| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |\n\n1. <script>alert(1)</script>'}/>);
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(screen.getAllByRole('cell')[0].textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('Markdown review regressions', () => {
  it('parses Windows CRLF and lone-CR roadmap tables and lists', () => {
    for (const eol of ['\r\n', '\r']) {
      const { container, unmount } = render(<Markdown text={[roadmap, '', '1. one', '2. two'].join(eol)}/>);
      expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
      expect(container.querySelectorAll('ol li')).toHaveLength(2);
      expect(container.textContent).not.toContain('\r');
      unmount();
    }
  });
  it('keeps fenced code contents byte-for-byte under CRLF', () => {
    const { container } = render(<Markdown text={'Intro\r\n\r\n```txt\r\n| a | b |\r\n|---|---|\r\n```\r\n\r\nAfter'}/>);
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe('| a | b |\r\n|---|---|\r');
  });
  it('leaves prose ending in a pipe before a bare rule as prose', () => {
    const { container } = render(<Markdown text={'Choose one of a | b |\n---\nNext'}/>);
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.textContent).toContain('Choose one of a | b |');
  });
  it('still renders a single-column piped table', () => {
    render(<Markdown text={'| a |\n|---|\n| 1 |'}/>);
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['a']);
  });
  it('does not let an unmatched backtick swallow later cells', () => {
    render(<Markdown text={'| a | b | c |\n|---|---|---|\n| it`s | x | y |\n| `p\\|q` | `r|s` | z |'}/>);
    const cells = screen.getAllByRole('cell').map(c => c.textContent);
    expect(cells).toEqual(['it`s', 'x', 'y', 'p|q', 'r|s', 'z']);
  });
  it('treats an escaped backtick as literal and keeps trailing cells', () => {
    render(<Markdown text={'| a | b |\n|---|---|\n| \\`x | y |'}/>);
    expect(screen.getAllByRole('cell').map(c => c.textContent)).toEqual(['\\`x', 'y']);
  });
  it('keeps a trailing escaped pipe as cell content', () => {
    render(<Markdown text={'| a | b |\n|---|---|\n| x | y \\|'}/>);
    expect(screen.getAllByRole('cell').map(c => c.textContent)).toEqual(['x', 'y |']);
  });
});
