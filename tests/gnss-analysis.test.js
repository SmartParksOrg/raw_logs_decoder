const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const {
  collectAttempts, classifyFailure, filterAttempts, summarizeAttempts, aggregateHourly, exportHourlyCSV, exportFailuresCSV
} = require('../gnss-analysis.js');

const row = (success, timestamp='2026-10-01T04:00:00Z', data={}) => ({
  port:2, source_port:29, timestamp_utc:timestamp, dataObj:{ success, ...data }
});

test('page uses a content-specific GNSS URL so cached scripts cannot target removed controls', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const script = fs.readFileSync(require.resolve('../gnss-analysis.js'));
  const hash = createHash('sha256').update(script).digest('hex').slice(0, 12);
  assert.ok(html.includes(`<script src="./gnss-analysis.js?v=${hash}"></script>`),
    'Update the GNSS script cache key in index.html when its content changes');
});

test('counts full attempts, including failed zero coordinates; excludes short fixes and resends', () => {
  const rows = [row(1), row(0, undefined, { latitude:0, longitude:0 }),
    ...[1, 4, 13, 16, 31].map(port => ({ ...row(1), port }))];
  const summary = summarizeAttempts(collectAttempts(rows));
  assert.equal(summary.attempts, 2);
  assert.equal(summary.successful, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.successRate, 50);
});

test('unknown outcomes never become failures or dilute success rates', () => {
  const attempts = collectAttempts([row(1), row(0), ...[undefined, null, '', ' ', 2, -1, 'invalid'].map(value => row(value))]);
  const summary = summarizeAttempts(attempts);
  assert.equal(summary.unknown, 7);
  assert.equal(summary.successRate, 50);
  assert.equal(summarizeAttempts(collectAttempts([row(null)])).successRate, null);
});

test('success flags accept boolean and text TRUE/FALSE without interpreting missing values as false', () => {
  const summary = summarizeAttempts(collectAttempts([true, false, ' TRUE ', 'FALSE', '1', '0', null].map(value => row(value))));
  assert.equal(summary.successful, 3);
  assert.equal(summary.failed, 3);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.successRate, 50);
});

test('short failures use separate inferred hot/cold timeouts; SIV zero is context, not the trigger', () => {
  const settings = { hotTimeout:30, coldTimeout:200, shortLimit:35 };
  const attempts = collectAttempts([
    row(false, undefined, { ttf:32, hot_retry:1, cold_retry:0, SIV:0 }),
    row(false, undefined, { ttf:32, hot_retry:5, cold_retry:1, SIV:2 }),
    row(false, undefined, { ttf:25, hot_retry:1, cold_retry:0, SIV:0 }),
    row(true, undefined, { ttf:10, hot_retry:0, cold_retry:0, SIV:0 }),
    row(false, undefined, { ttf:200, cold_retry:1, SIV:0 })
  ]);
  assert.equal(classifyFailure(attempts[0], settings).category, 'other');
  assert.equal(classifyFailure(attempts[1], settings).mode, 'cold');
  assert.equal(classifyFailure(attempts[1], settings).category, 'early');
  assert.equal(classifyFailure(attempts[2], settings).category, 'early');
  assert.equal(classifyFailure(attempts[3], settings), null);
  assert.equal(classifyFailure(attempts[4], settings).category, 'other');
  const summary = summarizeAttempts(attempts, settings);
  assert.equal(summary.earlyStops, 2);
  assert.equal(summary.earlyZeroSiv, 1);
  assert.equal(summary.failed, 4);
  assert.equal(summary.otherFailed, 2);
  assert.equal(summary.successRate, 20);
  assert.equal(aggregateHourly(attempts, 'utc', settings)[4].earlyStops, 2);
});

test('unknown mode compares against both timeouts conservatively, and missing settings remain unconfirmed', () => {
  const attempt = collectAttempts([row(false, undefined, { ttf:32, SIV:0 })])[0];
  assert.equal(classifyFailure(attempt, { hotTimeout:65, coldTimeout:200, shortLimit:35 }).category, 'early');
  assert.equal(classifyFailure(attempt, { hotTimeout:30, coldTimeout:200, shortLimit:35 }).category, 'other');
  assert.equal(classifyFailure(attempt, { hotTimeout:null, coldTimeout:200, shortLimit:35 }).category, 'short');
  assert.equal(classifyFailure({ ...attempt, hotRetry:1 }, { hotTimeout:65, coldTimeout:null, shortLimit:35 }).category, 'early');
  assert.equal(classifyFailure(attempt, { hotTimeout:65, coldTimeout:200, shortLimit:null }).category, 'unassessed');
});

