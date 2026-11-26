import { collectTrainingCampInPage } from './collect-sleep.mjs';

const start = document.querySelector('#start'), end = document.querySelector('#end');
const kind = document.querySelector('#kind'), confirmation = document.querySelector('#confirm');
const collect = document.querySelector('#collect'), save = document.querySelector('#save');
const status = document.querySelector('#status');
let capture = null, filename = '';
const inputs = [kind, start, end, confirmation];
const messages = {
  wrong_page: '请先打开并登录华为训练营网页，再点击本助手。',
  invalid_dates: '请选择有效的起止日期，范围不能超过 31 天。',
  invalid_kind: '请明确选择睡眠或运动，并勾选本机读取确认。',
  login_required: '当前页面未登录或登录已过期。请在华为网页自行登录后再试。',
  login_or_permission_required: '华为拒绝了本次读取。请核对登录和已有授权；本助手已停止。',
  page_changed: '华为页面结构已变化，已停止读取。请等待适配更新。',
  request_failed: '请求未完成，可能是网络或浏览器限制。没有自动重试。',
  rate_limited: '华为暂时限制请求频率。已停止，请稍后再试。',
  http_error: '华为没有成功返回数据，本次读取已停止。',
  unexpected_response: '响应结构与预期不符，未生成采集文件。',
  response_too_large: '响应超过本机单次限制，未生成采集文件。请缩小日期范围。',
  response_outside_window_or_invalid: '响应包含日期边界异常或无效记录，已整份拒绝保存。',
  activity_scroll_stalled: '运动翻页顺序异常或时间边界未推进，未生成采集文件。可缩小日期范围后重试。',
  collection_failed: '本次采集未完成，未生成文件。',
};
for (const input of inputs) input.addEventListener('change', () => {
  capture = null; filename = ''; save.disabled = true;
  if (input !== confirmation) confirmation.checked = false;
  status.textContent = confirmation.checked ? '请点击读取所选类别和日期；结果仅留本机。' : '选择已改变，请核对类别和日期并重新勾选确认。';
});
document.querySelector('#collect-form').addEventListener('submit', async event => {
  event.preventDefault(); capture = null; filename = ''; save.disabled = true; collect.disabled = true;
  for (const input of inputs) input.disabled = true;
  const scroll = kind.value === 'activity-scroll';
  const selected = { kind: scroll ? 'activity' : kind.value, startDay: start.value, endDay: end.value,
    ...(scroll ? { scroll: true } : {}) };
  status.textContent = '正在读取所选日期，请保持此窗口打开…';
  try {
    if (!['sleep', 'activity'].includes(selected.kind) || !confirmation.checked) throw new Error('invalid_kind');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || 'about:blank');
    if (!tab?.id || url.origin !== 'https://health.cloud.huawei.com' || url.pathname !== '/TrainingCamp') {
      throw new Error('wrong_page');
    }
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN',
      func: collectTrainingCampInPage, args: [selected] });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.code || 'collection_failed');
    capture = result.capture;
    filename = `health-ai-bridge-trainingcamp-${selected.kind}${scroll ? '-scroll' : ''}_${selected.startDay}_${selected.endDay}.json`;
    if (scroll) {
      status.textContent = `已读取运动 ${capture.pages.length} 页、${result.sourceRecords} 条记录（最多5页）。完整性未知。尚未保存或上传。`;
    } else if (selected.kind === 'sleep') {
      status.textContent = `已读取 ${result.sourceRecords} 条来源记录。记录数不等于睡眠晚数；完整性未知。尚未保存或上传。`;
    } else {
      status.textContent = `已读取运动首批 ${result.sourceRecords} 条记录（最多20条）。未翻页，完整性未知；请勿当作全期运动。尚未保存或上传。`;
    }
    save.disabled = false;
  } catch (error) {
    status.textContent = Object.hasOwn(messages, error?.message) ? messages[error.message] : messages.collection_failed;
  } finally { collect.disabled = false; for (const input of inputs) input.disabled = false; }
});
save.addEventListener('click', () => {
  if (!capture) return;
  const blob = new Blob([JSON.stringify(capture, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  status.textContent = '已交给浏览器保存到本机。文件含个人健康数据，请勿放入代码仓库。可在原工作台选择对应类别和日期进行离线预检；上传需另行确认。';
});
