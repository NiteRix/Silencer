/*
 * Exercises the two pieces of Silencer that are pure arithmetic: the silence
 * detector, and the host-side maths that decides where clips end up.
 * Neither needs Premiere, so both can be checked on every push.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createPremiere } from './fake-premiere.mjs';

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
vm.runInContext(readFileSync('extension/js/cutplan.js', 'utf8'), hostSandbox, { filename: 'cutplan.js' });
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
  vm.runInContext(readFileSync('extension/js/cutplan.js', 'utf8'), sandbox, { filename: 'cutplan.js' });
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

/* ------------------------------------------------------------ cut planning */

const planCtx = vm.createContext({ Math, Number, isNaN });
vm.runInContext(readFileSync('extension/js/cutplan.js', 'utf8'), planCtx, { filename: 'cutplan.js' });
const CutPlan = vm.runInContext('CutPlan', planCtx);
const plan = (...a) => plain(CutPlan.plan(...a));

test('a cut that stops a frame short of an existing edit lands on the edit', () => {
  // Otherwise the last frame of the shot is left flashing between two jumps.
  assert.deepEqual(plan([[240, 299]], [0, 300, 600], 4), [[240, 300]]);
  assert.deepEqual(plan([[302, 400]], [0, 300, 600], 4), [[300, 400]]);
});

test('speech too short to keep between two cuts goes with them', () => {
  assert.deepEqual(plan([[60, 90], [92, 120]], [0, 600], 4), [[60, 120]]);
});

test('pieces long enough to keep are left alone', () => {
  assert.deepEqual(plan([[60, 90], [100, 120]], [0, 300, 600], 4), [[60, 90], [100, 120]]);
  assert.deepEqual(plan([[240, 290]], [0, 300, 600], 4), [[240, 290]]);
});

test('frames removed before a point add up exactly', () => {
  const cuts = [[30, 60], [150, 195]];
  assert.equal(CutPlan.removedBefore(cuts, 0), 0);
  assert.equal(CutPlan.removedBefore(cuts, 60), 30);
  assert.equal(CutPlan.removedBefore(cuts, 170), 50);
  assert.equal(CutPlan.removedBefore(cuts, 500), 75);
});

/* --------------------------------------------- cutting, against fake Premiere */

/** Source frame shown at each timeline frame, for comparing tracks. */
function sourceAt(p, track, f) {
  const v = p.frameAt(track, f);
  return v === null ? null : Number(v.split('#')[1]);
}

function assertContiguous(p, track, length) {
  const pieces = p.state()[track];
  assert.equal(pieces[0].startF, 0, `${track} should start at frame 0`);
  for (let i = 1; i < pieces.length; i++) {
    assert.equal(pieces[i].startF, pieces[i - 1].endF,
      `${track} has a gap or overlap at frame ${pieces[i - 1].endF}`);
  }
  assert.equal(pieces[pieces.length - 1].endF, length, `${track} should end at frame ${length}`);
}

for (const carries of [false, true]) {
  test(`picture and sound stay in sync (move ${carries ? 'drags' : 'leaves'} the linked partner)`, () => {
    const p = createPremiere({ fps: 30, moveCarriesLinked: carries, moveCollision: 'overwrite' });
    p.lay({ V1: [[0, 600, 'cam.mp4', 'L1']], A1: [[0, 600, 'cam.mp4', 'L1']] });
    const res = p.cut([[2, 3], [5, 6.5], [10, 11]]);
    assert.ok(res.ok, res.error);
    assert.deepEqual(plain(res.warnings), []);
    assertContiguous(p, 'V1', 495);
    assertContiguous(p, 'A1', 495);
    for (let f = 0; f < 495; f++) {
      assert.equal(sourceAt(p, 'A1', f), sourceAt(p, 'V1', f), `out of sync at frame ${f}`);
    }
  });

  test(`a separate mic stays in sync with the picture (move ${carries ? 'drags' : 'leaves'} the linked partner)`, () => {
    // Camera with its scratch audio linked, plus a lav recorded on its own and
    // synced by hand. This is the setup that used to drift.
    const p = createPremiere({ fps: 30, moveCarriesLinked: carries, moveCollision: 'overwrite' });
    p.lay({
      V1: [[0, 600, 'cam.mp4', 'L1']],
      A1: [[0, 600, 'cam.mp4', 'L1']],
      A2: [[0, 600, 'lav.wav', null]]
    });
    const res = p.cut([[2, 3], [5, 6.5], [10, 11]]);
    assert.ok(res.ok, res.error);
    for (let f = 0; f < 495; f++) {
      assert.equal(sourceAt(p, 'A2', f), sourceAt(p, 'V1', f), `mic drifted from picture at frame ${f}`);
    }
  });
}

