/*
 * Node-side plumbing: filesystem access and ffmpeg discovery.
 *
 * Silencer works with no external dependencies at all (Chromium decodes the
 * audio), but ffmpeg is used when it is available because it handles the codecs
 * Chromium will not touch - ProRes, DNxHD, most .mov variants - and it decodes
 * long files without pulling them into memory whole.
 */
(function (global) {
  'use strict';

  var nodeRequire = null;
  if (typeof require === 'function') { nodeRequire = require; }
  else if (global.cep_node && typeof global.cep_node.require === 'function') { nodeRequire = global.cep_node.require; }

  var fs = null, path = null, os = null, cp = null;
  if (nodeRequire) {
    try {
      fs = nodeRequire('fs');
      path = nodeRequire('path');
      os = nodeRequire('os');
      cp = nodeRequire('child_process');
    } catch (e) { nodeRequire = null; }
  }

  var isWindows = !!(os && os.platform && os.platform() === 'win32') ||
                  /win/i.test(global.navigator.platform);

  function hasNode() { return !!(fs && cp); }

  function exists(p) {
    try { return !!p && fs.existsSync(p); } catch (e) { return false; }
  }

  function fileSize(p) {
    try { return fs.statSync(p).size; } catch (e) { return -1; }
  }

  function readArrayBuffer(p) {
    var buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  function tempFile(suffix) {
    var dir = os.tmpdir();
    var name = 'silencer-' + Date.now() + '-' + Math.floor(Math.random() * 1e9) + (suffix || '');
    return path.join(dir, name);
  }

  function remove(p) { try { fs.unlinkSync(p); } catch (e) {} }

  /* ------------------------------------------------------------- ffmpeg */

  var FFMPEG_KEY = 'silencer.ffmpegPath';
  var cachedFfmpeg;   // undefined = not looked for yet, null = looked and missing

  function binName() { return isWindows ? 'ffmpeg.exe' : 'ffmpeg'; }

  function verify(candidate) {
    if (!candidate || !cp) { return false; }
    try {
      cp.execFileSync(candidate, ['-version'], { timeout: 8000, stdio: 'ignore', windowsHide: true });
      return true;
    } catch (e) { return false; }
  }

  function candidates(extensionRoot) {
    var list = [];
    var override = '';
    try { override = global.localStorage.getItem(FFMPEG_KEY) || ''; } catch (e) {}
    if (override) { list.push(override); }
    if (extensionRoot && path) { list.push(path.join(extensionRoot, 'bin', binName())); }
    list.push(binName());   // whatever is on PATH
    if (isWindows) {
      var la = (global.process && global.process.env) ? global.process.env.LOCALAPPDATA : '';
      list.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
      list.push('C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe');
      if (la) { list.push(la + '\\Microsoft\\WinGet\\Links\\ffmpeg.exe'); }
    } else {
      list.push('/opt/homebrew/bin/ffmpeg');
      list.push('/usr/local/bin/ffmpeg');
      list.push('/usr/bin/ffmpeg');
    }
    return list;
  }

  function findFfmpeg(extensionRoot) {
    if (cachedFfmpeg !== undefined) { return cachedFfmpeg; }
    cachedFfmpeg = null;
    if (!hasNode()) { return null; }
    var list = candidates(extensionRoot), i;
    for (i = 0; i < list.length; i++) {
      if (verify(list[i])) { cachedFfmpeg = list[i]; break; }
    }
    return cachedFfmpeg;
  }

  function setFfmpegPath(p) {
    try { global.localStorage.setItem(FFMPEG_KEY, p || ''); } catch (e) {}
    cachedFfmpeg = undefined;
  }

  /** Children currently running, so a cancel can actually stop them. */
  var liveChildren = [];

  function killAll() {
    var i;
    for (i = 0; i < liveChildren.length; i++) {
      try { liveChildren[i].kill(); } catch (e) {}
    }
    liveChildren = [];
  }

  function forget(child) {
    var i = liveChildren.indexOf(child);
    if (i >= 0) { liveChildren.splice(i, 1); }
  }

  /**
   * Decodes one audio stream to mono float samples at `rate` Hz.
   *
   * opts.start / opts.duration limit the decode to the slice of the file the
   * timeline actually uses - on a multi-gigabyte source that is the difference
   * between seconds and many minutes.
   *
   * Output goes to a temp file rather than a pipe so hour-long takes cannot hit
   * stdout buffer limits, which leaves stdout free for -progress. Without that
   * the panel had no idea how far along a decode was, and a slow file was
   * indistinguishable from a hang.
   */
  function decodeWithFfmpeg(ffmpeg, mediaPath, rate, opts) {
    opts = opts || {};
    var stallMs = (opts.stallSeconds || 90) * 1000;

    return new Promise(function (resolve, reject) {
      var out = tempFile('.f32');
      var args = ['-hide_banner', '-nostdin', '-v', 'error'];

      // Seeking before -i is the fast path: ffmpeg skips to the keyframe
      // rather than decoding everything up to it.
      if (opts.start > 0) { args.push('-ss', String(opts.start)); }
      args.push('-i', mediaPath);
      if (opts.duration > 0) { args.push('-t', String(opts.duration)); }

      args = args.concat([
        '-vn', '-sn', '-dn',
        '-map', '0:a:0',
        '-ac', '1',
        '-ar', String(rate),
        '-f', 'f32le',
        '-nostats',
        '-progress', 'pipe:1',
        '-y', out
      ]);

      var stderr = '';
      var settled = false;
      var stallTimer = null;
      var child;

      function cleanup() {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        if (child) { forget(child); }
      }

      function fail(err) {
        if (settled) { return; }
        settled = true;
        cleanup();
        remove(out);
        reject(err);
      }

      function touch() {
        if (stallTimer) { clearTimeout(stallTimer); }
        stallTimer = setTimeout(function () {
          try { if (child) { child.kill(); } } catch (e) {}
          fail(new Error('ffmpeg stopped responding after ' + (stallMs / 1000) +
                         's with no progress. The file may be on a disconnected drive.'));
        }, stallMs);
      }

      try {
        child = cp.spawn(ffmpeg, args, { windowsHide: true });
      } catch (e) { remove(out); reject(e); return; }

      liveChildren.push(child);
      touch();

      var pending = '';
      child.stdout.on('data', function (chunk) {
        touch();
        if (!opts.onProgress || !(opts.duration > 0)) { return; }
        pending += String(chunk);
        var lines = pending.split(/\r?\n/);
        pending = lines.pop();
        var i, m;
        for (i = 0; i < lines.length; i++) {
          // out_time_us is microseconds; out_time_ms is too, despite the name.
          m = lines[i].match(/^out_time_(?:us|ms)=(\d+)/);
          if (m) {
            opts.onProgress(Math.min(1, (Number(m[1]) / 1e6) / opts.duration));
          }
        }
      });

      child.stderr.on('data', function (d) { touch(); stderr += String(d); });
      child.on('error', function (e) { fail(e); });

      child.on('close', function (code) {
        if (settled) { return; }
        settled = true;
        cleanup();
        if (code !== 0) {
          remove(out);
          reject(new Error('ffmpeg failed (' + code + '): ' + stderr.slice(0, 300)));
          return;
        }
        try {
          var buf = fs.readFileSync(out);
          remove(out);
          resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
        } catch (e2) { remove(out); reject(e2); }
      });
    });
  }

  global.Env = {
    hasNode: hasNode,
    isWindows: isWindows,
    exists: exists,
    fileSize: fileSize,
    readArrayBuffer: readArrayBuffer,
    findFfmpeg: findFfmpeg,
    setFfmpegPath: setFfmpegPath,
    decodeWithFfmpeg: decodeWithFfmpeg,
    killAll: killAll
  };
}(window));
