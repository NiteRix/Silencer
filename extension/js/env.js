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

  /**
   * Decodes one audio stream to mono float samples at `rate` Hz.
   * Output goes through a temp file rather than a pipe so that hour-long
   * timelines do not run into stdout buffer limits.
   */
  function decodeWithFfmpeg(ffmpeg, mediaPath, rate) {
    return new Promise(function (resolve, reject) {
      var out = tempFile('.f32');
      var args = [
        '-hide_banner', '-nostdin', '-v', 'error',
        '-i', mediaPath,
        '-vn', '-sn', '-dn',
        '-map', '0:a:0',
        '-ac', '1',
        '-ar', String(rate),
        '-f', 'f32le',
        '-y', out
      ];
      var stderr = '';
      var child;
      try {
        child = cp.spawn(ffmpeg, args, { windowsHide: true });
      } catch (e) { reject(e); return; }

      child.stderr.on('data', function (d) { stderr += String(d); });
      child.on('error', function (e) { remove(out); reject(e); });
      child.on('close', function (code) {
        if (code !== 0) {
          remove(out);
          reject(new Error('ffmpeg failed (' + code + '): ' + stderr.slice(0, 300)));
          return;
        }
        try {
          var buf = fs.readFileSync(out);
          remove(out);
          var samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
          resolve(samples);
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
    decodeWithFfmpeg: decodeWithFfmpeg
  };
}(window));
