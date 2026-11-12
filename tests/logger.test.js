'use strict';
// The run log file.
const test = require('node:test');
const assert = require('node:assert/strict');

test('logger: old daily logs are pruned again when the date changes', t => {
  const loggerModule = require('../com.align4.export/js/logger');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align4-test-prune-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let now = new Date(2026, 0, 10, 23, 59).getTime();
  const log = loggerModule.create({fs, path, dir, now: () => now, keepDays: 7});
  log.info('a', 'first');
  fs.writeFileSync(path.join(dir, 'align4-2026-01-04.log'), 'old');
  now = new Date(2026, 0, 12, 0, 1).getTime(); // two days later, panel never restarted
  log.info('a', 'next day');
  assert.ok(!fs.existsSync(path.join(dir, 'align4-2026-01-04.log')));
  assert.ok(fs.existsSync(path.join(dir, 'align4-2026-01-12.log')));
});