test('zero/missing TTF and active tracking do not masquerade as early stops', () => {
  const attempts = collectAttempts([
    ...[0, null, undefined, '', -1].map(ttf => row(false, undefined, { ttf, SIV:0 })),
    ...[1, true, 'TRUE'].map(active_t => row(false, undefined, { ttf:10, active_t, SIV:0 }))
  ]);
  const summary = summarizeAttempts(attempts);
  assert.equal(summary.failed, 8);
  assert.equal(summary.earlyStops, 0);
  assert.equal(summary.unassessedFailures, 8);
});

test('short-window and timeout-margin boundaries are inclusive and react to changed settings', () => {
  const attempts = collectAttempts([25, 26, 35, 36].map(ttf => row(false, undefined, { ttf, hot_retry:1 })));
  assert.equal(summarizeAttempts(attempts, { hotTimeout:30, coldTimeout:200, shortLimit:35 }).earlyStops, 1);
  assert.equal(summarizeAttempts(attempts, { hotTimeout:65, coldTimeout:200, shortLimit:35 }).earlyStops, 3);
  assert.equal(summarizeAttempts(attempts, { hotTimeout:65, coldTimeout:200, shortLimit:20 }).earlyStops, 0);
});

test('exports retain failure criteria and evidence for reproducible assessments', () => {
  const settings = { hotTimeout:80, coldTimeout:240, shortLimit:40 };
  const attempts = collectAttempts([row(false, undefined, { ttf:35, hot_retry:1, SIV:0 })]);
  const hourlyCsv = exportHourlyCSV(aggregateHourly(attempts, 'utc', settings), 'UTC', settings);
  assert.ok(hourlyCsv.includes('"Likely early stops"'));
  assert.ok(hourlyCsv.split('\r\n')[5].endsWith('"80","240","40"'));
  const result = classifyFailure(attempts[0], settings);
  const csv = exportFailuresCSV([{ ...attempts[0], ...result, assessment:'Likely early stop' }], settings);
  assert.ok(csv.includes('"SIV"'));
  assert.ok(csv.includes('"Reference timeout (s)"'));
  assert.ok(csv.includes('"Likely early stop","hot","35","0","80"'));
  assert.ok(csv.endsWith('"80","240","40"'));
});

test('hourly rates are weighted by attempt count, not averaged across days', () => {
  const attempts = collectAttempts([row(1), ...Array.from({ length:9 }, () => row(0, '2026-10-02T04:00:00Z'))]);
  const hourly = aggregateHourly(attempts);
  assert.equal(hourly.length, 24);
  assert.equal(hourly[4].attempts, 10);
  assert.equal(hourly[4].successRate, 10);
  assert.equal(hourly[3].attempts, 0);
  assert.equal(hourly[3].successRate, null);
  assert.equal(aggregateHourly(collectAttempts([row(0)]))[4].successRate, 0);
});

test('flash log time overrides stale fix time; untimed attempts remain in unfiltered totals', () => {
  const attempts = collectAttempts([
    row(0, '2026-10-01T04:00:00Z', { fix_timestamp:1 }),
    row(1, '', { fix_timestamp:Date.parse('2026-10-01T05:00:00Z') / 1000 }),
    row(0, '1970-01-01T00:00:00.000Z', { fix_timestamp:0 }),
    row(1, '', { fix_timestamp:1e100 })
  ]);
  assert.equal(aggregateHourly(attempts)[4].failed, 1);
  assert.equal(aggregateHourly(attempts)[5].successful, 1);
  assert.equal(attempts[2].timestampMs, null);
  assert.equal(attempts[3].timestampMs, null);
  assert.equal(filterAttempts(attempts, null, null).length, 4);
  assert.equal(filterAttempts(attempts, Date.parse('2026-10-01'), null).length, 2);
});

