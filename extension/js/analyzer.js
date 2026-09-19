/*
 * Silence detection.
 *
 * Source files are decoded to mono at a low rate and reduced to a loudness
 * envelope in dBFS, one value every HOP seconds. Each timeline clip then paints
 * its slice of that envelope onto a sequence-wide envelope, so overlapping
 * clips and multiple tracks resolve to "the loudest thing audible at this
 * instant" - which is exactly what decides whether a moment is silent.
 */
(function (global) {
  'use strict';

  var RATE = 8000;          // speech energy lives well below 4 kHz
  var HOP = 0.01;           // 10 ms envelope resolution
  var FLOOR_DB = -120;
  var MAX_WEBAUDIO_BYTES = 700 * 1024 * 1024;

  var envelopeCache = {};

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ------------------------------------------------------------ decoding */

  function readFileBuffer(mediaPath) {
    if (global.Env.hasNode()) {
      var size = global.Env.fileSize(mediaPath);
      if (size > MAX_WEBAUDIO_BYTES) {
        return Promise.reject(new Error(
          'This file is ' + (size / 1073741824).toFixed(1) + ' GB, which is too large to decode in the panel. ' +
          'Install ffmpeg (see the README) and Silencer will stream it instead.'));
      }
      try { return Promise.resolve(global.Env.readArrayBuffer(mediaPath)); }
      catch (e) { return Promise.reject(e); }
    }
    return new Promise(function (resolve, reject) {
      var url = 'file:///' + String(mediaPath).replace(/\\/g, '/').replace(/^\/+/, '');
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () { xhr.response ? resolve(xhr.response) : reject(new Error('Empty read: ' + mediaPath)); };
      xhr.onerror = function () { reject(new Error('Could not read ' + mediaPath)); };
      xhr.send();
    });
  }

  function decodeWithChromium(mediaPath) {
    return readFileBuffer(mediaPath).then(function (arrayBuffer) {
      // decodeAudioData resamples to the context rate, so an 8 kHz offline
      // context keeps memory flat regardless of the source's sample rate.
      var ctx = new (global.OfflineAudioContext || global.webkitOfflineAudioContext)(1, 1, RATE);
      return ctx.decodeAudioData(arrayBuffer);
    }).then(function (audioBuffer) {
      var channels = audioBuffer.numberOfChannels;
      var len = audioBuffer.length;
      var mono = new Float32Array(len);
      var c, i, data;
      for (c = 0; c < channels; c++) {
        data = audioBuffer.getChannelData(c);
        for (i = 0; i < len; i++) { mono[i] += data[i]; }
      }
      if (channels > 1) { for (i = 0; i < len; i++) { mono[i] /= channels; } }
      return mono;
    });
  }

  /* ------------------------------------------------------------ envelope */

  function samplesToEnvelope(samples) {
    var hopSamples = Math.max(1, Math.round(RATE * HOP));
    var window = hopSamples * 2;              // 20 ms RMS window, 10 ms hop
    var count = Math.max(1, Math.ceil(samples.length / hopSamples));
    var db = new Float32Array(count);
    var i, j, start, end, sum, v, rms;

    for (i = 0; i < count; i++) {
      start = i * hopSamples - (window - hopSamples) / 2;
      end = start + window;
      if (start < 0) { start = 0; }
      if (end > samples.length) { end = samples.length; }
      sum = 0;
      for (j = start; j < end; j++) { v = samples[j]; sum += v * v; }
      rms = (end > start) ? Math.sqrt(sum / (end - start)) : 0;
      db[i] = rms > 1e-9 ? clamp(20 * Math.log10(rms), FLOOR_DB, 0) : FLOOR_DB;
    }
    return db;
  }

  /**
   * range = { start, duration } in source seconds, or null for the whole file.
   * Resolves to { db, offset } where offset is the source time db[0] represents.
   */
  function getEnvelope(mediaPath, ffmpegPath, range, onProgress) {
    var cached = envelopeCache[mediaPath];
    if (cached && covers(cached, range)) { return Promise.resolve(cached); }

    var decode;
    if (ffmpegPath) {
      decode = global.Env.decodeWithFfmpeg(ffmpegPath, mediaPath, RATE, {
        start: range ? range.start : 0,
        duration: range ? range.duration : 0,
        onProgress: onProgress
      }).then(function (samples) {
        return { samples: samples, offset: range ? range.start : 0 };
      }).catch(function (err) {
        if (/cancelled/i.test(err.message || '')) { throw err; }
        // A stream ffmpeg cannot map is worth one more try through Chromium,
        // which always reads from the top of the file.
        return decodeWithChromium(mediaPath)
          .then(function (samples) { return { samples: samples, offset: 0 }; })
          .catch(function () { throw err; });
      });
    } else {
      decode = decodeWithChromium(mediaPath).then(function (samples) {
        return { samples: samples, offset: 0 };
      });
    }

    return decode.then(function (result) {
      var env = {
        db: samplesToEnvelope(result.samples),
        offset: result.offset,
        duration: range && result.offset > 0 ? range.duration : Infinity
      };
      envelopeCache[mediaPath] = env;
      return env;
    });
  }

  /** True when a cached envelope already spans everything `range` needs. */
  function covers(env, range) {
    if (!range) { return env.offset <= 0 && env.duration === Infinity; }
    if (env.offset > range.start + 1e-6) { return false; }
    return (env.offset + env.duration) >= (range.start + range.duration) - 1e-6;
  }

  function clearCache() { envelopeCache = {}; }

  /* ------------------------------------------------- silence from envelope */

  function percentile(values, p) {
    if (!values.length) { return FLOOR_DB; }
    var sorted = Array.prototype.slice.call(values).sort(function (a, b) { return a - b; });
    var idx = clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1);
    return sorted[idx];
  }

  function autoThreshold(timeline) {
    var voiced = [], i;
    for (i = 0; i < timeline.length; i++) {
      if (timeline[i] > FLOOR_DB + 1) { voiced.push(timeline[i]); }
    }
    if (voiced.length < 10) { return -35; }
    var loud = percentile(voiced, 0.95);
    return clamp(loud - 26, -60, -18);
  }

  /** Turns a boolean mask into [startIndex, endIndexExclusive] runs of `want`. */
  function runsOf(mask, want) {
    var runs = [], i, start = -1;
    for (i = 0; i < mask.length; i++) {
      if (mask[i] === want) {
        if (start < 0) { start = i; }
      } else if (start >= 0) {
        runs.push([start, i]);
        start = -1;
      }
    }
    if (start >= 0) { runs.push([start, mask.length]); }
    return runs;
  }

  /* ------------------------------------------------------------- analysis */

  /**
   * info      - the payload from Host.getSequenceInfo()
   * settings  - see defaults in main.js
   * onProgress(fraction, message)
   */
  function analyze(info, settings, onProgress) {
    var duration = info.duration;
    if (!(duration > 0)) { return Promise.reject(new Error('This sequence looks empty.')); }

    var hops = Math.ceil(duration / HOP) + 1;
    var timeline = new Float32Array(hops);
    var i;
    for (i = 0; i < hops; i++) { timeline[i] = FLOOR_DB; }

    var ffmpegPath = settings.useFfmpeg ? global.Env.findFfmpeg(settings.extensionRoot) : null;

    // Collect the clips worth decoding, de-duplicated by source file.
    var jobs = [], skipped = 0, t, k, track, clip;
    for (t = 0; t < info.audioTracks.length; t++) {
      track = info.audioTracks[t];
      if (settings.tracks !== 'all' && settings.tracks.indexOf(track.index) === -1) { continue; }
      if (settings.skipMutedTracks && track.muted) { continue; }
      for (k = 0; k < track.clips.length; k++) {
        clip = track.clips[k];
        if (clip.disabled) { continue; }
        if (!clip.mediaPath) { skipped++; continue; }
        jobs.push(clip);
      }
    }

    if (!jobs.length) {
      return Promise.reject(new Error('No usable audio clips were found on the selected tracks.'));
    }

    // Only the slice of each file the timeline actually touches needs decoding.
    // A four-hour rush with ninety seconds on the timeline should cost ninety
    // seconds of work, not four hours.
    var uniquePaths = [];
    var ranges = {};
    for (i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var from = job.inPoint;
      var to = job.inPoint + (job.end - job.start) * job.speed;
      if (!ranges[job.mediaPath]) {
        uniquePaths.push(job.mediaPath);
        ranges[job.mediaPath] = { start: from, end: to };
      } else {
        if (from < ranges[job.mediaPath].start) { ranges[job.mediaPath].start = from; }
        if (to > ranges[job.mediaPath].end) { ranges[job.mediaPath].end = to; }
      }
    }
    for (i = 0; i < uniquePaths.length; i++) {
      var r = ranges[uniquePaths[i]];
      r.start = Math.max(0, r.start - 0.5);          // a little slack either side
      r.duration = Math.max(0.5, (r.end + 0.5) - r.start);
    }

    var failures = [];
    var chain = Promise.resolve();
    var cancelled = function () { return settings.isCancelled && settings.isCancelled(); };

    uniquePaths.forEach(function (p, idx) {
      chain = chain.then(function () {
        if (cancelled()) { throw new Error('Cancelled.'); }
        var label = p.replace(/^.*[\\\/]/, '');
        var base = idx / uniquePaths.length;
        var slice = 0.85 / uniquePaths.length;
        if (onProgress) { onProgress(base, 'Reading ' + label); }

        return getEnvelope(p, ffmpegPath, ranges[p], function (fraction) {
          if (onProgress) {
            onProgress(base + slice * fraction,
                       'Reading ' + label + '  ' + Math.round(fraction * 100) + '%');
          }
        }).catch(function (err) {
          if (cancelled()) { throw new Error('Cancelled.'); }
          failures.push({ path: p, error: err.message || String(err) });
          return null;
        });
      });
    });

    return chain.then(function () {
      if (cancelled()) { throw new Error('Cancelled.'); }
      if (onProgress) { onProgress(0.9, 'Measuring the timeline'); }

      // Paint every clip's envelope into sequence time.
      var j, clipRec, env, firstHop, lastHop, h, tlT, srcT, srcHop, value;
      var painted = 0;
      for (j = 0; j < jobs.length; j++) {
        clipRec = jobs[j];
        env = envelopeCache[clipRec.mediaPath];
        if (!env) { continue; }
        painted++;
        firstHop = Math.max(0, Math.floor(clipRec.start / HOP));
        lastHop = Math.min(hops - 1, Math.ceil(clipRec.end / HOP));
        for (h = firstHop; h <= lastHop; h++) {
          tlT = h * HOP;
          if (tlT < clipRec.start - HOP || tlT > clipRec.end + HOP) { continue; }
          srcT = clipRec.inPoint + (tlT - clipRec.start) * clipRec.speed;
          srcHop = Math.round((srcT - env.offset) / HOP);
          if (srcHop < 0 || srcHop >= env.db.length) { continue; }
          value = env.db[srcHop];
          if (value > timeline[h]) { timeline[h] = value; }
        }
      }

      if (!painted) {
        var why = failures.length ? (' ' + failures[0].error) : '';
        throw new Error('None of the audio could be decoded.' + why);
      }

      var threshold = settings.autoThreshold ? autoThreshold(timeline) : settings.thresholdDb;

      /* mask of "something audible is happening here" */
      var loud = new Uint8Array(hops);
      for (i = 0; i < hops; i++) { loud[i] = timeline[i] >= threshold ? 1 : 0; }

      /* clicks and pops are not speech */
      var minNoiseHops = Math.round(settings.minNoiseMs / 1000 / HOP);
      if (minNoiseHops > 0) {
        // The RMS window is one hop wider than the hop itself, so every burst
        // measures about one hop longer than it really is. Take that back,
        // otherwise "ignore blips shorter than 40 ms" would really mean 30 ms.
        var loudRuns = runsOf(loud, 1);
        for (i = 0; i < loudRuns.length; i++) {
          if (loudRuns[i][1] - loudRuns[i][0] - 1 < minNoiseHops) {
            for (j = loudRuns[i][0]; j < loudRuns[i][1]; j++) { loud[j] = 0; }
          }
        }
      }

      /* breathing room, so words do not lose their attack or tail */
      var padHops = Math.round(settings.paddingMs / 1000 / HOP);
      if (padHops > 0) {
        var padded = new Uint8Array(hops);
        var runs = runsOf(loud, 1);
        for (i = 0; i < runs.length; i++) {
          var from = Math.max(0, runs[i][0] - padHops);
          var to = Math.min(hops, runs[i][1] + padHops);
          for (j = from; j < to; j++) { padded[j] = 1; }
        }
        loud = padded;
      }

      /* whatever is left over is silence */
      var minSilenceHops = Math.max(1, Math.round(settings.minSilenceMs / 1000 / HOP));
      var silenceRuns = runsOf(loud, 0);
      var regions = [];
      var firstLoud = -1, lastLoud = -1;
      for (i = 0; i < hops; i++) { if (loud[i]) { if (firstLoud < 0) { firstLoud = i; } lastLoud = i; } }

      for (i = 0; i < silenceRuns.length; i++) {
        var run = silenceRuns[i];
        var leading = (run[0] === 0);
        var trailing = (run[1] >= hops);
        if (leading && !settings.trimLeading) { continue; }
        if (trailing && !settings.trimTrailing) { continue; }
        if (run[1] - run[0] < minSilenceHops) { continue; }
        regions.push([run[0] * HOP, run[1] * HOP]);
      }

      /* snap inwards to whole frames so Premiere never sees a sub-frame cut */
      var fps = info.fps > 0 ? info.fps : 30;
      var snapped = [];
      for (i = 0; i < regions.length; i++) {
        var s = Math.ceil(regions[i][0] * fps - 1e-6) / fps;
        var e = Math.floor(regions[i][1] * fps + 1e-6) / fps;
        s = clamp(s, 0, duration);
        e = clamp(e, 0, duration);
        if (e - s >= (1 / fps) - 1e-6) { snapped.push([s, e]); }
      }

      var removed = 0;
      for (i = 0; i < snapped.length; i++) { removed += snapped[i][1] - snapped[i][0]; }

      if (onProgress) { onProgress(1, 'Done'); }

      return {
        regions: snapped,
        threshold: threshold,
        timeline: timeline,
        hop: HOP,
        duration: duration,
        removed: removed,
        remaining: Math.max(0, duration - removed),
        failures: failures,
        skippedClips: skipped,
        usedFfmpeg: !!ffmpegPath,
        firstLoudTime: firstLoud < 0 ? 0 : firstLoud * HOP,
        lastLoudTime: lastLoud < 0 ? duration : lastLoud * HOP
      };
    });
  }

  global.Analyzer = {
    analyze: analyze,
    clearCache: clearCache,
    FLOOR_DB: FLOOR_DB,
    HOP: HOP
  };
}(window));
