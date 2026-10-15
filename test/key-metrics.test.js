const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-key-metrics-'));
process.env.SAKURA_AI_GATEWAY_DATA_DIR = dataDirectory;
process.env.SAKURA_AI_GATEWAY_MAX_LOGS = '100';
const modulePath = require.resolve('../src/metrics');
const reload = () => { delete require.cache[modulePath]; return require(modulePath); };
let metrics = reload();
const fields = ['requests', 'successful', 'failed', 'failovers', 'promptTokens', 'completionTokens', 'totalTokens'];
const assertTotals = (snapshot) => {
  for (const field of fields) {
    assert.equal(Object.values(snapshot.byKey).reduce((sum, item) => sum + item[field], 0), snapshot.totals[field], `${field} 的分 Key 合计应等于总量`);
  }
};
const record = (id, keyId, finishedAt, extra = {}) => metrics.recordRequest({
  id, keyId, keyName: '同名 Key', finishedAt, startedAt: finishedAt,
  status: 200, success: true, upstream: 'primary', ...extra
});
const seedLegacy = (totals, entries, inline = false) => {
  fs.writeFileSync(metrics.METRICS_PATH, JSON.stringify({ version: 1, totals, byUpstream: { legacy: { requests: 99 } }, ...(inline ? { logs: entries.slice().reverse() } : {}) }));
  if (inline) fs.rmSync(metrics.LOG_PATH, { force: true });
  else fs.writeFileSync(metrics.LOG_PATH, entries.map((item) => JSON.stringify(item)).join('\n') + '\ncorrupted line\n');
  metrics = reload();
};

