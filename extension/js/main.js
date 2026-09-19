/*
 * Panel controller: settings, analysis, and the two things this plugin does -
 * cut the silence, or mark it.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    autoThreshold: true,
    thresholdDb: -35,
    minSilenceMs: 500,
    paddingMs: 100,
    minNoiseMs: 40,
    trimLeading: true,
    trimTrailing: true,
    skipMutedTracks: true,
    useFfmpeg: true,
    tracks: 'all',
    backup: true,
    backupBin: 'Silencer Backups'
  };

  var STORAGE_KEY = 'silencer.settings.v1';
  var RANGES = ['thresholdDb', 'minSilenceMs', 'paddingMs', 'minNoiseMs'];
  var CHECKS = ['autoThreshold', 'trimLeading', 'trimTrailing', 'skipMutedTracks', 'useFfmpeg', 'backup'];

  var settings = {};
  var sequenceInfo = null;
  var result = null;
  var busy = false;
  var cancelRequested = false;
  var extensionRoot = '';
  var reanalyzeTimer = null;

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- utils */

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) { sec = 0; }
    if (sec < 60) { return sec.toFixed(1) + 's'; }
    var m = Math.floor(sec / 60);
    var s = Math.round(sec - m * 60);
    if (s === 60) { m += 1; s = 0; }
    if (m < 60) { return m + 'm ' + s + 's'; }
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function logLine(msg) {
    var el = $('log');
    var t = new Date();
    var stamp = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
    el.textContent += '[' + stamp + '] ' + msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function status(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
    if (msg) { logLine(msg); }
  }

  function setBusy(on) {
    busy = on;
    $('analyze').disabled = on || !sequenceInfo;
    $('cut').disabled = on || !result || !result.regions.length;
    $('markers').disabled = on || !result || !result.regions.length;
    $('refresh').disabled = on;
  }

  function progress(fraction, text) {
    $('progress').classList.remove('hidden');
    $('progress-bar').style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
    $('progress-text').textContent = text || '';
  }

  function hideProgress() { $('progress').classList.add('hidden'); }

  /* ------------------------------------------------------------- settings */

  function loadSettings() {
    settings = {};
    var stored = null;
    try { stored = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { stored = {}; }
    Object.keys(DEFAULTS).forEach(function (k) {
      settings[k] = (stored && stored[k] !== undefined) ? stored[k] : DEFAULTS[k];
    });
  }

  function saveSettings() {
    try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function settingsToUi() {
    RANGES.forEach(function (k) {
      $(k).value = settings[k];
      $(k + '-out').textContent = settings[k];
    });
    CHECKS.forEach(function (k) { $(k).checked = !!settings[k]; });
    $('backupBin').value = settings.backupBin;
    $('threshold-field').classList.toggle('hidden', !!settings.autoThreshold);
  }

  function uiToSettings() {
    RANGES.forEach(function (k) {
      settings[k] = Number($(k).value);
      $(k + '-out').textContent = settings[k];
    });
    CHECKS.forEach(function (k) { settings[k] = $(k).checked; });
    settings.backupBin = $('backupBin').value.trim() || DEFAULTS.backupBin;
    var sel = $('trackSelect').value;
    settings.tracks = (sel === 'all') ? 'all' : [Number(sel)];
    $('threshold-field').classList.toggle('hidden', !!settings.autoThreshold);
    saveSettings();
  }

  /* ------------------------------------------------------------- sequence */

  function populateTracks(info) {
    var sel = $('trackSelect');
    var previous = sel.value;
    sel.innerHTML = '<option value="all">All audio tracks</option>';
    info.audioTracks.forEach(function (t) {
      if (!t.clips.length) { return; }
      var opt = document.createElement('option');
      opt.value = String(t.index);
      opt.textContent = 'A' + (t.index + 1) + (t.name ? ' — ' + t.name : '') +
                        ' (' + t.clips.length + ' clip' + (t.clips.length === 1 ? '' : 's') + ')' +
                        (t.muted ? ' — muted' : '');
      sel.appendChild(opt);
    });
    if (previous && sel.querySelector('option[value="' + previous + '"]')) { sel.value = previous; }
  }

  function invalidateResult(reason) {
    result = null;
    $('results').classList.add('hidden');
    $('empty-hint').classList.remove('hidden');
    $('analyze').classList.remove('btn-quiet');
    $('analyze').classList.add('btn-primary');
    $('cut').disabled = true;
    $('markers').disabled = true;
    if (reason) { status(reason); }
  }

  function refreshSequence(quiet) {
    return global.Host.getSequenceInfo().then(function (info) {
      sequenceInfo = info;
      $('sequence-name').textContent = info.name;
      $('sequence-name').title = info.name + ' — ' + fmtTime(info.duration) + ' @ ' + info.fps.toFixed(2) + ' fps';
      populateTracks(info);
      uiToSettings();
      $('analyze').disabled = false;
      info.warnings.forEach(function (w) { logLine('Note: ' + w); });
      if (!quiet) { status('Ready. ' + fmtTime(info.duration) + ' of timeline, ' + info.audioTracks.length + ' audio track(s).'); }
      return info;
    }).catch(function (err) {
      sequenceInfo = null;
      $('sequence-name').textContent = '—';
      $('analyze').disabled = true;
      invalidateResult();
      status(err.message, 'error');
    });
  }

  /* ------------------------------------------------------------- analysis */

  function showResult(res) {
    result = res;
    $('results').classList.remove('hidden');
    $('empty-hint').classList.add('hidden');
    // Cut is the action now; Analyze steps back so there is one obvious button.
    $('analyze').classList.remove('btn-primary');
    $('analyze').classList.add('btn-quiet');
    $('stat-cuts').textContent = String(res.regions.length);
    $('stat-removed').textContent = fmtTime(res.removed);
    $('stat-new').textContent = fmtTime(res.remaining);

    var pct = res.duration > 0 ? (res.removed / res.duration * 100) : 0;
    $('threshold-readout').textContent =
      'Threshold ' + res.threshold.toFixed(1) + ' dB' + (settings.autoThreshold ? ' (auto)' : '') +
      ' · ' + pct.toFixed(0) + '% of the timeline · ' +
      (res.usedFfmpeg ? 'decoded with ffmpeg' : 'decoded in-panel');

    global.Waveform.draw($('waveform'), res);

    res.failures.forEach(function (f) {
      logLine('Could not decode ' + f.path.replace(/^.*[\\\/]/, '') + ': ' + f.error);
    });

    $('cut').disabled = !res.regions.length;
    $('markers').disabled = !res.regions.length;
  }

  function runAnalysis(quiet) {
    if (busy) { return Promise.resolve(); }
    cancelRequested = false;
    setBusy(true);
    if (!quiet) { status('Analyzing…'); }

    return refreshSequence(true).then(function (info) {
      if (!info) { throw new Error('No sequence to analyse.'); }
      var opts = {};
      Object.keys(settings).forEach(function (k) { opts[k] = settings[k]; });
      opts.extensionRoot = extensionRoot;
      opts.isCancelled = function () { return cancelRequested; };
      return global.Analyzer.analyze(info, opts, progress);
    }).then(function (res) {
      hideProgress();
      showResult(res);
      if (!res.regions.length) {
        status('No silence matched those settings. Try a higher threshold or a shorter minimum.', 'good');
      } else {
        status('Found ' + res.regions.length + ' silent stretch(es) worth ' + fmtTime(res.removed) + '.', 'good');
      }
    }).catch(function (err) {
      hideProgress();
      invalidateResult();
      if (cancelRequested || /cancel/i.test(err.message || '')) {
        status('Stopped. Nothing was changed.');
      } else {
        status(err.message || String(err), 'error');
      }
    }).then(function () {
      cancelRequested = false;
      setBusy(false);
    });
  }

  function scheduleReanalysis() {
    if (!result) { return; }
    if (reanalyzeTimer) { clearTimeout(reanalyzeTimer); }
    reanalyzeTimer = setTimeout(function () {
      reanalyzeTimer = null;
      runAnalysis(true);
    }, 220);
  }

  /* ---------------------------------------------------------------- apply */

  function applyCuts() {
    if (!result || !result.regions.length || busy) { return; }

    var question = 'Remove ' + result.regions.length + ' silent stretch' +
      (result.regions.length === 1 ? '' : 'es') + ' (' + fmtTime(result.removed) + ') from "' +
      sequenceInfo.name + '"?' +
      (settings.backup ? '\n\nA backup copy of the timeline will be saved to the "' + settings.backupBin + '" bin first.'
                       : '\n\nWARNING: backup is switched off.');
    if (!global.confirm(question)) { return; }

    setBusy(true);
    status('Cutting…');
    progress(0.1, 'Backing up and splitting clips');

    global.Host.applyCuts({
      regions: result.regions,
      backup: settings.backup,
      backupBinName: settings.backupBin,
      sequenceName: sequenceInfo.name
    }).then(function (res) {
      hideProgress();
      global.Host.drainLog().forEach(logLine);
      if (res.backup) { logLine('Backup saved as "' + res.backup + '".'); }
      res.warnings.forEach(function (w) { logLine('Warning: ' + w); });
      status('Removed ' + fmtTime(res.removedDuration) + ' across ' + res.cuts + ' cut(s).' +
             (res.skipped ? ' ' + res.skipped + ' skipped — see Details.' : ''), 'good');
      invalidateResult();
      refreshSequence(true);
    }).catch(function (err) {
      hideProgress();
      global.Host.drainLog().forEach(logLine);
      status(err.message || String(err), 'error');
      $('log-card').open = true;
    }).then(function () {
      setBusy(false);
    });
  }

  function applyMarkers() {
    if (!result || !result.regions.length || busy) { return; }
    setBusy(true);
    status('Adding markers…');
    global.Host.addMarkers({ regions: result.regions }).then(function (res) {
      status('Added ' + res.markers + ' marker(s) over the silent stretches.', 'good');
    }).catch(function (err) {
      status(err.message || String(err), 'error');
    }).then(function () {
      global.Host.drainLog().forEach(logLine);
      setBusy(false);
    });
  }

  /* ----------------------------------------------------------------- init */

  function wire() {
    $('refresh').addEventListener('click', function () {
      global.Analyzer.clearCache();
      invalidateResult();
      refreshSequence();
    });

    $('analyze').addEventListener('click', function () { runAnalysis(false); });

    $('cancel').addEventListener('click', function () {
      // Kill any ffmpeg still running, then let the chain unwind on its own.
      cancelRequested = true;
      try { global.Env.killAll(); } catch (e) {}
      $('progress-text').textContent = 'Stopping\u2026';
    });
    $('cut').addEventListener('click', applyCuts);
    $('markers').addEventListener('click', applyMarkers);

    RANGES.forEach(function (k) {
      $(k).addEventListener('input', function () { uiToSettings(); scheduleReanalysis(); });
    });
    CHECKS.forEach(function (k) {
      $(k).addEventListener('change', function () {
        uiToSettings();
        if (k !== 'backup') { scheduleReanalysis(); }
      });
    });
    $('trackSelect').addEventListener('change', function () { uiToSettings(); scheduleReanalysis(); });
    $('backupBin').addEventListener('change', uiToSettings);

    $('reset-settings').addEventListener('click', function () {
      settings = JSON.parse(JSON.stringify(DEFAULTS));
      saveSettings();
      settingsToUi();
      uiToSettings();
      scheduleReanalysis();
    });

    global.addEventListener('resize', function () { if (result) { global.Waveform.draw($('waveform'), result); } });
    global.addEventListener('focus', function () { if (!busy) { refreshSequence(true); } });
  }

  function reportEnvironment() {
    if (!global.Env.hasNode()) {
      logLine('Node.js is not available in this panel; large files may fail to decode.');
      return;
    }
    var ff = global.Env.findFfmpeg(extensionRoot);
    logLine(ff ? 'ffmpeg found: ' + ff
               : 'ffmpeg not found — using the built-in decoder. Formats like ProRes or DNxHD may not decode.');
  }

  function init() {
    loadSettings();
    settingsToUi();
    wire();

    if (!global.CEP.available()) {
      status('This panel only runs inside Premiere Pro.', 'error');
      $('analyze').disabled = true;
      return;
    }

    global.CEP.applyHostTheme();
    extensionRoot = global.CEP.getSystemPath(global.CEP.SystemPath.EXTENSION);

    global.Host.ping().then(function (info) {
      logLine('Premiere Pro ' + info.app + ' · Silencer ' + info.scriptVersion);
      reportEnvironment();
      return refreshSequence();
    }).catch(function (err) {
      status(err.message || String(err), 'error');
      $('log-card').open = true;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