test('TTF and quality use successful fixes; retries use all outcomes and missing values stay missing', () => {
  const attempts = collectAttempts([
    row(1, undefined, { ttf:10, hot_retry:0, cold_retry:2, SIV:8, h_acc_est:12 }),
    row(1, undefined, { ttf:30, hot_retry:2, SIV:10, h_acc_est:8 }),
    row(0, undefined, { ttf:600, hot_retry:4, cold_retry:6, SIV:0, h_acc_est:999 }),
    row(1, undefined, { ttf:'', hot_retry:null, cold_retry:-1, SIV:undefined, h_acc_est:false })
  ]);
  const summary = summarizeAttempts(attempts);
  assert.equal(summary.ttfSamples, 2);
  assert.equal(summary.meanTtf, 20);
  assert.equal(summary.p90Ttf, 30);
  assert.equal(summary.meanHotRetry, 2);
  assert.equal(summary.meanColdRetry, 4);
  assert.equal(summary.meanSatellites, 9);
  assert.equal(summary.meanAccuracy, 10);
  assert.equal(summarizeAttempts(collectAttempts([row(1)])).meanTtf, null);
});

test('time filters include exact boundaries and handle UTC/local hour and DST transitions', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Amsterdam';
  try{
    const attempts = collectAttempts([
      row(1, '2026-10-25T00:30:00Z'), row(0, '2026-10-25T01:30:00Z'),
      row(1, '2026-10-25T01:30:00.500Z'), row(0, '')
    ]);
    const start = Date.parse('2026-10-25T00:30:00Z');
    const end = Date.parse('2026-10-25T01:30:00.500Z');
    assert.equal(filterAttempts(attempts, start, end).length, 3);
    assert.equal(filterAttempts(attempts, end, start).length, 0);
    assert.equal(aggregateHourly(attempts, 'utc')[0].successful, 1);
    assert.equal(aggregateHourly(attempts, 'local')[2].attempts, 3);
    assert.equal(filterAttempts(attempts, end, end).length, 1);
    assert.equal(filterAttempts(attempts, start + 1, end - 1).length, 1);
  } finally {
    if(previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('CSV contains 24 hours with zone, counts, and blank unobserved rates', () => {
  const csv = exportHourlyCSV(aggregateHourly(collectAttempts([row(0)])), 'UTC');
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 25);
  assert.ok(lines[0].includes('"Success rate (%)"'));
  assert.ok(lines[1].startsWith('"UTC","0","0","0","0","0",""'));
  assert.ok(lines[5].startsWith('"UTC","4","1","0","1","0","0"'));
});

test('all built-in decoders feed full direct and bundled attempts into the shared row pipeline', () => {
  // Exercise the real decoder and app normalization functions without a browser.
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const helpers = html.slice(html.indexOf('    function isPlainObject('), html.indexOf('    function buildNumericFieldList('));
  const timestamp = Date.parse('2026-10-01T04:00:00Z') / 1000;
  for(const version of ['6.11.2', '6.14.0', '6.15.1', '7.2.0']){
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(require.resolve(`../ttn_decoder-v${version}.js`), 'utf8') + '\n' + helpers, context);
    const payload = Buffer.alloc(32);
    payload[1] = 30;
    payload[2] = 1;
    payload[3] = 2;
    payload.writeUInt16LE(25, 5);
    payload.writeUInt32LE(timestamp, 24);
    const direct = context.Decoder(Array.from(payload), 2);
    const failed = Buffer.from(payload);
    failed[2] = 0;
    failed.writeUInt32LE(0, 24);
    const logTime = Buffer.alloc(4);
    logTime.writeUInt32LE(timestamp);
    const bundled = context.Decoder(Array.from(Buffer.concat([Buffer.from([2]), failed, logTime])), 29);
    const messages = context.buildMessageRowsFromDecoded([
      { port:2, timestamp, decodedData:direct }, { port:29, decodedData:bundled }
    ]);
    const summary = summarizeAttempts(collectAttempts(messages));
    assert.equal(summary.attempts, 2, version);
    assert.equal(summary.successRate, 50, version);
    assert.equal(summary.meanTtf, 25, version);
    assert.equal(aggregateHourly(collectAttempts(messages))[4].attempts, 2, version);
  }
});
