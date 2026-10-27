import { escapeHtml, safeUrl } from './utils.js';

function inline(text) {
  const codeParts = [];
  let value = String(text ?? '').replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000CODE${codeParts.length}\u0000`;
    codeParts.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  value = escapeHtml(value);
  value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => {
    const href = safeUrl(url);
    return href === '#' ? escapeHtml(alt) : `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  });
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, url) => {
    const href = safeUrl(url);
    return href === '#'
      ? `<span>${label}</span>`
      : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  value = value.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  value = value.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  value = value.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  value = value.replace(/\[(\d{1,3})\]/g, '<a class="citation-link" href="#source-$1" data-source="$1">$1</a>');
  value = value.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeParts[Number(index)] || '');
  return value;
}

function isTable(lines) {
  return lines.length >= 2 && lines[0].includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[1]);
}

function tableToHtml(lines) {
  const split = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
  const headers = split(lines[0]);
  const rows = lines.slice(2).map(split);
  return `<table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, index) => `<td>${inline(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function renderMarkdown(source) {
  if (!source) return '';
  const codeBlocks = [];
  let text = String(source).replace(/\r\n?/g, '\n');
  text = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const token = `\u0000BLOCK${codeBlocks.length}\u0000`;
    const languageClass = language ? ` class="language-${escapeHtml(language)}"` : '';
    codeBlocks.push(`<pre><code${languageClass}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return token;
  });

  const blocks = text.split(/\n{2,}/);
  const output = blocks.map((rawBlock) => {
    const block = rawBlock.trim();
    if (!block) return '';
    if (/^\u0000BLOCK\d+\u0000$/.test(block)) return block;

    const lines = block.split('\n');
    if (isTable(lines)) return tableToHtml(lines);

    const heading = block.match(/^(#{1,6})\s+([\s\S]+)$/);
    if (heading) {
      const level = heading[1].length;
      return `<h${level}>${inline(heading[2].trim())}</h${level}>`;
    }

    if (/^(\*{3,}|-{3,}|_{3,})$/.test(block)) return '<hr>';

    if (lines.every((line) => /^>\s?/.test(line))) {
      return `<blockquote>${inline(lines.map((line) => line.replace(/^>\s?/, '')).join('\n')).replaceAll('\n', '<br>')}</blockquote>`;
    }

    if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
      return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('')}</ul>`;
    }

    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    }

    return `<p>${inline(block).replaceAll('\n', '<br>')}</p>`;
  }).join('');

  return output.replace(/\u0000BLOCK(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)] || '');
}
