(function exposeAuthUtils(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AuthUtils = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // 浏览器会把反斜杠当作 URL 分隔符；不能只检查开头是否为双斜杠。
  function safeReturnTo(value) {
    const target = typeof value === 'string' ? value.trim() : '/';
    if (!target.startsWith('/') || target.startsWith('//') || target.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(target)) return '/';
    try {
      const base = 'https://gateway.invalid';
      const url = new URL(target, base);
      // /a/..//outside.example 归一化后也不能作为协议相对 URL 返回。
      return url.origin === base && !url.pathname.startsWith('//') ? `${url.pathname}${url.search}${url.hash}` : '/';
    } catch { return '/'; }
  }

  return { safeReturnTo };
}));