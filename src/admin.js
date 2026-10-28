const $ = id => document.getElementById(id);
let token = '';
let session = 0;
let timer;
let refreshController;
let probeController;
let connected = false;
let keepaliveSettings = null;
let keepaliveController;
let requests = new Map();
let eventStream = '', eventCursor = 0, recentEvents = [];
const phases = { reading_request: '接收请求', classifying_request: '识别响应类型', waiting_headers: '等待上游响应头', buffering_json: '接收完整 JSON', sending_json: '返回 JSON', sse: '转发 SSE', passthrough: '直接透传', done: '完成' };
const names = { request_received: '收到请求', upstream_request: '已转发上游', heartbeat_started: '首个心跳已发出', upstream_headers: '收到上游响应头', late_upstream_status: '上游状态码晚到', relay_error: '中转错误', request_finished: '请求结束' };
const reasons = { reading_request: '尚在接收请求', enabled: '已启用', disabled: '配置关闭', route_disabled: '路由关闭', method: 'HEAD / OPTIONS', range: 'Range 请求', bypass_header: '请求头关闭', path_excluded: '路径未匹配', web_resource: '网页 / 静态资源', upstream_format: '上游格式直接透传' };
const seconds = ms => `${(ms / 1000).toFixed(1)} 秒`;
const shown = value => value ?? '—';
const mib = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

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
  if (data.event_stream_id) {
    const reset = data.events_reset || data.event_stream_id !== eventStream;
    recentEvents = (reset ? data.events : [...data.events, ...recentEvents]).slice(0, 200);
    eventStream = data.event_stream_id; eventCursor = data.event_cursor;
    data = { ...data, events: recentEvents };
  }
  renderKeepaliveStatus(data.keepalive);
  const summary = $('summary');
  summary.hidden = false;
  summary.replaceChildren();
  const cards = [ ['版本', data.version], ['活动请求', data.active.length], ['累计请求', data.total_requests], ['心跳间隔', seconds(data.heartbeat_interval_ms)], ['首个心跳', seconds(data.first_heartbeat_ms)] ];
  if (data.resources) {
    cards.push(['请求内存 / 上限', `${mib(data.resources.buffered_request_bytes)} / ${mib(data.resources.max_buffered_request_bytes)}`]);
    cards.push(['响应暂存 / 上限', `${mib(data.resources.buffered_response_bytes)} / ${mib(data.resources.max_buffered_response_bytes)}`]);
    cards.push(['SSE 缓冲 / 上限', `${mib(data.resources.buffered_sse_bytes)} / ${mib(data.resources.max_buffered_sse_bytes)}`]);
  }
  if (data.metrics) {
    cards.push(['进程 RSS', data.metrics.memory.rss_bytes === null ? '当前环境不可读' : mib(data.metrics.memory.rss_bytes)]);
    cards.push(['JS 堆', mib(data.metrics.memory.heap_used_bytes)]);
    cards.push(['事件循环 P99', `${data.metrics.event_loop.p99_ms.toFixed(1)} 毫秒`]);
    cards.push(['中转错误累计', data.metrics.outcomes.relay_error || 0]);
  }
  if (data.resources?.temporary_storage) {
    const storage = data.resources.temporary_storage;
    cards.push(['待清理文件预算', mib(storage.pending_cleanup_bytes)]);
    cards.push(['暂存磁盘可用', storage.free_bytes === null ? '尚未检查' : mib(storage.free_bytes)]);
  }
  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'card';
    const strong = document.createElement('span');
    strong.className = 'value';
    strong.textContent = String(value);
    card.append(document.createTextNode(label), strong);
    summary.append(card);
  }
  $('target').textContent = `目标域名：${data.target_origin} · 当前实例运行 ${data.uptime_seconds} 秒`;
  if (data.management_isolated === false) $('target').textContent += ' · 管理入口与上游网页同域，建议配置 ADMIN_HOSTS 使用独立管理域名。';
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
    `SSE 当前缓冲：${record.buffered_sse_bytes ?? 0} 字节`,
    `复用上游连接：${record.upstream_reused_socket ? '是' : '否'}`,
    `正在等待下游读取：${record.downstream_backpressure ? '是' : '否'}`,
    ...(record.heartbeat_mode ? [`心跳模式：${record.heartbeat_mode}`] : []),
    ...(record.timings_ms ? Object.entries(record.timings_ms).filter(([, value]) => value !== null).map(([name, value]) => `${name}：${value} 毫秒`) : []),
  ].join('\n');
}
$('request-select').addEventListener('change', showRequest);

