const assert = require('node:assert/strict');
const { renderReleaseNotes, escapeHtml } = require('../public/release-notes');

assert.equal(renderReleaseNotes(''), '');
assert.equal(renderReleaseNotes(null), '');
assert.equal(renderReleaseNotes(undefined), '');

assert.ok(renderReleaseNotes('# 标题一').includes('<h1>标题一</h1>'));
assert.ok(renderReleaseNotes('## 二级').includes('<h2>二级</h2>'));
assert.ok(renderReleaseNotes('### 三级').includes('<h3>三级</h3>'));

const list = renderReleaseNotes('- 甲\n- 乙\n\n1. 第一\n2. 第二');
assert.ok(list.includes('<ul><li>甲</li><li>乙</li></ul>'), '无序列表应合并为一个 ul');
assert.ok(list.includes('<ol><li>第一</li><li>第二</li></ol>'), '有序列表应合并为一个 ol');

assert.ok(renderReleaseNotes('**加粗**').includes('<strong>加粗</strong>'));
assert.ok(renderReleaseNotes('`code`').includes('<code>code</code>'));
assert.ok(renderReleaseNotes('> 引用').includes('<blockquote>引用</blockquote>'));
assert.ok(renderReleaseNotes('---').includes('<hr>'));

// 代码块内容原样保留（转义后），不做行内解析
const codeBlock = renderReleaseNotes('```js\nconst x = "<b>";\n```');
assert.ok(codeBlock.includes('<pre><code>'));
assert.ok(codeBlock.includes('&lt;b&gt;'), '代码块内的 HTML 必须转义');
assert.ok(!codeBlock.includes('<b>'));

// 链接仅允许 http/https
const link = renderReleaseNotes('[官网](https://example.com/a)');
assert.ok(link.includes('<a href="https://example.com/a"'));
const malicious = renderReleaseNotes('[点我](javascript:alert(1))');
assert.ok(!malicious.includes('<a '), '非白名单协议不得生成链接');
assert.ok(malicious.includes('点我'));

// 注入防护：任意原始文本都必须先转义
const evil = renderReleaseNotes('<script>alert(1)</script>');
assert.ok(!evil.includes('<script>'));
assert.ok(evil.includes('&lt;script&gt;'));
assert.ok(!renderReleaseNotes('<img src=x onerror=alert(1)>').includes('<img'));
assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');

// 段落内连续行用 <br> 连接
const para = renderReleaseNotes('第一行\n第二行');
assert.ok(para.includes('<p>第一行<br>第二行</p>'), '段落换行应渲染为 <br>');

// 与真实 release 说明结构一致的组合样本
const sample = renderReleaseNotes([
  '## v2.6.0',
  '',
  '- 项目更名为 **Sakura-AI-Gateway**',
  `- 镜像地址：[ghcr.io/guyao146/sakura-ai-gateway](https://ghcr.io/guyao146/sakura-ai-gateway)`,
  '',
  '```',
  'docker pull ghcr.io/guyao146/sakura-ai-gateway:v2.6.0',
  '```',
  ''
].join('\n'));
assert.ok(sample.includes('<h2>v2.6.0</h2>'));
assert.ok(sample.includes('<li>项目更名为 <strong>Sakura-AI-Gateway</strong></li>'));
assert.ok(sample.includes('docker pull'));
assert.ok(!sample.includes('<script'));

console.log('release notes renderer tests passed');