(function exposeReleaseNotes(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReleaseNotes = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // 行内 markdown：粗体、行内代码、白名单链接（仅 http/https，防 javascript: 注入）。
  // 输入必须已经 escapeHtml，输出只包含本函数生成的标签。
  function inlineMarkdown(text) {
    let out = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      const target = String(url || '').trim();
      if (/^https?:\/\//i.test(target)) {
        return `<a href="${target}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      return label;
    });
    return out;
  }

  // 极简 markdown 渲染：标题（1-3）、无序/有序列表、引用、分隔线、代码块、段落。
  // 先按行匹配块级语法，内容 escapeHtml 后再处理行内语法，杜绝注入。
  function renderReleaseNotes(markdown) {
    const text = String(markdown ?? '').trim();
    if (!text) return '';
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let list = null;      // { type: 'ul' | 'ol', items: [] }
    let paragraph = null; // { lines: [] }
    let code = null;      // { lines: [] }

    const flushList = () => {
      if (!list) return;
      const items = list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('');
      blocks.push(`<${list.type}>${items}</${list.type}>`);
      list = null;
    };
    const flushParagraph = () => {
      if (!paragraph) return;
      blocks.push(`<p>${paragraph.lines.map(inlineMarkdown).join('<br>')}</p>`);
      paragraph = null;
    };

    for (const rawLine of lines) {
      const line = String(rawLine);
      if (code) {
        if (/^\s*```/.test(line)) {
          blocks.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
          code = null;
        } else code.lines.push(line);
        continue;
      }
      if (/^\s*```/.test(line)) { flushList(); flushParagraph(); code = { lines: [] }; continue; }
      const heading = line.match(/^(#{1,3})\s+(.*?)\s*$/);
      if (heading) {
        flushList(); flushParagraph();
        const level = heading[1].length;
        blocks.push(`<h${level}>${inlineMarkdown(escapeHtml(heading[2]))}</h${level}>`);
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        flushParagraph();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(escapeHtml(line.replace(/^\s*[-*+]\s+/, '')));
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.*?)\s*$/);
      if (ordered) {
        flushParagraph();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(escapeHtml(ordered[1]));
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flushList(); flushParagraph();
        blocks.push(`<blockquote>${inlineMarkdown(escapeHtml(line.replace(/^\s*>\s?/, '')))}</blockquote>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushList(); flushParagraph(); blocks.push('<hr>'); continue; }
      if (line.trim() === '') { flushList(); flushParagraph(); continue; }
      flushList();
      if (!paragraph) paragraph = { lines: [] };
      paragraph.lines.push(escapeHtml(line));
    }
    flushList();
    flushParagraph();
    if (code) blocks.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
    return blocks.join('\n');
  }

  return { renderReleaseNotes, escapeHtml, inlineMarkdown };
}));