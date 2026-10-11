(() => {
  const $ = (selector) => document.querySelector(selector);
  const form = $('#oauthClientForm');
  const dialog = $('#oauthClientDialog');
  let clients = [];
  let keys = [];

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error_description || body.error?.message || '应用管理请求失败');
    return body;
  }

  function render() {
    const container = $('#oauthClientList');
    container.replaceChildren();
    if (!clients.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '尚未登记账号授权应用。登记后将 Client ID 和回调地址交给接入方，不需要共享 API Key。';
      container.append(empty);
    }
    for (const client of clients) {
      const card = document.createElement('article');
      card.className = 'item-card oauth-client-card';
      const content = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = `${client.name} · ${client.enabled ? '已启用' : '已停用'}`;
      const id = document.createElement('code');
      id.textContent = client.id;
      const detail = document.createElement('div');
      detail.className = 'item-meta';
      detail.textContent = `来源 Key：${keys.find((key) => key.id === client.sourceKeyId)?.name || '已删除'} · 回调：${client.redirectUris.join('、')}`;
      content.append(title, id, detail);
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      for (const [action, label] of [['edit', '编辑'], ['toggle', client.enabled ? '停用' : '启用'], ['delete', '删除']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `text-button${action === 'delete' ? ' delete' : ''}`;
        button.dataset.oauthAction = action;
        button.dataset.id = client.id;
        button.textContent = label;
        actions.append(button);
      }
      card.append(content, actions);
      container.append(card);
    }
  }

  async function load() {
    try {
      const [result, config] = await Promise.all([request('/api/admin/oauth-clients'), request('/api/admin/config')]);
      clients = result.clients;
      keys = config.localApiKeys.map(({ id, name, enabled }) => ({ id, name, enabled }));
      render();
      $('#oauthClientMessage').textContent = '';
      return true;
    } catch (failure) {
      $('#oauthClientMessage').textContent = failure.message;
      return false;
    }
  }

  async function edit(client) {
    if (!await load()) return;
    form.reset();
    $('#oauthClientId').value = client?.id || '';
    $('#oauthClientName').value = client?.name || '';
    $('#oauthClientRedirectUris').value = client?.redirectUris.join('\n') || '';
    $('#oauthClientEnabled').checked = client?.enabled !== false;
    $('#oauthClientSourceKey').replaceChildren(...keys.filter((key) => key.enabled !== false || key.id === client?.sourceKeyId).map((key) => {
      const option = document.createElement('option');
      option.value = key.id;
      option.textContent = `${key.name}${key.enabled === false ? '（已停用）' : ''}`;
      return option;
    }));
    if (client) $('#oauthClientSourceKey').value = client.sourceKeyId;
    $('#oauthClientFormMessage').textContent = '';
    dialog.showModal();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('#oauthClientId').value;
    if (id && !window.confirm('修改应用会撤销它已有的账号授权，接入方需要重新授权。继续吗？')) return;
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      await request(`/api/admin/oauth-clients${id ? `/${encodeURIComponent(id)}` : ''}`, {
        method: id ? 'PUT' : 'POST', body: JSON.stringify({
          name: $('#oauthClientName').value.trim(), sourceKeyId: $('#oauthClientSourceKey').value,
          redirectUris: $('#oauthClientRedirectUris').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), enabled: $('#oauthClientEnabled').checked
        })
      });
      dialog.close();
      await load();
      window.dispatchEvent(new Event('oauth-clients-changed'));
    } catch (failure) { $('#oauthClientFormMessage').textContent = failure.message; }
    finally { submit.disabled = false; }
  });

  $('#oauthClientList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-oauth-action]');
    const client = clients.find((item) => item.id === button?.dataset.id);
    if (!client) return;
    if (button.dataset.oauthAction === 'edit') { await edit(client); return; }
    if (!window.confirm(`此操作会撤销「${client.name}」已有的账号授权，继续吗？`)) return;
    button.disabled = true;
    try {
      await request(`/api/admin/oauth-clients/${encodeURIComponent(client.id)}`, {
        method: button.dataset.oauthAction === 'delete' ? 'DELETE' : 'PUT',
        ...(button.dataset.oauthAction === 'toggle' ? { body: JSON.stringify({ enabled: !client.enabled }) } : {})
      });
      await load();
      window.dispatchEvent(new Event('oauth-clients-changed'));
    } catch (failure) { $('#oauthClientMessage').textContent = failure.message; button.disabled = false; }
  });
  $('#addOAuthClientButton').addEventListener('click', () => edit());
  $('#refreshOAuthClientsButton').addEventListener('click', load);
  window.addEventListener('gateway-config-loaded', () => { if (!dialog.open) load(); });
  document.querySelector('[data-tab="keys"]').addEventListener('click', load);
})();