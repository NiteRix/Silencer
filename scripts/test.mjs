/*
 * Exercises the two pieces of Silencer that are pure arithmetic: the silence
 * detector, and the host-side maths that decides where clips end up.
 * Neither needs Premiere, so both can be checked on every push.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Values crossing a vm context keep that context's prototypes, so deepEqual
// would reject them on identity alone. Round-trip them into this realm first.
const plain = (v) => JSON.parse(JSON.stringify(v));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); passed++; }
  catch (err) { console.error(`FAIL ${name}\n     ${err.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); passed++; }
  catch (err) { console.error(`FAIL ${name}\n     ${err.message}`); failed++; }
}

/* ------------------------------------------------------- host-side maths */

const hostSandbox = {
  $: {}, JSON, Math, Number, String, Array, Date, isNaN, isFinite, parseFloat,
  app: undefined, Time: function () {}, ProjectItemType: { BIN: 'bin' }
};
vm.createContext(hostSandbox);
vm.runInContext(readFileSync('extension/jsx/Silencer.jsx', 'utf8'), hostSandbox, { filename: 'Silencer.jsx' });
const host = hostSandbox.$.silencer._internals;

test('overlapping silence regions merge into one', () => {
  const out = host.normaliseRegions([[5, 8], [1, 3], [2.5, 4], [8, 9]]);
  assert.deepEqual(plain(out), [[1, 4], [5, 9]]);
});

test('zero-length and reversed regions are discarded', () => {
  assert.deepEqual(plain(host.normaliseRegions([[3, 3], [5, 4], [1, 2]])), [[1, 2]]);
});

test('silenceBefore accumulates only what precedes the point', () => {
  const regions = [[1, 2], [5, 7]];
  assert.equal(host.silenceBefore(regions, 0), 0);
  assert.equal(host.silenceBefore(regions, 3), 1);     // first region only
  assert.equal(host.silenceBefore(regions, 6), 2);     // + half of the second
  assert.equal(host.silenceBefore(regions, 9), 3);     // both in full
});

test('a clip landing on a region edge shifts by the whole region', () => {
  // A clip starting exactly where a silence ends must absorb that silence.
  assert.equal(host.silenceBefore([[4, 6]], 6), 2);
});

test('insideRegion only claims clips wholly within a region', () => {
  const regions = [[10, 20]];
  assert.equal(host.insideRegion(regions, 12, 18), true);
  assert.equal(host.insideRegion(regions, 10, 20), true);
  assert.equal(host.insideRegion(regions, 9, 15), false);
  assert.equal(host.insideRegion(regions, 15, 21), false);
});

test('timecode formatting rolls over correctly', () => {
  assert.equal(host.secToTimecode(0, 30, ':'), '00:00:00:00');
  assert.equal(host.secToTimecode(61.5, 30, ':'), '00:01:01:15');
  assert.equal(host.secToTimecode(3600, 25, ';'), '01;00;00;00');
});

/* ------------------------------------------------------- silence detector */

const RATE = 8000;

/** Builds a mono signal: `spans` of [startSec, endSec, amplitude]. */
function makeSignal(durationSec, spans) {
  const samples = new Float32Array(Math.round(durationSec * RATE));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (Math.random() * 2 - 1) * 0.00002;   // -94 dB room tone
  }
  for (const [from, to, amp] of spans) {
    const a = Math.round(from * RATE), b = Math.round(to * RATE);
    for (let i = a; i < b && i < samples.length; i++) {
      samples[i] = Math.sin(2 * Math.PI * 220 * i / RATE) * amp;
    }
  }
  return samples;
}