function renderKeepaliveStatus(data) {
  if (!data) { $('keepalive-result').textContent = '未配置部署保活'; return; }
  const state = !data.configured ? '未配置' : data.running ? (data.in_flight ? '正在请求' : '运行中') : '已停止';
  const last = data.last_attempt_at ? new Date(data.last_attempt_at).toLocaleTimeString() : '尚未请求';
  $('keepalive-result').textContent = `${state} · 间隔 ${data.interval_seconds} 秒 · 请求次数 ${data.attempts} · 最近请求 ${last} · HTTP ${shown(data.last_status)}${data.last_error_code ? ' · ' + data.last_error_code : ''}`;
}

function keepaliveControls() {
  const ready = connected && keepaliveSettings && !keepaliveController;
  $('keepalive-url').disabled = !ready;
  $('keepalive-interval').disabled = !ready;
  $('keepalive-url').readOnly = Boolean(keepaliveSettings?.locked.url);
  $('keepalive-interval').readOnly = Boolean(keepaliveSettings?.locked.interval);
  $('keepalive-current').disabled = !ready || Boolean(keepaliveSettings?.locked.url);
  $('keepalive-reload').disabled = !connected || Boolean(keepaliveController);
  $('keepalive-save').disabled = !ready || Boolean(keepaliveSettings?.locked.url && keepaliveSettings?.locked.interval);
}

function resetKeepalive() {
  keepaliveController?.abort();
  keepaliveController = undefined;
  keepaliveSettings = null;
  $('keepalive-url').value = '';
  $('keepalive-interval').value = '60';
  $('keepalive-result').textContent = '尚未连接';
  $('keepalive-config-status').textContent = '面板设置仅对当前实例有效；重启后请通过环境变量 KEEPALIVE_URL、KEEPALIVE_INTERVAL 保留配置。';
  keepaliveControls();
}

