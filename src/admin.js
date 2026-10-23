const $ = id => document.getElementById(id);
let token = '';
let session = 0;
let timer;
let probeController;
let connected = false;
let requests = new Map();
const phases = { reading_request: '接收请求', waiting_headers: '等待上游响应头', buffering_json: '接收完整 JSON', sending_json: '返回 JSON', sse: '转发 SSE', passthrough: '直接透传', done: '完成' };
const names = { request_received: '收到请求', upstream_request: '已转发上游', heartbeat_started: '首个心跳已发出', upstream_headers: '收到上游响应头', late_upstream_status: '上游状态码晚到', relay_error: '中转错误', request_finished: '请求结束' };
const reasons = { reading_request: '尚在接收请求', enabled: '已启用', disabled: '配置关闭', method: 'HEAD / OPTIONS', range: 'Range 请求', bypass_header: '请求头关闭', path_excluded: '路径未匹配', web_resource: '网页 / 静态资源', upstream_format: '上游格式直接透传' };
const seconds = ms => `${(ms / 1000).toFixed(1)} 秒`;
const shown = value => value ?? '—';

function status(message, kind = '') {
  $('status').textContent = message;
  $('status').className = kind;
}

function table(id, rows, width) {
  const parent = $(id);
  parent.replaceChildren();
  if (!rows.length) {
    const row = parent.insertRow();
    const cell = row.insertCell();
    cell.colSpan = width;
    cell.textContent = '暂无记录';
    return;
  }
  for (const cells of rows) {
    const row = parent.insertRow();
    for (const value of cells) {
      const cell = row.insertCell();
      // Values include untrusted upstream paths; always render as plain text.
      cell.textContent = String(shown(value));
      cell.title = String(shown(value));
      cell.className = 'path';
    }
  }
}

function render(data) {
  const summary = $('summary');
  summary.hidden = false;
  summary.replaceChildren();
  for (const [label, value] of [ ['版本', data.version], ['活动请求', data.active.length], ['累计请求', data.total_requests], ['心跳间隔', seconds(data.heartbeat_interval_ms)], ['首个心跳', seconds(data.first_heartbeat_ms)] ]) {
    const card = document.createElement('div');
    card.className = 'card';
    const strong = document.createElement('span');
    strong.className = 'value';
    strong.textContent = String(value);
    card.append(document.createTextNode(label), strong);
    summary.append(card);
  }
  $('target').textContent = `目标域名：${data.target_origin} · 当前实例运行 ${data.uptime_seconds} 秒`;
  table('active', data.active.map(e => [ e.request_id, `${e.method} ${e.path}`, phases[e.phase] || e.phase, seconds(e.elapsed_ms), e.heartbeats, e.upstream_status, reasons[e.heartbeat_reason] || e.heartbeat_reason ]), 7);
  table('events', data.events.map(e => [ new Date(e.time).toLocaleTimeString(), e.request_id, names[e.event] || e.event, `${e.method} ${e.path}`, phases[e.phase] || e.phase, seconds(e.elapsed_ms), e.heartbeats, `${shown(e.upstream_status)} / ${shown(e.downstream_status)}`, e.code || e.outcome || reasons[e.heartbeat_reason] || e.heartbeat_reason ]), 9);
  const selection = $('request-select').value;
  requests = new Map();
  for (const record of [...data.active, ...data.events]) if (!requests.has(record.request_id)) requests.set(record.request_id, record);
  $('request-select').replaceChildren();
  for (const record of requests.values()) {
    const option = document.createElement('option');
    option.value = record.request_id;
    option.textContent = `${record.request_id.slice(0, 8)} · ${record.method} ${record.path}`;
    $('request-select').append(option);
  }
  if (requests.has(selection)) $('request-select').value = selection;
  showRequest();
}