function loadAnalyzer(samples, spy) {
  const sandbox = {
    Promise, Math, Number, String, Array, Float32Array, Uint8Array, Object,
    isFinite, isNaN, parseFloat, console, setTimeout,
    XMLHttpRequest: function () {},
    Env: {
      hasNode: () => true,
      fileSize: () => 1000,
      findFfmpeg: () => '/fake/ffmpeg',
      // Honour -ss/-t the way ffmpeg does, so the analyzer's source-offset
      // bookkeeping is actually under test rather than papered over.
      decodeWithFfmpeg: (ffmpeg, path, rate, opts) => {
        opts = opts || {};
        if (spy) { spy.push({ path, start: opts.start || 0, duration: opts.duration || 0 }); }
        const from = Math.max(0, Math.round((opts.start || 0) * RATE));
        const len = opts.duration > 0
          ? Math.round(opts.duration * RATE)
          : samples.length - from;
        return Promise.resolve(samples.slice(from, Math.min(samples.length, from + len)));
      },
      readArrayBuffer: () => { throw new Error('should not be reached'); }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync('extension/js/analyzer.js', 'utf8'), sandbox, { filename: 'analyzer.js' });
  return sandbox.Analyzer;
}

function sequence(durationSec, mediaPath = '/fake/take.wav') {
  return {
    name: 'Test', fps: 30, duration: durationSec, warnings: [],
    audioTracks: [{
      index: 0, name: 'A1', muted: false, clips: [{
        kind: 'audio', track: 0, index: 0, name: 'take.wav',
        start: 0, end: durationSec, inPoint: 0, outPoint: durationSec,
        speed: 1, disabled: false, mediaPath
      }]
    }]
  };
}

const BASE = {
  autoThreshold: false, thresholdDb: -35, minSilenceMs: 500, paddingMs: 100,
  minNoiseMs: 40, trimLeading: true, trimTrailing: true,
  skipMutedTracks: true, useFfmpeg: true, tracks: 'all', extensionRoot: ''
};

function near(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol,
    `${label}: expected ~${expected}, got ${actual.toFixed(3)}`);
}

await testAsync('finds the silent stretches between spoken takes', async () => {
  //   0-2 quiet | 2-5 loud | 5-7 quiet | 7-10 loud | 10-12.5 quiet | 12.5-20 loud
  const samples = makeSignal(20, [[2, 5, 0.3], [7, 10, 0.3], [12.5, 20, 0.3]]);
  const A = loadAnalyzer(samples);
  const res = await A.analyze(sequence(20), BASE, null);

  assert.equal(res.regions.length, 3, `expected 3 regions, got ${res.regions.length}`);
  // 100 ms of padding is preserved either side of every loud stretch.
  near(res.regions[0][0], 0,    0.05, 'region 1 start');
  near(res.regions[0][1], 1.9,  0.06, 'region 1 end');
  near(res.regions[1][0], 5.1,  0.06, 'region 2 start');
  near(res.regions[1][1], 6.9,  0.06, 'region 2 end');
  near(res.regions[2][0], 10.1, 0.06, 'region 3 start');
  near(res.regions[2][1], 12.4, 0.06, 'region 3 end');
  near(res.removed, 6.0, 0.2, 'total removed');
  near(res.remaining, 14.0, 0.2, 'remaining length');
});

await testAsync('leading and trailing silence can be kept', async () => {
  const samples = makeSignal(20, [[2, 5, 0.3], [7, 10, 0.3], [12.5, 18, 0.3]]);
  const A = loadAnalyzer(samples);
  const res = await A.analyze(sequence(20), { ...BASE, trimLeading: false, trimTrailing: false }, null);
  assert.equal(res.regions.length, 2, 'only the interior gaps should be cut');
  assert.ok(res.regions[0][0] > 1, 'the head of the timeline survived');
});

await testAsync('short gaps below the minimum are left alone', async () => {
  // A 300 ms gap, under the 500 ms floor, plus one long gap.
  const samples = makeSignal(12, [[0, 4, 0.3], [4.3, 7, 0.3], [10, 12, 0.3]]);
  const A = loadAnalyzer(samples);
  const res = await A.analyze(sequence(12), BASE, null);
  assert.equal(res.regions.length, 1, `expected only the long gap, got ${res.regions.length}`);
  near(res.regions[0][0], 7.1, 0.08, 'gap start');
});

await testAsync('a lone click does not count as speech', async () => {
  // 20 ms blip in the middle of eight seconds of nothing.
  const samples = makeSignal(12, [[0, 2, 0.3], [5.0, 5.02, 0.5], [10, 12, 0.3]]);
  const A = loadAnalyzer(samples);
  const res = await A.analyze(sequence(12), BASE, null);
  assert.equal(res.regions.length, 1, 'the blip should not split the silence in two');
  near(res.regions[0][1] - res.regions[0][0], 7.8, 0.2, 'gap length');
});

