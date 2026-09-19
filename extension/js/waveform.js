/*
 * Draws the loudness envelope with the regions Silencer intends to remove
 * shaded behind it, so the settings can be judged by eye before anything is cut.
 */
(function (global) {
  'use strict';

  // The detector measures down to -120 dB, but drawing that range would put
  // room tone halfway up the graph. -72 dB is the quietest thing worth a pixel.
  var DISPLAY_FLOOR = -72;

  function draw(canvas, result) {
    var dpr = global.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 320;
    var cssH = canvas.clientHeight || 90;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var style = getComputedStyle(document.documentElement);
    function token(name, fallback) {
      var v = style.getPropertyValue(name).trim();
      return v || fallback;
    }

    ctx.fillStyle = token('--wave-bg', '#14161a');
    ctx.fillRect(0, 0, cssW, cssH);

    if (!result || !result.timeline || !result.timeline.length) { return; }

    var env = result.timeline;
    var span = 0 - DISPLAY_FLOOR;

    function yFor(db) {
      var frac = (db - DISPLAY_FLOOR) / span;
      if (frac < 0) { frac = 0; }
      if (frac > 1) { frac = 1; }
      return cssH - frac * (cssH - 3) - 1;
    }

    var i, r, rx, rw;

    // Regions destined for the bin, behind everything else.
    ctx.fillStyle = token('--wave-cut', 'rgba(255,86,86,0.30)');
    for (i = 0; i < result.regions.length; i++) {
      r = result.regions[i];
      rx = r[0] / result.duration * cssW;
      rw = Math.max(1.5, (r[1] - r[0]) / result.duration * cssW);
      ctx.fillRect(rx, 0, rw, cssH);
    }

    // The envelope, reduced to one peak per pixel column.
    var grad = ctx.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0, token('--wave-fg', '#58c0ec'));
    grad.addColorStop(1, token('--wave-fg-dim', '#2c6f8f'));
    ctx.fillStyle = grad;

    var x, from, to, j, peak, y;
    for (x = 0; x < cssW; x++) {
      from = Math.floor(x / cssW * env.length);
      to = Math.max(from + 1, Math.floor((x + 1) / cssW * env.length));
      peak = DISPLAY_FLOOR;
      for (j = from; j < to && j < env.length; j++) { if (env[j] > peak) { peak = env[j]; } }
      if (peak <= DISPLAY_FLOOR) { continue; }
      y = yFor(peak);
      ctx.fillRect(x, y, 1, cssH - y);
    }

    // The threshold, on top of both.
    ctx.strokeStyle = token('--wave-line', '#ff9a7a');
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    var ty = Math.round(yFor(result.threshold)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(cssW, ty);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  global.Waveform = { draw: draw, DISPLAY_FLOOR: DISPLAY_FLOOR };
}(window));
