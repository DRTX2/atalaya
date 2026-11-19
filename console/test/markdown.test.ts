import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../lib/markdown.ts';

test('renders the postmortem subset', () => {
  const html = renderMarkdown('# Postmortem: x\n\n- **Status:** recovered\n- [ ] Root cause\n\n| Step | Time |\n|---|---|\n| Opened → mitigated | 677 ms |\n');
  assert.match(html, /<h2>Postmortem: x<\/h2>/);
  assert.match(html, /<li><strong>Status:<\/strong> recovered<\/li>/);
  assert.match(html, /<li class="task"><input type="checkbox" disabled> Root cause<\/li>/);
  assert.match(html, /<th>Step<\/th><th>Time<\/th>.*<td>Opened → mitigated<\/td><td>677 ms<\/td>/s);
});

test('escapes HTML coming from incident data', () => {
  const html = renderMarkdown('# Postmortem: <img src=x onerror=alert(1)>\n\n| Time | Event |\n|---|---|\n| now | <script>steal()</script> \\| piped |\n');
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<td>&lt;script&gt;steal\(\)&lt;\/script&gt; \| piped<\/td>/);
});
