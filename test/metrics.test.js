const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// metrics.js 在加载时读取数据目录，必须先指向临时目录再 require。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-metrics-'));
process.env.SAKURA_AI_GATEWAY_DATA_DIR = dataDir;
process.env.SAKURA_AI_GATEWAY_MAX_LOGS = '100';

const { recordRequest, getLogs, importUsageRecords, clearMetrics } = require('../src/metrics');
const { getRangeStats } = require('../src/metrics');

const longText = 'x'.repeat(800);

function main() {
  const entry = recordRequest({
    id: 'req_metrics_failure',
    protocol: 'openai',
    model: 'test-local',
    upstream: 'fallback',
    upstreamModel: 'test-model',
    status: 400,
    success: false,
    stream: false,
    strategy: 'failover',
    error: longText,
    upstreamError: {
      status: 400,
      code: 'upstream_request_rejected',
      type: 'invalid_request_error',
      param: 'messages',
      message: longText,
      extra: '不应保留的字段'
    },
    attempts: [
      { upstream: 'primary', status: 503, error: { status: 503, message: 'primary unavailable' } },
      { upstream: 'fallback', status: 400, error: { status: 400, code: 'upstream_request_rejected', type: 'invalid_request_error', param: 'messages', message: longText } }
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  });

  assert.equal(entry.error.length, 500, '错误信息截断到 500 字符');
  assert.deepEqual(entry.upstreamError, {
    status: 400,
    code: 'upstream_request_rejected',
    type: 'invalid_request_error',
    param: 'messages',
    message: longText.slice(0, 300)
  }, '上游错误只保留约定字段并截断');
  assert.equal(entry.attempts[0].error.message, 'primary unavailable', '每次尝试都记录上游错误');
  assert.equal(entry.attempts[1].error.message.length, 300, '单次尝试的错误信息同样截断');

  const page = getLogs({ limit: 10 });
  const stored = page.items.find((item) => item.id === 'req_metrics_failure');
  assert.ok(stored, '分页接口应返回该记录');
  assert.deepEqual(stored.upstreamError, entry.upstreamError, '分页接口返回的上游错误必须与记录一致');
  assert.deepEqual(stored.attempts[1].error, entry.attempts[1].error, '克隆不能丢失每次尝试的上游错误');

  const success = recordRequest({ id: 'req_metrics_success', model: 'test-local', upstream: 'fallback', status: 200, success: true, usage: { total_tokens: 1 } });
  assert.equal('upstreamError' in success, false, '成功请求不记录上游错误');
  assert.equal('error' in success, false, '成功请求不记录错误信息');

  // 导入的用量记录同样要收敛 upstreamError，旧导出里混入的脏字段不能进日志。
  const imported = importUsageRecords([
    {
      id: 'req_metrics_imported',
      model: 'test-local',
      upstream: 'fallback',
      status: 429,
      success: false,
      error: '导入的失败记录',
      upstreamError: { status: 429, code: 'rate_limited', message: 'too many requests', dirty: true },
      usage: {},
      attempts: []
    }
  ]);
  assert.equal(imported.imported, 1);
  const importedEntry = getLogs({ limit: 10 }).items.find((item) => item.id === 'req_metrics_imported');
  assert.deepEqual(importedEntry.upstreamError, { status: 429, code: 'rate_limited', message: 'too many requests' });

  // 按时间范围统计：闭区间命中、跨边界不计、参数校验与 byUpstream 复用聚合语义。
  clearMetrics();
  const stamped = (id, finishedAt, upstream, extra = {}) => recordRequest({
    id, model: 'range-model', upstream, status: 200, success: true,
    finishedAt, startedAt: finishedAt,
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    ...extra
  });
  stamped('req_range_first', '2026-10-01T08:00:00Z', 'range-a', { attempts: [{ upstream: 'range-a', status: 200 }] });
  stamped('req_range_second', '2026-10-02T12:00:00Z', 'range-b', {
    success: false,
    attempts: [{ upstream: 'range-a', status: 503 }, { upstream: 'range-b', status: 200 }]
  });
  stamped('req_range_third', '2026-10-03T18:00:00Z', 'range-b', { attempts: [{ upstream: 'range-b', status: 200 }] });
  stamped('req_range_edge_start', '2026-10-02T00:00:00Z', 'range-a', { attempts: [{ upstream: 'range-a', status: 200 }] });
  stamped('req_range_edge_end', '2026-10-02T23:59:59Z', 'range-b', { attempts: [{ upstream: 'range-b', status: 200 }] });

  // 内容摘要与按 Key / 关键字 / 时间段的日志搜索。
  const digested = recordRequest({
    id: 'req_search_target',
    model: 'search-model',
    upstream: 'search-upstream',
    status: 200,
    success: true,
    keyId: 'key-search',
    keyName: '搜索测试 Key',
    contentDigest: '  帮我写一段\n快速排序算法  ',
    finishedAt: '2026-11-01T06:00:00Z',
    startedAt: '2026-11-01T06:00:00Z',
    attempts: [{ upstream: 'search-upstream', status: 200 }]
  });
  assert.equal(digested.contentDigest, '帮我写一段\n快速排序算法', '内容摘要去除首尾空白并保留内部换行');
  const longDigest = recordRequest({ id: 'req_search_long', model: 'search-model', status: 200, success: true, contentDigest: '词'.repeat(800) });
  assert.equal(longDigest.contentDigest.length, 500, '内容摘要截断到 500 字符');
  const noDigest = recordRequest({ id: 'req_search_plain', model: 'search-model', status: 200, success: true, keyId: 'key-other' });
  assert.equal('contentDigest' in noDigest, false, '没有用户内容的请求不记录摘要字段');

  const { searchLogs, listLogKeys } = require('../src/metrics');
  const byContent = searchLogs({ keyword: '快速排序' });
  assert.equal(byContent.total, 1, '按内容关键字命中一条');
  assert.equal(byContent.items[0].id, 'req_search_target');
  const byKey = searchLogs({ keyId: 'key-search' });
  assert.equal(byKey.total, 1, '按 Key 命中一条');
  const byModel = searchLogs({ keyword: 'search-model' });
  assert.equal(byModel.total, 3, '按模型名命中全部记录');
  const byTime = searchLogs({ from: '2026-11-01T05:00:00Z', to: '2026-11-01T07:00:00Z' });
  assert.equal(byTime.total, 1, '按时间段命中目标记录');
  const combined = searchLogs({ keyword: '快速排序', keyId: 'key-search', from: '2026-11-01T00:00:00Z', to: '2026-11-01T23:59:59Z' });
  assert.equal(combined.total, 1, '组合筛选应命中目标记录');
  const notFound = searchLogs({ keyword: '不存在的内容' });
  assert.equal(notFound.total, 0, '无匹配时返回空结果');
  const keys = listLogKeys();
  const searchKey = keys.find((item) => item.keyId === 'key-search');
  assert.ok(searchKey && searchKey.keyName === '搜索测试 Key', 'Key 列表应包含 keyName');
  assert.ok(searchKey.requests >= 1, 'Key 列表应累计请求次数');
  assert.throws(() => searchLogs({ from: 'not-a-date', to: '2026-11-01T00:00:00Z' }), /日志筛选的开始时间无效/);
  assert.throws(() => searchLogs({ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }), /开始时间不能晚于结束时间/);

  const singleDay = getRangeStats({ from: '2026-10-02T00:00:00Z', to: '2026-10-02T23:59:59Z' });
  assert.equal(singleDay.matched, 3, '闭区间应包含起止边界');
  assert.equal(singleDay.totals.requests, 3);
  assert.equal(singleDay.totals.successful, 2);
  assert.equal(singleDay.totals.failed, 1, '失败请求应计入');
  assert.equal(singleDay.totals.failovers, 1, '跨上游切换才算故障转移');
  assert.equal(singleDay.totals.promptTokens, 30);
  assert.equal(singleDay.totals.totalTokens, 42);
  const singleDayBuckets = singleDay.byUpstream;
  assert.equal(singleDayBuckets['range-a'].requests, 2, '按上游统计与 totals 口径一致');
  assert.equal(singleDayBuckets['range-a'].failed, 1);
  assert.equal(singleDayBuckets['range-b'].requests, 2);
  assert.equal(singleDayBuckets['range-b'].successful, 2);

  const whole = getRangeStats({ from: '2026-10-01T00:00:00Z', to: '2026-10-04T00:00:00Z' });
  assert.equal(whole.matched, 5);
  assert.equal(whole.totals.requests, 5);
  assert.equal(whole.byUpstream['range-a'].requests, 3);
  assert.equal(whole.byUpstream['range-b'].requests, 3);

  const empty = getRangeStats({ from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' });
  assert.equal(empty.matched, 0);
  assert.deepEqual(empty.totals, { requests: 0, successful: 0, failed: 0, failovers: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });

  assert.throws(() => getRangeStats({ from: 'not-a-date', to: '2026-10-06T00:00:00Z' }), /时间范围参数无效/);
  assert.throws(() => getRangeStats({ from: '2026-10-06T00:00:00Z', to: '2026-10-05T00:00:00Z' }), /开始时间不能晚于结束时间/);

  clearMetrics();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('metrics log tests passed');
}

try {
  main();
} catch (error) {
  try { clearMetrics(); } catch { /* 清理失败不应掩盖真正的测试失败 */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error.stack || error.message);
  process.exitCode = 1;
}