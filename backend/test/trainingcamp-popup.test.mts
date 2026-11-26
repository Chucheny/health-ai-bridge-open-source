import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { collectTrainingCampInPage } from '../../tools/trainingcamp-browser/collect-sleep.mjs';

// Exercise actual event wiring without a browser session, real health values or extension installation.
async function popup() {
  const elements = new Map<string, any>();
  for (const id of ['kind', 'start', 'end', 'confirm', 'collect', 'save', 'status', 'collect-form']) {
    const listeners = new Map<string, any>();
    elements.set(id, { value: '', checked: false, disabled: id === 'save', textContent: '',
      addEventListener: (name: string, fn: any) => listeners.set(name, fn),
      emit: (name: string) => listeners.get(name)?.({ preventDefault() {} }) });
  }
  const e = (id: string) => elements.get(id);
  const calls: any[] = [], downloads: any[] = [], blobs: Blob[] = [];
  let tabs = 0, result: any = { ok: true, capture: { schemaVersion: 1, kind: 'activity' }, sourceRecords: 20 };
  let pending: Promise<any> | undefined;
  class PopupUrl extends URL {
    static createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:synthetic-only'; }
    static revokeObjectURL(_url: string) {}
  }
  const source = (await readFile(new URL('../../tools/trainingcamp-browser/popup.mjs', import.meta.url), 'utf8'))
    .replace(/^import \{ collectTrainingCampInPage \} from '\.\/collect-sleep\.mjs';\r?\n/, '');
  runInNewContext(source, { collectTrainingCampInPage, URL: PopupUrl, Blob, JSON, Object, Error,
    setTimeout: (fn: () => void) => { fn(); return 0; },
    document: { querySelector: (selector: string) => e(selector.slice(1)), createElement: () => {
      const link: any = { click() { downloads.push({ href: link.href, filename: link.download }); } }; return link;
    } },
    chrome: { tabs: { query: async () => { tabs++; return [{ id: 1, url: 'https://health.cloud.huawei.com/TrainingCamp#/' }]; } },
      scripting: { executeScript: async (call: any) => { calls.push(call); return [{ result: await (pending ?? result) }]; } } } });
  return { e, calls, downloads, blobs, tabCount: () => tabs,
    setResult: (value: any) => { result = value; pending = undefined; }, setPending: (value: Promise<any>) => { pending = value; } };
}

test('popup requires explicit category and renewed confirmation, locks inputs during reading and saves only the chosen capture', async () => {
  const p = await popup();
  await p.e('collect-form').emit('submit'); assert.equal(p.tabCount(), 0);
  p.e('kind').value = 'activity'; p.e('start').value = '2026-01-02'; p.e('end').value = '2026-01-02';
  p.e('confirm').checked = true;
  let finish: (value: any) => void = () => {};
  p.setPending(new Promise(resolve => { finish = resolve; }));
  const reading = p.e('collect-form').emit('submit');
  for (const id of ['kind', 'start', 'end', 'confirm', 'collect']) assert.equal(p.e(id).disabled, true);
  finish({ ok: true, capture: { schemaVersion: 1, kind: 'activity' }, sourceRecords: 20 }); await reading;
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].world, 'MAIN');
  assert.equal(p.calls[0].func, collectTrainingCampInPage);
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls[0].args)), [{ kind: 'activity', startDay: '2026-01-02', endDay: '2026-01-02' }]);
  assert.equal(p.e('save').disabled, false); assert.match(p.e('status').textContent, /未翻页，完整性未知/);
  for (const id of ['kind', 'start', 'end', 'confirm', 'collect']) assert.equal(p.e(id).disabled, false);
  p.e('save').emit('click'); assert.equal(p.downloads.length, 1);
  assert.equal(p.downloads[0].filename, 'health-ai-bridge-trainingcamp-activity_2026-01-02_2026-01-02.json');
  assert.equal(JSON.parse(await p.blobs[0].text()).kind, 'activity');
  p.e('kind').value = 'sleep'; p.e('kind').emit('change');
  assert.equal(p.e('confirm').checked, false); assert.equal(p.e('save').disabled, true);
  p.e('save').emit('click'); assert.equal(p.downloads.length, 1, 'changing kind cannot save an old activity capture');
  await p.e('collect-form').emit('submit'); assert.equal(p.calls.length, 1, 'old confirmation cannot authorize a changed category');
  p.setResult({ ok: true, capture: { schemaVersion: 1, kind: 'sleep' }, sourceRecords: 1 });
  p.e('confirm').checked = true; await p.e('collect-form').emit('submit'); p.e('save').emit('click');
  assert.equal(p.downloads[1].filename, 'health-ai-bridge-trainingcamp-sleep_2026-01-02_2026-01-02.json');
  assert.match(p.e('status').textContent, /原工作台/);
});

test('popup invalidates old exports on changed dates, unchecked confirmation and failed re-reads without exposing errors', async () => {
  const p = await popup();
  p.e('kind').value = 'activity'; p.e('start').value = p.e('end').value = '2026-01-02';
  for (const change of ['start', 'end', 'confirm']) {
    p.setResult({ ok: true, capture: { kind: 'activity' }, sourceRecords: 0 });
    p.e('confirm').checked = true; await p.e('collect-form').emit('submit');
    p.e(change).emit('change'); assert.equal(p.e('save').disabled, true);
    p.e('save').emit('click'); assert.equal(p.downloads.length, 0);
  }
  p.e('confirm').checked = true;
  p.setResult({ ok: false, code: 'synthetic-private-error' }); await p.e('collect-form').emit('submit');
  assert.equal(p.e('save').disabled, true); assert(!p.e('status').textContent.includes('synthetic-private-error'));
  p.e('save').emit('click'); assert.equal(p.downloads.length, 0);
});

test('popup explicitly requests bounded activity scroll and saves a distinct local capture', async () => {
  const p = await popup();
  p.e('kind').value = 'activity-scroll';
  p.e('start').value = p.e('end').value = '2026-01-02';
  p.e('confirm').checked = true;
  p.setResult({ ok: true, sourceRecords: 26, capture: { kind: 'activity', captureScope: 'bounded_scroll', pages: [{}, {}] } });
  await p.e('collect-form').emit('submit');
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls[0].args)),
    [{ kind: 'activity', startDay: '2026-01-02', endDay: '2026-01-02', scroll: true }]);
  assert.match(p.e('status').textContent, /2 页、26 条.*完整性未知/);
  p.e('save').emit('click');
  assert.equal(p.downloads[0].filename, 'health-ai-bridge-trainingcamp-activity-scroll_2026-01-02_2026-01-02.json');
  assert.equal(JSON.parse(await p.blobs[0].text()).captureScope, 'bounded_scroll');
});
