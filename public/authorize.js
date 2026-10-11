(() => {
  const $ = (selector) => document.querySelector(selector);
  const { safeReturnTo } = window.AuthUtils;
  const parameters = new URLSearchParams(window.location.search);
  let consent = null;
  let submitting = false;

  function error(message) {
    $('#authorizeError').textContent = message;
    $('#authorizeError').classList.toggle('hidden', !message);
  }

  function login(url) {
    $('#authorizeForm').classList.add('hidden');
    $('#authorizeLogin').href = safeReturnTo(url);
    $('#authorizeLogin').classList.remove('hidden');
    $('#authorizeStatus').textContent = '请先登录网关账号；登录成功后会返回此页，请你明确确认或拒绝授权。';
  }

  function list(selector, values) {
    const container = $(selector);
    container.replaceChildren(...values.map((value) => {
      const item = document.createElement('li');
      item.textContent = value;
      return item;
    }));
  }

  async function load() {
    try {
      const response = await fetch(`/oauth/consent?${parameters}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const body = await response.json();
      if (response.status === 401 && body.login_url) { login(body.login_url); return; }
      if (!response.ok) throw new Error(body.error_description || '无法读取授权请求');
      consent = body;
      $('#authorizeClient').textContent = body.client.name;
      $('#authorizeAccount').textContent = body.user.username;
      $('#authorizeRedirect').textContent = body.client.redirectUri;
      $('#authorizeSource').textContent = body.sourceKey.name;
      list('#authorizeScopes', body.scopes.map((scope) => scope.description));
      list('#authorizeModels', body.models);
      $('#authorizeModelSummary').textContent = `当前可用模型（${body.models.length} 个）`;
      $('#authorizeModelNotice').textContent = body.modelAccessMode === 'all'
        ? '权限上限为来源 Key 的全部模型，包括之后新增的模型。来源 Key 停用、删除或权限收缩会立即限制应用访问。'
        : '仅允许本次确认的自定义模型范围；来源 Key 后续扩大权限不会自动扩大此授权。';
      $('#authorizeStatus').textContent = '应用正在请求使用你的网关。请确认应用、回调地址以及授权范围。';
      $('#authorizeForm').classList.remove('hidden');
    } catch (failure) {
      $('#authorizeStatus').textContent = '无法继续授权';
      error(failure.message);
    }
  }

  async function decide(approve) {
    if (!consent || submitting) return;
    submitting = true;
    $('#approveAuthorization').disabled = true;
    $('#denyAuthorization').disabled = true;
    error('');
    try {
      const response = await fetch('/oauth/consent', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ request_id: consent.request_id, csrf_token: consent.csrf_token, approve })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error_description || '授权确认失败，请重新发起授权');
      // 服务端只会返回登记过的回调地址；页面再校验一次，不能接受任意跳转。
      const target = new URL(body.redirect);
      const expected = new URL(consent.client.redirectUri);
      if (target.origin !== expected.origin || target.pathname !== expected.pathname || target.hash
        || target.searchParams.get('state') !== parameters.get('state') || target.searchParams.get('iss') !== window.location.origin) {
        throw new Error('授权回调地址校验失败');
      }
      window.location.assign(target.href);
    } catch (failure) {
      error(failure.message);
      submitting = false;
      $('#approveAuthorization').disabled = false;
      $('#denyAuthorization').disabled = false;
    }
  }

  $('#authorizeForm').addEventListener('submit', (event) => { event.preventDefault(); decide(true); });
  $('#denyAuthorization').addEventListener('click', () => decide(false));
  load();
})();