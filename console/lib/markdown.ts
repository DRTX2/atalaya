// Renders the subset of Markdown that Bitácora's postmortems use (headings, lists, checkboxes, tables,
// **bold**, `code`). Everything is HTML-escaped first: incident summaries come from monitored systems,
// so the output must be safe to inject. Pure; tested in test/markdown.test.ts.

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const inline = (s: string) => escape(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length + 1; // the page owns <h1>
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (line.startsWith('- ')) {
      const items: string[] = [];
      for (; i < lines.length && lines[i].startsWith('- '); i++) {
        const text = lines[i].slice(2);
        const box = /^\[( |x)\]\s+(.*)$/.exec(text);
        items.push(box ? `<li class="task"><input type="checkbox" disabled${box[1] === 'x' ? ' checked' : ''}> ${inline(box[2])}</li>` : `<li>${inline(text)}</li>`);
      }
      i--;
      out.push(`<ul>${items.join('')}</ul>`);
    } else if (line.startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) {
        if (/^\|\s*-/.test(lines[i])) continue; // separator row
        rows.push(cells(lines[i]));
      }
      i--;
      const [head, ...body] = rows;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  return out.join('\n');
}
