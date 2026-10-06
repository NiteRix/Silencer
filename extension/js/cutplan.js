/*
 * Turns silence into a cut list Premiere can carry out cleanly.
 *
 * This file is shared word for word by the panel, which draws the preview, and
 * the host script, which makes the cuts - so what the waveform shows is what
 * gets cut. That is also why it is plain ES3: ExtendScript has to run it.
 *
 * Everything is in whole frames. Premiere's timeline only has frames, and doing
 * the arithmetic in seconds is how a cut ends up a frame away from where it was
 * meant to be.
 *
 * The one job beyond bookkeeping is never leaving a sliver: a piece of clip
 * shorter than `minKeep` frames, which reads on screen as a flash. Slivers come
 * from two places:
 *
 *   - two silences so close together that the speech between them is a frame
 *     or two long, and
 *   - a silence that stops a frame short of one of the editor's own cuts,
 *     leaving the last frame of one shot sitting between two jumps.
 *
 * The first is folded into the cut. The second is snapped to the existing cut,
 * so the jump lands on the edit that was already there.
 */
var CutPlan = (function () {

    function sortNumbers(list) {
        return list.sort(function (a, b) { return a - b; });
    }

    /** Whole-frame ranges, sorted, with overlapping and touching ones merged. */
    function normalise(regions) {
        var list = [], i, s, e;
        for (i = 0; i < regions.length; i++) {
            s = Math.round(Number(regions[i][0]));
            e = Math.round(Number(regions[i][1]));
            if (isNaN(s) || isNaN(e) || e <= s) { continue; }
            list.push([Math.max(0, s), e]);
        }
        list.sort(function (a, b) { return a[0] - b[0]; });

        var out = [];
        for (i = 0; i < list.length; i++) {
            var last = out.length ? out[out.length - 1] : null;
            if (last && list[i][0] <= last[1]) {
                if (list[i][1] > last[1]) { last[1] = list[i][1]; }
            } else {
                out.push([list[i][0], list[i][1]]);
            }
        }
        return out;
    }

    function uniqueFrames(edges) {
        var raw = [], i;
        for (i = 0; i < (edges || []).length; i++) {
            var f = Math.round(Number(edges[i]));
            if (!isNaN(f) && f >= 0) { raw.push(f); }
        }
        sortNumbers(raw);
        var out = [];
        for (i = 0; i < raw.length; i++) {
            if (!out.length || out[out.length - 1] !== raw[i]) { out.push(raw[i]); }
        }
        return out;
    }

    /**
     * regions - [[startFrame, endFrame], ...] of silence
     * edges   - frames where a clip starts or ends on any track, plus 0
     * minKeep - the shortest piece worth keeping, in frames
     * returns [[startFrame, endFrame], ...] ready to cut
     */
    function plan(regions, edges, minKeep) {
        var keep = Math.max(1, Math.floor(Number(minKeep) || 1));
        var cuts = normalise(regions);
        var marks = uniqueFrames(edges);
        var i, j, pass, changed;

        // Snapping can create a new short piece, and folding can bring a region
        // up to a new edge, so repeat until neither moves anything.
        for (pass = 0; pass < 8; pass++) {
            changed = false;

            // A piece between an existing edit and the start of a cut, shorter
            // than keep, goes with the cut. Likewise after the end.
            for (i = 0; i < cuts.length; i++) {
                for (j = 0; j < marks.length; j++) {
                    var m = marks[j];
                    if (m < cuts[i][0] && cuts[i][0] - m < keep) {
                        cuts[i][0] = m;
                        changed = true;
                        break;           // marks are sorted, so this was the furthest one
                    }
                }
                for (j = marks.length - 1; j >= 0; j--) {
                    var n = marks[j];
                    if (n > cuts[i][1] && n - cuts[i][1] < keep) {
                        cuts[i][1] = n;
                        changed = true;
                        break;
                    }
                }
            }

            cuts = normalise(cuts);

            // Speech between two cuts that is too short to be worth keeping.
            var folded = [];
            for (i = 0; i < cuts.length; i++) {
                var prev = folded.length ? folded[folded.length - 1] : null;
                if (prev && cuts[i][0] - prev[1] < keep) {
                    prev[1] = Math.max(prev[1], cuts[i][1]);
                    changed = true;
                } else {
                    folded.push([cuts[i][0], cuts[i][1]]);
                }
            }
            cuts = folded;

            if (!changed) { break; }
        }
        return cuts;
    }

    /** Frames removed before `frame` - how far whatever starts there must move left. */
    function removedBefore(cuts, frame) {
        var total = 0, i;
        for (i = 0; i < cuts.length; i++) {
            if (cuts[i][0] >= frame) { break; }
            total += Math.min(cuts[i][1], frame) - cuts[i][0];
        }
        return total;
    }

    /** True when [start, end) sits wholly inside one cut. */
    function inside(cuts, start, end) {
        var i;
        for (i = 0; i < cuts.length; i++) {
            if (start >= cuts[i][0] && end <= cuts[i][1]) { return true; }
        }
        return false;
    }

    function total(cuts) {
        var sum = 0, i;
        for (i = 0; i < cuts.length; i++) { sum += cuts[i][1] - cuts[i][0]; }
        return sum;
    }

    return {
        plan: plan,
        normalise: normalise,
        removedBefore: removedBefore,
        inside: inside,
        total: total
    };
}());