test('no piece shorter than the minimum is left behind', () => {
  // 29.97, an existing jump cut, and a silence that stops one frame short of it.
  const p = createPremiere({ fps: 29.97 });
  p.lay({
    V1: [[0, 300, 'cam.mp4', 'L1'], [300, 600, 'cam.mp4', 'L2', 400]],
    A1: [[0, 300, 'cam.mp4', 'L1'], [300, 600, 'cam.mp4', 'L2', 400]]
  });
  const res = p.cut([], { frames: [[240, 299]], minKeepFrames: 4 });
  assert.ok(res.ok, res.error);
  assert.deepEqual(plain(res.warnings), []);
  for (const [name, pieces] of Object.entries(p.state())) {
    for (const c of pieces) {
      assert.ok(c.endF - c.startF >= 4, `${name} kept a ${c.endF - c.startF}-frame piece at ${c.startF}`);
    }
  }
  assertContiguous(p, 'V1', 540);
});

test('a lift that takes the linked partner with it is not reported as a failure', () => {
  const p = createPremiere({ fps: 25, liftTakesPartner: true });
  p.lay({ V1: [[0, 500, 'cam.mp4', 'L1']], A1: [[0, 500, 'cam.mp4', 'L1']] });
  const res = p.cut([[4, 6], [10, 12]]);
  assert.ok(res.ok, res.error);
  assert.deepEqual(plain(res.warnings), []);
  assertContiguous(p, 'A1', 400);
});

test('pieces of picture are linked back to their own sound', () => {
  const p = createPremiere({ fps: 30, razorBreaksLinks: true });
  p.lay({
    V1: [[0, 600, 'cam.mp4', 'L1']],
    A1: [[0, 600, 'cam.mp4', 'L1']],
    A2: [[0, 600, 'lav.wav', null]]
  });
  const res = p.cut([[2, 3], [10, 11]]);
  assert.ok(res.ok, res.error);
  assert.equal(res.relinked, 3, 'three pieces of camera clip remain');
  const st = p.state();
  st.V1.forEach((v, i) => {
    assert.ok(v.link, `video piece ${i} is unlinked`);
    assert.equal(st.A1[i].link, v.link, `video piece ${i} is not linked to its own audio`);
  });
  assert.ok(st.A2.every((c) => !c.link), 'the separate mic must not be linked to anything');
});

test('seconds still work when no frame list is sent', () => {
  const p = createPremiere({ fps: 24 });
  p.lay({ V1: [[0, 480, 'cam.mp4', 'L1']], A1: [[0, 480, 'cam.mp4', 'L1']] });
  const res = p.cut([[5, 7.5]]);
  assert.ok(res.ok, res.error);
  assertContiguous(p, 'V1', 420);
});

/* ------------------------------------------------------ smarter word edges */

await testAsync('a word fading out below the threshold is not clipped', async () => {
  // Speech, then a 250 ms tail 5 dB under the threshold (a trailing "s"), then
  // room tone. A flat threshold cuts at the end of the loud part; following
  // the word keeps the tail.
  const tailAmp = Math.pow(10, -40 / 20) * Math.SQRT2;          // -40 dB RMS
  const samples = makeSignal(12, [[1, 4, 0.3], [4, 4.25, tailAmp], [8, 12, 0.3]]);
  const flat = await loadAnalyzer(samples).analyze(sequence(12), { ...BASE, smartEdges: false }, null);
  const smart = await loadAnalyzer(samples).analyze(sequence(12), { ...BASE, smartEdges: true }, null);
  const flatGap = flat.regions.find((r) => r[0] > 3 && r[0] < 5);
  const smartGap = smart.regions.find((r) => r[0] > 3 && r[0] < 5);
  near(flatGap[0], 4.1, 0.06, 'flat threshold cuts at the end of the loud part');
  near(smartGap[0], 4.35, 0.06, 'smart edges keep the tail, then pad it');
});

await testAsync('room tone is not mistaken for a word ending', async () => {
  // A noisy room 15 dB under the threshold must not be grown into.
  const roomAmp = Math.pow(10, -50 / 20) * Math.SQRT2;
  const samples = makeSignal(12, [[0, 12, roomAmp], [2, 4, 0.3], [8, 10, 0.3]]);
  const res = await loadAnalyzer(samples).analyze(sequence(12), BASE, null);
  const gap = res.regions.find((r) => r[0] > 3 && r[0] < 5);
  near(gap[0], 4.1, 0.06, 'cut starts right after the padding');
});

await testAsync('the preview plans around existing edits exactly as the cut will', async () => {
  // Silence starts at about 5.1 s; an edit sits two frames earlier.
  const samples = makeSignal(12, [[1, 5, 0.3], [8, 12, 0.3]]);
  const info = { ...sequence(12), edgeFrames: [0, 151, 360] };
  const res = await loadAnalyzer(samples).analyze(info, { ...BASE, minKeepFrames: 4 }, null);
  const cut = res.frames.find((r) => r[0] > 140 && r[0] < 160);
  assert.equal(cut[0], 151, `expected the cut to snap back onto the edit at 151, got ${cut[0]}`);
  assert.deepEqual(plain(res.regions).map(r => r.map(x => Math.round(x * 30))), plain(res.frames));
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