function showRequest() {
  const record = requests.get($('request-select').value);
  if (!record) { $('request-detail').textContent = '暂无请求记录。'; return; }
  const list = values => values === null ? '尚未转发' : values?.join(', ') || '无';
  const sameOrigin = value => value === null ? '未携带' : value ? '是' : '否（请核对目标站来源校验）';
  $('request-detail').textContent = [
    `请求 ID：${record.request_id}`,
    `正文长度：${record.request_body_bytes === null ? '尚在接收' : record.request_body_bytes + ' 字节'}`,
    `正文已提交给上游连接：${record.request_body_sent ? '是' : '否 / 尚未完成'}（不代表上游已成功处理）`,
    `收到的请求头：${list(record.received_header_names)}`,
    `交给上游的请求头：${list(record.forwarded_header_names)}`,
    `值被调整的请求头：${list(record.changed_header_names)}`,
    `移除的请求头：${list(record.removed_header_names)}`,
    `新增的请求头：${list(record.added_header_names)}`,
    `Origin 与目标站同源：${sameOrigin(record.origin_matches_target)}`,
    `Referer 与目标站同源：${sameOrigin(record.referer_matches_target)}`,
  ].join('\n');
}
$('request-select').addEventListener('change', showRequest);

async function refresh(current) {
  try {
    const response = await fetch('/__proxy/status', { headers: { 'X-Admin-Token': token }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (current !== session) return;
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    connected = true;
    render(data);
    status(`已连接 · ${new Date().toLocaleTimeString()} 更新`, 'good');
    $('disconnect').disabled = false;
    $('probe-short').disabled = Boolean(probeController);
    $('probe-long').disabled = Boolean(probeController);
    timer = setTimeout(() => refresh(current), 2000);
  } catch (error) {
    if (current !== session) return;
    connected = false;
    status(error.message, 'error');
    $('probe-short').disabled = true;
    $('probe-long').disabled = true;
    // Retry network interruptions; auth/config errors need an explicit reconnect.
    if (error.name === 'TypeError' || error.name === 'TimeoutError') timer = setTimeout(() => refresh(current), 5000);
  }
}

$('connect').addEventListener('click', () => {
  const current = ++session;
  connected = false;
  clearTimeout(timer);
  probeController?.abort();
  token = $('token').value || token;
  $('token').value = '';
  if (!token) { status('请输入 ADMIN_TOKEN。', 'error'); return; }
  status('正在连接…');
  void refresh(current);
});
$('disconnect').addEventListener('click', () => {
  session++;
  connected = false;
  clearTimeout(timer);
  probeController?.abort();
  token = '';
  $('token').value = '';
  $('disconnect').disabled = true;
  $('probe-short').disabled = true;
  $('probe-long').disabled = true;
  $('summary').replaceChildren();
  $('summary').hidden = true;
  $('target').textContent = '';
  table('active', [], 7);
  table('events', [], 9);
  requests.clear();
  $('request-select').replaceChildren();
  showRequest();
  status('已断开。');
});
$('token').addEventListener('keydown', event => { if (event.key === 'Enter') $('connect').click(); });

async function runProbe(duration) {
  const controller = new AbortController();
  probeController = controller;
  $('probe-short').disabled = true;
  $('probe-long').disabled = true;
  $('probe-stop').disabled = false;
  const began = performance.now();
  let first;
  let last = began;
  let maximum = 0;
  let chunks = 0;
  let size = 0;
  let raw = '';
  const show = result => {
    $('probe-result').textContent = `${result}\n首字节：${first === undefined ? '等待中' : seconds(first)} · 最大接收间隔：${seconds(maximum)} · 收到数据块：${chunks} · 字节：${size}`;
  };
  show(`正在测试 ${duration} 秒…`);
  try {
    const response = await fetch(`/__proxy/probe?seconds=${duration}`, { headers: { 'X-Admin-Token': token }, cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = performance.now();
      if (first === undefined) first = now - began;
      maximum = Math.max(maximum, now - last);
      last = now;
      size += value.length;
      chunks++;
      raw += decoder.decode(value, { stream: true });
      show(`正在测试，已等待 ${seconds(now - began)}…`);
    }
    raw += decoder.decode();
    const result = JSON.parse(raw);
    if (!result.ok || !result.probe) throw new Error('未收到有效的诊断结果');
    show(`测试完成：服务端发送 ${result.heartbeats} 次心跳。请结合首字节和最大接收间隔判断是否存在缓冲。`);
  } catch (error) {
    show(error.name === 'AbortError' ? '测试已停止。' : `测试失败：${error.message}`);
  } finally {
    if (probeController === controller) {
      probeController = undefined;
      $('probe-stop').disabled = true;
      $('probe-short').disabled = !connected;
      $('probe-long').disabled = !connected;
    }
  }
}
$('probe-short').addEventListener('click', () => { void runProbe(10); });
$('probe-long').addEventListener('click', () => { void runProbe(135); });
$('probe-stop').addEventListener('click', () => probeController?.abort());
