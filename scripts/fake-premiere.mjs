/*
 * A small stand-in for Premiere's scripting surface, enough to run
 * Silencer.jsx's applyCuts end to end without Premiere.
 *
 * It models what the cutting code depends on and nothing else: frame-snapped
 * razors through QE, lifting a QE item, TrackItem.move(), and linked clips.
 * The behaviours Adobe does not document - whether move() drags a clip's
 * linked partner along, whether lifting one half of a linked pair lifts the
 * other - are switches, so a test can hold the code to the right answer under
 * either.
 *
 * Everything is kept in whole frames internally, the way Premiere's timeline
 * is, and only turned into ticks at the API boundary.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const TPS = 254016000000;

export function ticksPerFrame(fps) {
  // 29.97 and friends are exact rationals in Premiere; keep them that way.
  const table = { 23.976: 10594584000, 29.97: 8475667200, 59.94: 4237833600 };
  return table[fps] || Math.round(TPS / fps);
}

export function createPremiere(opts) {
  const o = Object.assign({ fps: 30, moveCarriesLinked: false, liftTakesPartner: false,
                             moveCollision: 'refuse', razorBreaksLinks: false }, opts);
  const tpf = ticksPerFrame(o.fps);
  let nextId = 1;
  let nextLink = 1;

  function TimeImpl() { this._t = 0; }
  Object.defineProperty(TimeImpl.prototype, 'ticks', {
    get() { return String(this._t); },
    set(v) { this._t = Number(v); }
  });
  Object.defineProperty(TimeImpl.prototype, 'seconds', {
    get() { return this._t / TPS; },
    set(v) { this._t = Math.round(Number(v) * TPS); }
  });
  const timeAtFrame = (f) => { const t = new TimeImpl(); t._t = f * tpf; return t; };
  const frameOfTicks = (ticks) => Math.round(Number(ticks) / tpf);

  const tracks = { video: [], audio: [] };
  const all = () => tracks.video.concat(tracks.audio);
  const ops = { moves: 0, refusedMoves: 0, razors: 0, lifts: 0, links: 0 };

  function makeTrack(kind, index) {
    const t = { kind, index, items: [] };
    t.sorted = () => t.items.slice().sort((a, b) => a.startF - b.startF);
    t.dom = {
      name: (kind === 'video' ? 'V' : 'A') + (index + 1),
      isLocked: () => false,
      isMuted: () => false,
      get clips() {
        const arr = t.sorted().map((c) => c.dom);
        arr.numItems = arr.length;
        return arr;
      }
    };
    t.qe = {
      get numItems() { return t.items.length; },
      getItemAt(i) { const c = t.sorted()[i]; return c ? c.qe : null; },
      razor(value) {
        // The spelling QE accepts has moved around; this build takes ticks.
        if (!/^\d+$/.test(String(value))) { throw new Error('bad time'); }
        const f = frameOfTicks(value);
        const c = t.items.find((x) => x.startF < f && x.endF > f);
        if (!c) { return; }
        ops.razors++;
        // Razoring one track at a time: the right-hand piece is only linked to
        // pieces cut at the same frame on other tracks.
        const right = makeClip(t, {
          startF: f, endF: c.endF, inF: c.inF + (f - c.startF),
          media: c.media, link: c.link && !o.razorBreaksLinks ? c.link + '@' + f : null
        });
        if (o.razorBreaksLinks) { c.link = null; }
        c.endF = f;
        return right;
      }
    };
    return t;
  }

  function makeClip(track, spec) {
    const c = Object.assign({ id: 'n' + (nextId++), track, selected: false }, spec);
    c.dom = {
      get nodeId() { return c.id; },
      get name() { return c.media; },
      get start() { return timeAtFrame(c.startF); },
      get end() { return timeAtFrame(c.endF); },
      get inPoint() { return timeAtFrame(c.inF); },
      get outPoint() { return timeAtFrame(c.inF + c.endF - c.startF); },
      get disabled() { return false; },
      projectItem: { getMediaPath: () => c.media, nodeId: 'pi:' + c.media },
      getSpeed: () => 1,
      isSelected: () => c.selected,
      setSelected(state) { c.selected = !!Number(state); },
      move(time) { moveClip(c, frameOfTicks(time.ticks)); },
      remove() { lift(c); }
    };
    c.qe = {
      get start() { return { ticks: String(c.startF * tpf) }; },
      get end() { return { ticks: String(c.endF * tpf) }; },
      type: 'Clip',
      get name() { return c.media; },
      remove() { lift(c); }
    };
    track.items.push(c);
    return c;
  }

  const partners = (c) => c.link ? all().flatMap((t) => t.items).filter((x) => x !== c && x.link === c.link) : [];

  function collides(c, startF, endF, ignore) {
    return c.track.items.some((x) => x !== c && !ignore.includes(x) && x.startF < endF && x.endF > startF);
  }

  function moveClip(c, delta) {
    if (!delta) { return; }
    const group = o.moveCarriesLinked ? [c].concat(partners(c)) : [c];
    if (o.moveCollision === 'refuse') {
      for (const g of group) {
        if (collides(g, g.startF + delta, g.endF + delta, group)) { ops.refusedMoves++; return; }
      }
    }
    for (const g of group) { g.startF += delta; g.endF += delta; }
    // Dropping a clip onto another one overwrites what was underneath, the
    // way a drag in the timeline does.
    if (o.moveCollision === 'overwrite') {
      for (const g of group) { overwriteUnder(g, group); }
    }
    ops.moves++;
  }

  function overwriteUnder(g, group) {
    const keep = [];
    for (const x of g.track.items) {
      if (x === g || group.includes(x) || x.endF <= g.startF || x.startF >= g.endF) { keep.push(x); continue; }
      ops.overwrites = (ops.overwrites || 0) + 1;
      if (x.startF < g.startF) {
        const tailEnd = x.endF;
        x.endF = g.startF;
        keep.push(x);
        if (tailEnd > g.endF) {
          keep.push(Object.assign({}, x, { startF: g.endF, endF: tailEnd, inF: x.inF + (g.endF - x.startF) }));
        }
      } else if (x.endF > g.endF) {
        x.inF += g.endF - x.startF;
        x.startF = g.endF;
        keep.push(x);
      }
    }
    g.track.items = keep;
  }

  function lift(c) {
    const group = o.liftTakesPartner ? [c].concat(partners(c)) : [c];
    for (const g of group) {
      g.track.items = g.track.items.filter((x) => x !== g);
    }
    ops.lifts++;
  }

  const seqDom = {
    name: 'Interview',
    sequenceID: 'seq-1',
    timebase: String(tpf),
    get end() {
      const e = Math.max(0, ...all().flatMap((t) => t.items.map((c) => c.endF)));
      return timeAtFrame(e);
    },
    get videoTracks() { const a = tracks.video.map((t) => t.dom); a.numTracks = a.length; return a; },
    get audioTracks() { const a = tracks.audio.map((t) => t.dom); a.numTracks = a.length; return a; },
    getSelection() { return all().flatMap((t) => t.items).filter((c) => c.selected).map((c) => c.dom); },
    linkSelection() {
      const sel = all().flatMap((t) => t.items).filter((c) => c.selected);
      if (sel.length < 2) { return false; }
      const id = 'relink' + (nextLink++);
      sel.forEach((c) => { c.link = id; });
      ops.links++;
      return true;
    }
  };

  const qeSeq = {
    getVideoTrackAt: (i) => tracks.video[i] ? tracks.video[i].qe : null,
    getAudioTrackAt: (i) => tracks.audio[i] ? tracks.audio[i].qe : null
  };

  const sandbox = {
    JSON, Math, Number, String, Array, Date, isNaN, isFinite, parseFloat, Object,
    $: {},
    Time: TimeImpl,
    ProjectItemType: { BIN: 'bin' },
    app: {
      version: '25.0', build: '1',
      enableQE() {},
      project: { activeSequence: seqDom }
    },
    qe: { project: { getActiveSequence: () => qeSeq } }
  };
  vm.createContext(sandbox);
  // ExtendScript pulls this in with // @include; Node sees only a comment.
  vm.runInContext(readFileSync('extension/js/cutplan.js', 'utf8'), sandbox, { filename: 'cutplan.js' });
  vm.runInContext(readFileSync('extension/jsx/Silencer.jsx', 'utf8'), sandbox, { filename: 'Silencer.jsx' });

  return {
    fps: o.fps,
    tpf,
    ops,
    silencer: sandbox.$.silencer,
    /** spec: { V1: [[start, end, media, link]], A1: [...] } in frames */
    lay(spec) {
      for (const [name, clips] of Object.entries(spec)) {
        const kind = name[0] === 'V' ? 'video' : 'audio';
        const index = Number(name.slice(1)) - 1;
        while (tracks[kind].length <= index) { tracks[kind].push(makeTrack(kind, tracks[kind].length)); }
        for (const [s, e, media, link, inF] of clips) {
          makeClip(tracks[kind][index], { startF: s, endF: e, inF: inF || 0, media, link: link || null });
        }
      }
    },
    /** [{startF, endF, media, inF, link}] per track name */
    state() {
      const out = {};
      for (const t of all()) {
        out[t.dom.name] = t.sorted().map((c) => ({ startF: c.startF, endF: c.endF, media: c.media, inF: c.inF, link: c.link }));
      }
      return out;
    },
    /** Which source frame each track shows at timeline frame f. */
    frameAt(trackName, f) {
      const t = all().find((x) => x.dom.name === trackName);
      const c = t.items.find((x) => x.startF <= f && x.endF > f);
      return c ? c.media + '#' + (c.inF + f - c.startF) : null;
    },
    cut(regionsSec, extra) {
      const json = JSON.stringify(Object.assign({ regions: regionsSec, backup: false, sequenceName: 'Interview' }, extra));
      return JSON.parse(sandbox.$.silencer.applyCuts(json));
    }
  };
}