try {
  assert.deepEqual(metrics.getMetrics().byKey, {});
  record('first', 'key-a', '2026-10-02T12:00:00Z', {
    keyName: '旧名字', usage: { prompt_tokens: 10, completion_tokens: 4 }, upstream: 'fallback',
    attempts: [{ upstream: 'primary', status: 503 }, { upstream: 'primary', status: 503, retry: 1 }, { upstream: 'fallback', status: 200 }]
  });
  record('failed', 'key-b', '2026-10-02T14:00:00Z', { success: false, status: 400, usage: null });
  record('retry', 'key-a', '2026-10-02T18:00:00Z', {
    usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    attempts: [{ upstream: 'primary', status: 503 }, { upstream: 'primary', status: 200, retry: 1 }]
  });
  record('out-of-order', 'key-a', '2026-10-01T12:00:00Z', {
    keyName: '更早的名字', success: false, status: 502, usage: { input_tokens: 1, output_tokens: 2 }
  });
  record('anonymous', null, '2026-10-03T00:00:00Z', { usage: { total_tokens: 2 } });
  let snapshot = metrics.getMetrics();
  assert.deepEqual(snapshot.byKey['key-a'], {
    keyId: 'key-a', keyName: '同名 Key', requests: 3, successful: 2, failed: 1,
    failovers: 1, promptTokens: 13, completionTokens: 9, totalTokens: 22, lastRequestAt: '2026-10-02T18:00:00.000Z'
  }, '改名保持同一 ID，原地重试和切换不能重复累计请求或 Token');
  assert.equal(snapshot.byKey['key-b'].requests, 1, '同名不同 ID 的 Key 不能合并');
  assert.equal(snapshot.byKey['key-b'].failed, 1);
  assert.equal(snapshot.byKey[''].keyId, null);
  assert.equal(snapshot.byKey[''].keyName, '', '缺失 ID 时不能仅凭名称猜测归属');
  assert.equal(snapshot.byKey[''].requests, 1);
  assertTotals(snapshot);

  const range = metrics.getRangeStats({ from: '2026-10-02T12:00:00Z', to: '2026-10-02T18:00:00Z' });
  assert.equal(range.matched, 3, '范围为闭区间');
  assert.equal(range.byKey['key-a'].requests, 2);
  assert.equal(range.byKey['key-a'].totalTokens, 19);
  assert.equal(range.byKey['key-b'].failed, 1);
  assert.equal(range.byKey[''], undefined);
  assertTotals(range);
  assert.deepEqual(metrics.getRangeStats({ from: '2020-01-01', to: '2020-01-02' }).byKey, {});
  snapshot.byKey['key-a'].requests = 999;
  assert.equal(metrics.getMetrics().byKey['key-a'].requests, 3, '响应必须是副本');
  range.byKey['key-a'].requests = 999;
  assert.equal(metrics.getMetrics().byKey['key-a'].requests, 3, '范围统计不能改写全量计数');

  for (const keyId of ['__proto__', 'constructor', 'toString']) {
    record(`special-${keyId}`, keyId, '2026-10-03T12:00:00Z', { keyName: '<img src=x onerror=alert(1)>' });
    assert.equal(metrics.getMetrics().byKey[keyId].requests, 1, '特殊 Key ID 不得触碰对象原型');
  }
  assert.equal({}.requests, undefined);
  snapshot = metrics.getMetrics();
  metrics = reload();
  assert.deepEqual(metrics.getMetrics().byKey, snapshot.byKey, '重启恢复分 Key 全量统计');
  assert.deepEqual(metrics.getMetrics().totals, snapshot.totals);
  assertTotals(metrics.getMetrics());

  const exported = metrics.getAllLogs();
  metrics.clearMetrics();
  const imported = metrics.importUsageRecords([...exported, exported[0]]);
  assert.equal(imported.imported, exported.length);
  assert.equal(imported.duplicates, 1);
  assert.deepEqual(imported.metrics.byKey, snapshot.byKey, '用量导出再导入应保留 camelCase Token 与 Key 信息');
  assert.deepEqual(metrics.importUsageRecords(exported).metrics.byKey, snapshot.byKey, '重复导入不能重复累计');
  const oldRecord = { id: 'import-old', keyId: 'key-a', keyName: '导入旧名字', finishedAt: '2020-01-01T00:00:00Z', success: true, usage: { input_tokens: 3, output_tokens: 7 } };
  assert.equal(metrics.importUsageRecords([oldRecord]).metrics.byKey['key-a'].totalTokens, 32);
  assert.equal(metrics.getMetrics().byKey['key-a'].keyName, '同名 Key', '导入旧记录不能覆盖较新的名称');
  assertTotals(metrics.getMetrics());
  const oldRetry = metrics.importUsageRecords([{ id: 'import-retry', keyId: 'key-import', success: true,
    attempts: [{ upstream: 'primary', status: 503 }, { upstream: 'primary', status: 200, retry: 1 }] }]);
  assert.equal(oldRetry.metrics.byKey['key-import'].failovers, 0, '旧导入缺少 failover 字段时也不能把原地重试当切换');
  assert.equal(oldRetry.metrics.byKey['key-import'].lastRequestAt, null, '缺少时间的旧数据不应显示虚构的最近调用时间');

  const legacyTotals = { requests: 10, successful: 7, failed: 3, failovers: 2, promptTokens: 100, completionTokens: 40, totalTokens: 140 };
  const legacyEntries = [
    { id: 'legacy-a', keyId: 'key-a', keyName: '历史 Key', finishedAt: '2026-10-01T12:00:00Z', success: true, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    { id: 'legacy-unassigned', finishedAt: '2026-10-02T12:00:00Z', success: false, usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }
  ];
  for (const inline of [false, true]) {
    seedLegacy(legacyTotals, legacyEntries, inline);
    snapshot = metrics.getMetrics();
    assert.deepEqual(snapshot.totals, legacyTotals, '升级不得重置旧全量计数');
    assert.deepEqual(snapshot.byUpstream, { legacy: { requests: 99 } }, '迁移 Key 统计不能改变上游计数');
    assert.equal(snapshot.byKey['key-a'].requests, 1);
    assert.equal(snapshot.byKey['key-a'].totalTokens, 15);
    assert.equal(snapshot.byKey[''].requests, 9, '已裁剪明细和无 Key 记录计为未归属');
    assert.equal(snapshot.byKey[''].totalTokens, 125);
    assertTotals(snapshot);
    assert.equal('logs' in JSON.parse(fs.readFileSync(metrics.METRICS_PATH, 'utf8')), false, '迁移后仍保持聚合与明细分离');
    metrics = reload();
    assert.deepEqual(metrics.getMetrics().byKey, snapshot.byKey, '迁移后再次启动不能重复回填');
    assert.deepEqual(metrics.importUsageRecords([]).metrics.byKey, snapshot.byKey, '空导入不能丢失未知历史累计');
  }
  seedLegacy(legacyTotals, []);
  assert.equal(metrics.getMetrics().byKey[''].requests, 10, '旧日志完全缺失仍应保留全量计数');
  const inconsistentTotals = { ...legacyTotals, requests: 1, successful: 1, failed: 0 };
  seedLegacy(inconsistentTotals, legacyEntries);
  assert.deepEqual(Object.keys(metrics.getMetrics().byKey), [''], '旧聚合与明细冲突时保守标为未归属');
  assertTotals(metrics.getMetrics());

  metrics.clearMetrics();
  for (let index = 0; index < 205; index += 1) {
    record(`compact-${index}`, index === 0 ? 'key-evicted' : 'key-active', new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(), { usage: { prompt_tokens: 2, completion_tokens: 1 } });
  }
  snapshot = metrics.getMetrics();
  assert.equal(snapshot.totals.requests, 205);
  assert.equal(snapshot.logPage.total, 100);
  assert.equal(snapshot.byKey['key-evicted'].requests, 1, 'Key 已无近期日志仍需保留累计');
  assert.equal(snapshot.byKey['key-active'].totalTokens, 612);
  assert(fs.readFileSync(metrics.LOG_PATH, 'utf8').trim().split('\n').length <= 200, '验证 JSONL 实际执行过压实');
  metrics = reload();
  assert.deepEqual(metrics.getMetrics().byKey, snapshot.byKey, '压实后重启不能退回近期日志的计数');
  assert.equal(metrics.getRangeStats({ from: '2026-10-01', to: '2026-10-02' }).totals.requests, 100, '范围统计只统计保留明细');
  assert.deepEqual(metrics.importUsageRecords(metrics.getAllLogs()).metrics.byKey, snapshot.byKey, '重复导入不能将全量计数缩减到日志上限');
  const merged = metrics.importUsageRecords([{ id: 'fresh-import', keyId: 'key-active', keyName: '同名 Key', finishedAt: '2026-10-02T12:00:00Z', success: true, usage: { promptTokens: 3, completionTokens: 1 } }]);
  assert.equal(merged.metrics.totals.requests, 206);
  assert.equal(merged.metrics.byKey['key-active'].totalTokens, 616);
  assertTotals(merged.metrics);
  assert.deepEqual(metrics.clearMetrics().byKey, {});
  metrics = reload();
  assert.deepEqual(metrics.getMetrics().byKey, {}, '清空统计必须持久化');
  assert.equal(metrics.getMetrics().totals.requests, 0);
  console.log('key metrics tests passed (aggregation, migration, persistence, import, compaction)');
} finally {
  fs.rmSync(dataDirectory, { recursive: true, force: true });
}