await testAsync('the automatic threshold lands between floor and speech', async () => {
  const samples = makeSignal(16, [[2, 6, 0.25], [9, 14, 0.25]]);
  const A = loadAnalyzer(samples);
  const res = await A.analyze(sequence(16), { ...BASE, autoThreshold: true }, null);
  assert.ok(res.threshold > -60 && res.threshold < -18, `threshold out of range: ${res.threshold}`);
  assert.equal(res.regions.length, 3, `expected 3 regions, got ${res.regions.length}`);
});

await testAsync('clip in/out and speed are mapped into sequence time', async () => {
  // Source is loud 0-4 s and 6-10 s. The clip uses source 6-10 s only, placed
  // at 2 s on the timeline, so the timeline should be loud from 2 s to 6 s.
  const samples = makeSignal(10, [[0, 4, 0.3], [6, 10, 0.3]]);
  const A = loadAnalyzer(samples);
  const info = sequence(8);
  info.audioTracks[0].clips[0] = {
    ...info.audioTracks[0].clips[0], start: 2, end: 6, inPoint: 6, outPoint: 10, speed: 1
  };
  const res = await A.analyze(info, BASE, null);
  assert.equal(res.regions.length, 2, 'the head and tail of the timeline are both empty');
  near(res.regions[0][0], 0, 0.05, 'head silence start');
  near(res.regions[0][1], 1.9, 0.08, 'head silence end');
  near(res.regions[1][0], 6.1, 0.08, 'tail silence start');
  near(res.regions[1][1], 8, 0.05, 'tail silence end');
});

await testAsync('only the slice of the file the timeline uses gets decoded', async () => {
  // A 10 s source with a clip using source 6-10 s must not decode 0-6 s.
  const samples = makeSignal(10, [[0, 4, 0.3], [6, 10, 0.3]]);
  const spy = [];
  const A = loadAnalyzer(samples, spy);
  const info = sequence(8);
  info.audioTracks[0].clips[0] = {
    ...info.audioTracks[0].clips[0], start: 2, end: 6, inPoint: 6, outPoint: 10, speed: 1
  };
  await A.analyze(info, BASE, null);

  assert.equal(spy.length, 1, 'the file should be decoded once');
  near(spy[0].start, 5.5, 0.01, 'decode start (6 s minus half a second of slack)');
  near(spy[0].duration, 5.0, 0.01, 'decode duration (4 s used plus slack both ends)');
});

await testAsync('two clips off one file widen the decode to cover both', async () => {
  const samples = makeSignal(30, [[0, 30, 0.3]]);
  const spy = [];
  const A = loadAnalyzer(samples, spy);
  const info = sequence(20);
  const base = info.audioTracks[0].clips[0];
  info.audioTracks[0].clips = [
    { ...base, start: 0, end: 5, inPoint: 2, outPoint: 7, speed: 1 },
    { ...base, start: 5, end: 10, inPoint: 20, outPoint: 25, speed: 1 }
  ];
  await A.analyze(info, BASE, null);

  assert.equal(spy.length, 1, 'one decode covering both clips, not two');
  near(spy[0].start, 1.5, 0.01, 'starts before the earlier clip');
  near(spy[0].start + spy[0].duration, 25.5, 0.01, 'ends after the later clip');
});

await testAsync('cancelling stops the analysis', async () => {
  const samples = makeSignal(12, [[2, 5, 0.3]]);
  const A = loadAnalyzer(samples);
  let err = null;
  try {
    await A.analyze(sequence(12), { ...BASE, isCancelled: () => true }, null);
  } catch (e) { err = e; }
  assert.ok(err, 'analyze should reject when cancelled');
  assert.match(err.message, /cancel/i);
});

await testAsync('every region is snapped to whole frames', async () => {
  const samples = makeSignal(14, [[3, 6, 0.3], [9, 14, 0.3]]);
  const A = loadAnalyzer(samples);
  const res = await A.analyze(sequence(14), BASE, null);
  for (const [start, end] of res.regions) {
    const sf = start * 30, ef = end * 30;
    assert.ok(Math.abs(sf - Math.round(sf)) < 1e-6, `start ${start} is not on a frame`);
    assert.ok(Math.abs(ef - Math.round(ef)) < 1e-6, `end ${end} is not on a frame`);
  }
});

await testAsync('a silent timeline reports one region, not a crash', async () => {
  const samples = makeSignal(6, []);
  const A = loadAnalyzer(samples);
  const res = await A.analyze(sequence(6), BASE, null);
  assert.equal(res.regions.length, 1);
  near(res.removed, 6, 0.1, 'everything removed');
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
