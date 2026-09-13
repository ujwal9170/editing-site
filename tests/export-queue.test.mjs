import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExportQueue } from '../lib/exportQueue.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('exports use immutable snapshots and execute strictly serially', async () => {
  const started = [], release = [];
  const queue = createExportQueue(async task => { started.push(task.project.name); await new Promise(r => release.push(r)); return task.project.name; });
  const task = { project: { name: 'First' }, quality: '720p' };
  queue.add(task);
  task.project.name = 'Changed later';
  queue.add({ project: { name: 'Second' }, quality: '1080p' });
  assert.deepEqual(started, ['First']);
  release.shift()(); await tick();
  assert.deepEqual(started, ['First', 'Second']);
  release.shift()(); await tick();
  assert.deepEqual(queue.list().map(r => r.result), ['First', 'Second']);
});
test('cancel queued work and terminate current work before starting next', async () => {
  const started = [];
  const queue = createExportQueue(async (task, { signal }) => {
    started.push(task.project.name);
    if (task.project.name === 'First') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  });
  const first = queue.add({ project: { name: 'First' } });
  const second = queue.add({ project: { name: 'Second' } });
  queue.add({ project: { name: 'Third' } });
  queue.cancel(second); queue.cancel(first); await tick();
  assert.deepEqual(started, ['First', 'Third']);
  assert.deepEqual(queue.list().map(r => r.status), ['cancelled', 'cancelled', 'done']);
});
test('failure does not block next job and saving cannot be cancelled', async () => {
  let finish;
  const queue = createExportQueue(async (task, control) => {
    if (task.project.name === 'Broken') throw new Error('Unsupported codec');
    control.saving(); await new Promise(r => finish = r);
  });
  queue.add({ project: { name: 'Broken' } });
  const id = queue.add({ project: { name: 'Good' } });
  await tick();
  assert.equal(queue.list()[0].status, 'failed');
  assert.equal(queue.cancel(id), false);
  finish(); await tick();
  assert.equal(queue.list()[1].status, 'done');
});
test('sign-out clears tasks and prevents old work starting queued tasks', async () => {
  let count = 0;
  const queue = createExportQueue(async (_, { signal }) => {
    count++;
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  });
  queue.add({ project: { name: 'One' } }); queue.add({ project: { name: 'Two' } });
  queue.clear(); await tick();
  assert.equal(count, 1); assert.deepEqual(queue.list(), []);
});