async function keepaliveRequest(current, value) {
  const controller = new AbortController();
  keepaliveController = controller;
  keepaliveControls();
  try {
    const response = await fetch('/__proxy/keepalive', {
      method: value ? 'PUT' : 'GET',
      headers: { 'X-Admin-Token': token, ...(value ? { 'Content-Type': 'application/json' } : {}) },
      ...(value ? { body: JSON.stringify({ ...value, ...(keepaliveSettings?.revision ? { expected_revision: keepaliveSettings.revision } : {}) }) } : {}),
      cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    const data = await response.json();
    if (current !== session) return;
    if (!response.ok) throw new Error(response.status === 412 ? '配置已在其他会话更新，请点击“重新读取配置”后再保存。' : data.error || `HTTP ${response.status}`);
    keepaliveSettings = data;
    $('keepalive-url').value = data.url;
    $('keepalive-interval').value = String(data.interval_seconds);
    renderKeepaliveStatus(data.status);
    const locked = [data.locked.url && 'KEEPALIVE_URL', data.locked.interval && 'KEEPALIVE_INTERVAL'].filter(Boolean);
    $('keepalive-config-status').textContent = locked.length
      ? `环境变量托管：${locked.join('、')}；修改对应字段需编辑环境变量并重启。`
      : value ? '已保存并应用。仅对当前实例生效，重启后请通过环境变量保留配置。' : '可设置保活 URL。面板保存仅对当前实例生效。';
  } catch (error) {
    if (current === session) $('keepalive-config-status').textContent = `保活配置失败：${error.message}`;
  } finally {
    if (keepaliveController === controller) keepaliveController = undefined;
    keepaliveControls();
  }
}

$('keepalive-current').addEventListener('click', () => {
  $('keepalive-url').value = `${location.origin}/keepalive`;
});
$('keepalive-reload').addEventListener('click', () => {
  if (connected && !keepaliveController) void keepaliveRequest(session);
});
$('keepalive-save').addEventListener('click', () => {
  if (!connected || !keepaliveSettings || keepaliveController) return;
  void keepaliveRequest(session, { url: $('keepalive-url').value, interval_seconds: Number($('keepalive-interval').value) });
});

async function refresh(current) {
  const controller = new AbortController();
  refreshController = controller;
  try {
    const path = eventStream ? `/__proxy/status?since=${eventCursor}&stream=${encodeURIComponent(eventStream)}` : '/__proxy/status';
    const response = await fetch(path, { headers: { 'X-Admin-Token': token }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    const data = await response.json();
    if (current !== session) return;
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const draining = Boolean(data.resources?.draining);
    connected = !draining;
    render(data);
    status(draining ? '实例正在退出，已停止接受新的转发和测试请求。' : `已连接 · ${new Date().toLocaleTimeString()} 更新`, draining ? 'error' : 'good');
    $('disconnect').disabled = false;
    $('probe-short').disabled = Boolean(probeController) || draining;
    $('probe-long').disabled = Boolean(probeController) || draining;
    keepaliveControls();
    if (connected && !keepaliveSettings && !keepaliveController) void keepaliveRequest(current);
    timer = setTimeout(() => refresh(current), document.hidden ? 30000 : 2000);
  } catch (error) {
    if (current !== session) return;
    connected = false;
    keepaliveControls();
    status(error.message, 'error');
    $('probe-short').disabled = true;
    $('probe-long').disabled = true;
    // Retry network interruptions; auth/config errors need an explicit reconnect.
    if (error.name === 'TypeError' || error.name === 'TimeoutError') timer = setTimeout(() => refresh(current), document.hidden ? 30000 : 5000);
  } finally {
    if (refreshController === controller) refreshController = undefined;
  }
}

$('connect').addEventListener('click', () => {
  const current = ++session;
  connected = false;
  eventStream = ''; eventCursor = 0; recentEvents = [];
  resetKeepalive();
  clearTimeout(timer);
  refreshController?.abort();
  probeController?.abort();
  $('probe-short').disabled = true;
  $('probe-long').disabled = true;
  token = $('token').value || token;
  $('token').value = '';
  if (!token) { status('请输入 ADMIN_TOKEN。', 'error'); return; }
  $('disconnect').disabled = false;
  status('正在连接…');
  void refresh(current);
});
$('disconnect').addEventListener('click', () => {
  session++;
  connected = false;
  eventStream = ''; eventCursor = 0; recentEvents = [];
  resetKeepalive();
  clearTimeout(timer);
  refreshController?.abort();
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
  $('probe-result').textContent = '已断开，心跳测试已停止。';
  status('已断开。');
});
$('token').addEventListener('keydown', event => { if (event.key === 'Enter') $('connect').click(); });

async function runProbe(duration) {
  if (!connected || probeController) return;
  const current = session;
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
    if (current !== session) return;
    $('probe-result').textContent = `${result}\n首字节：${first === undefined ? '等待中' : seconds(first)} · 最大接收间隔：${seconds(maximum)} · 收到数据块：${chunks} · 字节：${size}`;
  };
  show(`正在测试 ${duration} 秒…`);
  try {
    const response = await fetch(`/__proxy/probe?seconds=${duration}`, { headers: { 'X-Admin-Token': token }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout((duration + 15) * 1000)]) });
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
    if (result.error) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || result.error.code);
    if (!result.ok || !result.probe) throw new Error('未收到有效的诊断结果');
    show(`测试完成：服务端发送 ${result.heartbeats} 次心跳。请结合首字节和最大接收间隔判断是否存在缓冲。`);
  } catch (error) {
    show(error.name === 'AbortError' ? '测试已停止。' : error.name === 'TimeoutError' ? '测试超时，请检查访问链路是否中断或缓冲。' : `测试失败：${error.message}`);
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
document.addEventListener?.('visibilitychange', () => {
  if (!document.hidden && connected && token && !refreshController) {
    clearTimeout(timer);
    void refresh(session);
  }
});
