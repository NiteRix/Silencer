/*
 * Silencer - automatic silence removal for Adobe Premiere Pro.
 * Host-side (ExtendScript) half. The panel does the listening; this does the cutting.
 *
 * Everything public hangs off $.silencer and returns a JSON string, because that
 * is all CSInterface.evalScript can carry back.
 */

// @include "json2.jsx"

$.silencer = (function () {

    var TICKS_PER_SECOND = 254016000000;
    var EPS = 1e-6;

    var log = [];
    function note(msg) { log.push(String(msg)); }

    function reply(obj) {
        obj.log = log;
        var s;
        try { s = JSON.stringify(obj); }
        catch (e) { s = '{"ok":false,"error":"Could not serialise result: ' + e + '"}'; }
        log = [];
        return s;
    }

    function fail(msg, extra) {
        var o = extra || {};
        o.ok = false;
        o.error = String(msg);
        return reply(o);
    }

    /* ---------------------------------------------------------------- time */

    function timeToSec(t) {
        if (t === undefined || t === null) { return 0; }
        try {
            if (t.ticks !== undefined && t.ticks !== null) {
                var n = Number(t.ticks);
                if (!isNaN(n)) { return n / TICKS_PER_SECOND; }
            }
        } catch (e) {}
        try {
            var s = parseFloat(t.seconds);
            if (!isNaN(s)) { return s; }
        } catch (e2) {}
        var direct = Number(t);
        return isNaN(direct) ? 0 : direct / TICKS_PER_SECOND;
    }

    function secToTime(sec) {
        var t = new Time();
        try { t.ticks = String(Math.round(sec * TICKS_PER_SECOND)); }
        catch (e) { t.seconds = sec; }
        return t;
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function secToTimecode(sec, fps, sep) {
        if (sec < 0) { sec = 0; }
        var totalFrames = Math.round(sec * fps);
        var fpsInt = Math.round(fps);
        if (fpsInt < 1) { fpsInt = 1; }
        var f = totalFrames % fpsInt;
        var totalSec = Math.floor(totalFrames / fpsInt);
        var s = totalSec % 60;
        var m = Math.floor(totalSec / 60) % 60;
        var h = Math.floor(totalSec / 3600);
        return pad2(h) + sep + pad2(m) + sep + pad2(s) + sep + pad2(f);
    }

    function stamp() {
        var d = new Date();
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
               ' ' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    }

    /* -------------------------------------------------------------- probing */

    function activeSequence() {
        try { return app.project.activeSequence; } catch (e) { return null; }
    }

    function sequenceFps(seq) {
        try {
            var tb = Number(seq.timebase);
            if (tb > 0) { return TICKS_PER_SECOND / tb; }
        } catch (e) {}
        return 30;
    }

    function safeCall(obj, name) {
        try {
            if (obj && typeof obj[name] === 'function') { return obj[name](); }
        } catch (e) {}
        return null;
    }

    function mediaPathOf(clip) {
        try {
            var pi = clip.projectItem;
            if (!pi) { return ''; }
            var p = pi.getMediaPath();
            return p ? String(p) : '';
        } catch (e) { return ''; }
    }

    function clipSpeed(clip) {
        var v = safeCall(clip, 'getSpeed');
        var n = Number(v);
        if (isNaN(n) || n <= 0) { return 1; }
        return n;
    }

    function describeClip(clip, trackIndex, clipIndex, kind) {
        var start = timeToSec(clip.start);
        var end = timeToSec(clip.end);
        var rec = {
            kind: kind,
            track: trackIndex,
            index: clipIndex,
            name: '',
            start: start,
            end: end,
            inPoint: timeToSec(clip.inPoint),
            outPoint: timeToSec(clip.outPoint),
            speed: clipSpeed(clip),
            disabled: false,
            mediaPath: '',
            isAdjustment: false
        };
        try { rec.name = String(clip.name); } catch (e) {}
        try { rec.disabled = (clip.disabled === true); } catch (e2) {}
        if (kind === 'audio') { rec.mediaPath = mediaPathOf(clip); }
        return rec;
    }

    function readTracks(seq, collection, kind, out) {
        var t, c, track, clip, n = 0;
        try { n = collection.numTracks; } catch (e) { n = 0; }
        for (t = 0; t < n; t++) {
            track = collection[t];
            var info = {
                index: t,
                name: '',
                muted: false,
                locked: false,
                clips: []
            };
            try { info.name = String(track.name); } catch (e1) {}
            try { info.muted = (safeCall(track, 'isMuted') === true); } catch (e2) {}
            try { info.locked = (track.isLocked && track.isLocked() === true); } catch (e3) {}
            var cn = 0;
            try { cn = track.clips.numItems; } catch (e4) { cn = 0; }
            for (c = 0; c < cn; c++) {
                try {
                    clip = track.clips[c];
                    if (!clip) { continue; }
                    info.clips.push(describeClip(clip, t, c, kind));
                } catch (e5) {
                    note('Skipped ' + kind + ' clip ' + t + '/' + c + ': ' + e5);
                }
            }
            out.push(info);
        }
    }

    /* ------------------------------------------------------------- public: ping */

    function ping() {
        var seq = activeSequence();
        return reply({
            ok: true,
            app: String(app.version),
            build: (app.build ? String(app.build) : ''),
            hasSequence: !!seq,
            sequenceName: seq ? String(seq.name) : '',
            scriptVersion: '1.0.0'
        });
    }

    /* ----------------------------------------------------- public: sequence info */

    function getSequenceInfo() {
        var seq = activeSequence();
        if (!seq) {
            return fail('No sequence is open. Open a sequence in Premiere and try again.');
        }

        var fps = sequenceFps(seq);
        var info = {
            ok: true,
            name: String(seq.name),
            sequenceID: '',
            fps: fps,
            duration: 0,
            audioTracks: [],
            videoTrackCount: 0,
            warnings: []
        };

        try { info.sequenceID = String(seq.sequenceID); } catch (e) {}
        try {
            var endRaw = seq.end;
            var endSec = (endRaw && endRaw.ticks !== undefined) ? timeToSec(endRaw) : Number(endRaw) / TICKS_PER_SECOND;
            if (!isNaN(endSec) && endSec > 0) { info.duration = endSec; }
        } catch (e2) {}
        try { info.videoTrackCount = seq.videoTracks.numTracks; } catch (e3) {}

        readTracks(seq, seq.audioTracks, 'audio', info.audioTracks);

        var total = 0, withMedia = 0, i, j;
        for (i = 0; i < info.audioTracks.length; i++) {
            for (j = 0; j < info.audioTracks[i].clips.length; j++) {
                total++;
                if (info.audioTracks[i].clips[j].mediaPath) { withMedia++; }
            }
        }
        if (total === 0) {
            info.warnings.push('This sequence has no audio clips, so there is nothing to analyse.');
        } else if (withMedia === 0) {
            info.warnings.push('None of the audio clips resolve to a file on disk (synthetic clips, offline media or merged clips).');
        } else if (withMedia < total) {
            info.warnings.push((total - withMedia) + ' of ' + total + ' audio clips have no file on disk and were skipped.');
        }

        // Fall back to the furthest clip end when seq.end is unhelpful.
        if (!info.duration || info.duration <= 0) {
            var maxEnd = 0;
            for (i = 0; i < info.audioTracks.length; i++) {
                for (j = 0; j < info.audioTracks[i].clips.length; j++) {
                    if (info.audioTracks[i].clips[j].end > maxEnd) { maxEnd = info.audioTracks[i].clips[j].end; }
                }
            }
            info.duration = maxEnd;
        }

        return reply(info);
    }

    /* ------------------------------------------------------------ backup bin */

    function findOrCreateBin(name) {
        var root = app.project.rootItem, i, child;
        for (i = 0; i < root.children.numItems; i++) {
            child = root.children[i];
            try {
                if (child.type === ProjectItemType.BIN && String(child.name) === name) { return child; }
            } catch (e) {}
        }
        try { return root.createBin(name); }
        catch (e2) { note('Could not create bin "' + name + '": ' + e2); return null; }
    }

    function sequenceIdSet() {
        var seen = {}, i;
        try {
            for (i = 0; i < app.project.sequences.numSequences; i++) {
                seen[String(app.project.sequences[i].sequenceID)] = true;
            }
        } catch (e) {}
        return seen;
    }

    function findProjectItemForSequence(seq) {
        // Newer Premiere exposes it directly; older builds need a tree walk by name.
        try { if (seq.projectItem) { return seq.projectItem; } } catch (e) {}
        var wanted = String(seq.name);
        function walk(item) {
            var i, child, hit;
            for (i = 0; i < item.children.numItems; i++) {
                child = item.children[i];
                try {
                    if (child.type === ProjectItemType.BIN) {
                        hit = walk(child);
                        if (hit) { return hit; }
                    } else if (String(child.name) === wanted && child.isSequence && child.isSequence()) {
                        return child;
                    }
                } catch (e2) {}
            }
            return null;
        }
        return walk(app.project.rootItem);
    }

    /**
     * Duplicates the active sequence into a backup bin and leaves the original active.
     * This runs before a single frame is touched - it is the undo button that does
     * not depend on the undo stack surviving a restart.
     */
    function makeBackup(seq, binName) {
        var before = sequenceIdSet();
        var bin = findOrCreateBin(binName);

        try { seq.clone(); }
        catch (e) { return { ok: false, error: 'Premiere refused to duplicate the sequence: ' + e }; }

        var clone = null, i, s;
        try {
            for (i = 0; i < app.project.sequences.numSequences; i++) {
                s = app.project.sequences[i];
                if (!before[String(s.sequenceID)]) { clone = s; break; }
            }
        } catch (e2) {}

        if (!clone) { return { ok: false, error: 'The sequence was duplicated but the copy could not be found in the project.' }; }

        var backupName = seq.name + ' [BACKUP ' + stamp() + ']';
        try { clone.name = backupName; } catch (e3) {}

        var item = findProjectItemForSequence(clone);
        if (item) {
            try { item.name = backupName; } catch (e4) {}
            if (bin) {
                try { item.moveBin(bin); }
                catch (e5) { note('Backup made, but it could not be moved into "' + binName + '": ' + e5); }
            }
        } else {
            note('Backup made, but its project item could not be located, so it stayed where Premiere put it.');
        }

        // Cloning makes the copy active; put the user back where they were.
        try { app.project.activeSequence = seq; } catch (e6) {
            return { ok: false, error: 'Backup created, but the original sequence could not be re-activated. Nothing was cut.' };
        }

        return { ok: true, name: backupName, bin: binName };
    }

    /* ----------------------------------------------------------------- razor */

    /*
     * QE's razor() takes a time string, and which spelling it accepts has moved
     * around between releases. Rather than guess, try each spelling and keep the
     * one that demonstrably split a clip - we always know, from the DOM clip count,
     * whether a cut landed.
     */
    var razorFormat = null;

    function razorCandidates(sec, fps) {
        return [
            { id: 'ticks',   value: String(Math.round(sec * TICKS_PER_SECOND)) },
            { id: 'tc',      value: secToTimecode(sec, fps, ':') },
            { id: 'tcDrop',  value: secToTimecode(sec, fps, ';') },
            { id: 'seconds', value: String(sec) }
        ];
    }

    function clipCount(domTrack) {
        try { return domTrack.clips.numItems; } catch (e) { return -1; }
    }

    function straddles(domTrack, sec) {
        var i, c, n = clipCount(domTrack);
        for (i = 0; i < n; i++) {
            try {
                c = domTrack.clips[i];
                if (timeToSec(c.start) < sec - EPS && timeToSec(c.end) > sec + EPS) { return true; }
            } catch (e) {}
        }
        return false;
    }

    /** Returns true when the boundary is clean afterwards (cut made, or none needed). */
    function razorAt(domTrack, qeTrack, sec, fps) {
        if (!straddles(domTrack, sec)) { return true; }   // already a through-edit or empty here
        if (!qeTrack) { return false; }

        var before = clipCount(domTrack);
        var cands = razorCandidates(sec, fps), i, c;

        if (razorFormat) {
            cands = [{ id: razorFormat, value: null }];
            var all = razorCandidates(sec, fps);
            for (i = 0; i < all.length; i++) { if (all[i].id === razorFormat) { cands[0].value = all[i].value; } }
        }

        for (i = 0; i < cands.length; i++) {
            c = cands[i];
            if (c.value === null) { continue; }
            try { qeTrack.razor(c.value); } catch (e) { continue; }
            if (clipCount(domTrack) > before) {
                if (!razorFormat) { note('QE razor accepts the "' + c.id + '" time format.'); }
                razorFormat = c.id;
                return true;
            }
        }

        if (razorFormat) {
            // The remembered format failed here; re-open the search next time.
            razorFormat = null;
        }
        return false;
    }

    /* ------------------------------------------------------- QE item removal */

    function qeTimeToSec(v, fps) {
        if (v === null || v === undefined) { return NaN; }
        try { if (v.ticks !== undefined && v.ticks !== null) { var t = Number(v.ticks); if (!isNaN(t)) { return t / TICKS_PER_SECOND; } } } catch (e) {}
        try { if (v.seconds !== undefined && v.seconds !== null) { var s = parseFloat(v.seconds); if (!isNaN(s)) { return s; } } } catch (e2) {}
        var str = String(v);
        var m = str.match(/^(\d+)[:;](\d+)[:;](\d+)[:;](\d+)$/);
        if (m) {
            return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / (fps || 30);
        }
        var n = Number(str);
        if (!isNaN(n)) { return n > 1e6 ? n / TICKS_PER_SECOND : n; }
        return NaN;
    }

    function qeItemIsEmpty(item) {
        try {
            var t = String(item.type);
            if (t === 'Empty' || t === 'empty') { return true; }
        } catch (e) {}
        try { if (item.name !== undefined && String(item.name) === '') { return true; } } catch (e2) {}
        return false;
    }

    /** Lifts (never ripples) the item that starts at `sec` on this track. */
    function removeAt(qeTrack, sec, fps) {
        if (!qeTrack) { return false; }
        var n = 0;
        try { n = qeTrack.numItems; } catch (e) { return false; }
        var i, item, s;
        for (i = 0; i < n; i++) {
            try { item = qeTrack.getItemAt(i); } catch (e2) { continue; }
            if (!item || qeItemIsEmpty(item)) { continue; }
            s = qeTimeToSec(item.start, fps);
            if (isNaN(s) || Math.abs(s - sec) > 0.002) { continue; }
            try { item.remove(false, false); return true; }
            catch (e3) { note('QE remove failed at ' + sec.toFixed(3) + 's: ' + e3); return false; }
        }
        return false;
    }

    /* ------------------------------------------------------------ geometry */

    function normaliseRegions(raw) {
        var list = [], i, r, s, e;
        for (i = 0; i < raw.length; i++) {
            r = raw[i];
            s = Number(r[0]);
            e = Number(r[1]);
            if (isNaN(s) || isNaN(e) || e - s <= EPS) { continue; }
            list.push([Math.max(0, s), e]);
        }
        list.sort(function (a, b) { return a[0] - b[0]; });

        var merged = [];
        for (i = 0; i < list.length; i++) {
            if (merged.length && list[i][0] <= merged[merged.length - 1][1] + EPS) {
                if (list[i][1] > merged[merged.length - 1][1]) { merged[merged.length - 1][1] = list[i][1]; }
            } else {
                merged.push([list[i][0], list[i][1]]);
            }
        }
        return merged;
    }

    function silenceBefore(regions, t) {
        var total = 0, i;
        for (i = 0; i < regions.length; i++) {
            if (regions[i][0] >= t - EPS) { break; }
            total += Math.min(regions[i][1], t) - regions[i][0];
        }
        return total;
    }

    function insideRegion(regions, start, end) {
        var i;
        for (i = 0; i < regions.length; i++) {
            if (start >= regions[i][0] - 0.002 && end <= regions[i][1] + 0.002) { return true; }
        }
        return false;
    }

    /* ------------------------------------------------------- track handles */

    function collectTracks(seq, qeSeq) {
        var tracks = [], i, n;

        try { n = seq.videoTracks.numTracks; } catch (e) { n = 0; }
        for (i = 0; i < n; i++) {
            tracks.push({
                kind: 'video',
                index: i,
                dom: seq.videoTracks[i],
                qe: qeSeq ? safeIndex(qeSeq, 'getVideoTrackAt', i) : null
            });
        }
        try { n = seq.audioTracks.numTracks; } catch (e2) { n = 0; }
        for (i = 0; i < n; i++) {
            tracks.push({
                kind: 'audio',
                index: i,
                dom: seq.audioTracks[i],
                qe: qeSeq ? safeIndex(qeSeq, 'getAudioTrackAt', i) : null
            });
        }
        return tracks;
    }

    function safeIndex(obj, method, i) {
        try { return obj[method](i); } catch (e) { return null; }
    }

    function lockedTrackNames(tracks) {
        var names = [], i, t, locked;
        for (i = 0; i < tracks.length; i++) {
            t = tracks[i];
            locked = false;
            try { if (typeof t.dom.isLocked === 'function') { locked = (t.dom.isLocked() === true); } } catch (e) {}
            if (locked) { names.push((t.kind === 'video' ? 'V' : 'A') + (t.index + 1)); }
        }
        return names;
    }

    function moveClip(clip, deltaSec) {
        if (Math.abs(deltaSec) < EPS) { return true; }
        var before = timeToSec(clip.start);
        var target = before + deltaSec;

        var t = new Time();
        try { t.ticks = String(Math.round(deltaSec * TICKS_PER_SECOND)); }
        catch (e) { t.seconds = deltaSec; }
        try { clip.move(t); } catch (e2) { note('move() threw: ' + e2); }

        if (Math.abs(timeToSec(clip.start) - target) < 0.002) { return true; }

        // Some builds want seconds rather than ticks.
        var t2 = new Time();
        try {
            t2.seconds = deltaSec;
            clip.move(t2);
        } catch (e3) {}
        return Math.abs(timeToSec(clip.start) - target) < 0.002;
    }

    function supportsMove(tracks) {
        var i, j, n;
        for (i = 0; i < tracks.length; i++) {
            n = clipCount(tracks[i].dom);
            for (j = 0; j < n; j++) {
                try { return typeof tracks[i].dom.clips[j].move === 'function'; } catch (e) {}
            }
        }
        return true;   // nothing to check against; let it run
    }

    /* ------------------------------------------------------ public: applyCuts */

    /**
     * opts = {
     *   regions:       [[startSec, endSec], ...]   silence to remove
     *   backup:        true,
     *   backupBinName: "Silencer Backups",
     *   sequenceName:  "..."                       sanity check against the panel
     * }
     */
    function applyCuts(optsJson) {
        var opts;
        try { opts = JSON.parse(optsJson); }
        catch (e) { return fail('Could not read the options sent by the panel: ' + e); }

        var seq = activeSequence();
        if (!seq) { return fail('No sequence is open.'); }

        if (opts.sequenceName && String(seq.name) !== String(opts.sequenceName)) {
            return fail('The active sequence changed to "' + seq.name + '" since you analysed "' +
                        opts.sequenceName + '". Re-analyse before cutting.');
        }

        var regions = normaliseRegions(opts.regions || []);
        if (!regions.length) { return fail('There is nothing to cut.'); }

        var fps = sequenceFps(seq);
        var qeSeq = null;
        try { app.enableQE(); qeSeq = qe.project.getActiveSequence(); } catch (e2) {}
        if (!qeSeq) {
            return fail('Premiere’s scripting engine (QE) is unavailable, so clips cannot be split. ' +
                        'Restart Premiere and try again.');
        }

        var tracks = collectTracks(seq, qeSeq);
        var locked = lockedTrackNames(tracks);
        if (locked.length) {
            return fail('Unlock these tracks first, otherwise the cuts would knock them out of sync: ' + locked.join(', '));
        }
        if (!supportsMove(tracks)) {
            return fail('This version of Premiere cannot move clips from a script (TrackItem.move is missing). ' +
                        'Premiere Pro 2020 (14.0) or newer is required for cutting; the Markers mode still works.');
        }

        /* --- backup before anything destructive ------------------------------ */
        var backup = null;
        if (opts.backup !== false) {
            var b = makeBackup(seq, opts.backupBinName || 'Silencer Backups');
            if (!b.ok) { return fail('Backup failed, so nothing was cut: ' + b.error); }
            backup = b.name;
            seq = activeSequence();
            try { app.enableQE(); qeSeq = qe.project.getActiveSequence(); } catch (e3) {}
            tracks = collectTracks(seq, qeSeq);
        }

        /* --- pass A: split every track at every region boundary --------------- */
        var accepted = [], rejected = [], i, k, t, okStart, okEnd;
        for (i = 0; i < regions.length; i++) {
            okStart = true;
            okEnd = true;
            for (k = 0; k < tracks.length; k++) {
                t = tracks[k];
                if (!razorAt(t.dom, t.qe, regions[i][0], fps)) { okStart = false; }
                if (!razorAt(t.dom, t.qe, regions[i][1], fps)) { okEnd = false; }
            }
            if (okStart && okEnd) { accepted.push(regions[i]); }
            else { rejected.push(regions[i]); }
        }

        if (!accepted.length) {
            return fail('None of the cuts could be made - Premiere would not split the clips at those points. ' +
                        'Transitions sitting on a cut point are the usual cause.',
                        { backup: backup, skipped: rejected.length });
        }

        /* --- pass B: lift the silent segments out ----------------------------- */
        var removed = 0, failedRemovals = 0, n, c, starts, s, e;
        for (k = 0; k < tracks.length; k++) {
            t = tracks[k];
            starts = [];
            n = clipCount(t.dom);
            for (i = 0; i < n; i++) {
                try {
                    c = t.dom.clips[i];
                    s = timeToSec(c.start);
                    e = timeToSec(c.end);
                    if (insideRegion(accepted, s, e)) { starts.push(s); }
                } catch (eB) {}
            }
            // Highest first, so earlier matches stay valid while the list shrinks.
            starts.sort(function (a, b) { return b - a; });
            for (i = 0; i < starts.length; i++) {
                if (removeAt(t.qe, starts[i], fps)) { removed++; }
                else { failedRemovals++; }
            }
        }

        /* --- pass C: slide what is left back to close the gaps ---------------- */
        var moved = 0, failedMoves = 0, plan, shift;
        for (k = 0; k < tracks.length; k++) {
            t = tracks[k];
            plan = [];
            n = clipCount(t.dom);
            for (i = 0; i < n; i++) {
                try {
                    c = t.dom.clips[i];
                    s = timeToSec(c.start);
                    shift = silenceBefore(accepted, s);
                    if (shift > EPS) { plan.push({ start: s, shift: shift }); }
                } catch (eC) {}
            }
            // Left to right, so the space a clip moves into is always vacant already.
            plan.sort(function (a, b) { return a.start - b.start; });
            for (i = 0; i < plan.length; i++) {
                var target = null, nn = clipCount(t.dom), jj;
                for (jj = 0; jj < nn; jj++) {
                    try {
                        if (Math.abs(timeToSec(t.dom.clips[jj].start) - plan[i].start) < 0.002) {
                            target = t.dom.clips[jj];
                            break;
                        }
                    } catch (eD) {}
                }
                if (!target) { continue; }
                if (moveClip(target, -plan[i].shift)) { moved++; } else { failedMoves++; }
            }
        }

        var removedDuration = 0;
        for (i = 0; i < accepted.length; i++) { removedDuration += accepted[i][1] - accepted[i][0]; }

        var warnings = [];
        if (rejected.length) {
            warnings.push(rejected.length + ' cut' + (rejected.length === 1 ? ' was' : 's were') +
                          ' skipped because Premiere would not split a clip there (transitions are the usual cause).');
        }
        if (failedRemovals) { warnings.push(failedRemovals + ' silent segment(s) could not be deleted.'); }
        if (failedMoves) { warnings.push(failedMoves + ' clip(s) could not be slid back - check the end of the timeline for gaps.'); }

        return reply({
            ok: true,
            backup: backup,
            cuts: accepted.length,
            skipped: rejected.length,
            segmentsRemoved: removed,
            clipsMoved: moved,
            removedDuration: removedDuration,
            warnings: warnings
        });
    }

    /* -------------------------------------------------- public: markers only */

    function addMarkers(optsJson) {
        var opts;
        try { opts = JSON.parse(optsJson); }
        catch (e) { return fail('Could not read the options sent by the panel: ' + e); }

        var seq = activeSequence();
        if (!seq) { return fail('No sequence is open.'); }

        var regions = normaliseRegions(opts.regions || []);
        if (!regions.length) { return fail('There is nothing to mark.'); }

        var made = 0, i, m;
        for (i = 0; i < regions.length; i++) {
            try {
                m = seq.markers.createMarker(regions[i][0]);
                if (!m) { continue; }
                try { m.name = 'Silence ' + (i + 1); } catch (e1) {}
                try { m.comments = (regions[i][1] - regions[i][0]).toFixed(2) + 's of silence'; } catch (e2) {}
                try { m.end.seconds = regions[i][1]; } catch (e3) {}
                try { m.setColorByIndex(1); } catch (e4) {}
                made++;
            } catch (e5) {
                note('Marker at ' + regions[i][0].toFixed(2) + 's failed: ' + e5);
            }
        }

        if (!made) { return fail('Premiere would not accept any markers on this sequence.'); }
        return reply({ ok: true, markers: made });
    }

    /* ----------------------------------------------- public: backup on its own */

    function backupOnly(optsJson) {
        var opts = {};
        try { if (optsJson) { opts = JSON.parse(optsJson); } } catch (e) {}
        var seq = activeSequence();
        if (!seq) { return fail('No sequence is open.'); }
        var b = makeBackup(seq, opts.backupBinName || 'Silencer Backups');
        if (!b.ok) { return fail(b.error); }
        return reply({ ok: true, backup: b.name });
    }

    return {
        ping: ping,
        getSequenceInfo: getSequenceInfo,
        applyCuts: applyCuts,
        addMarkers: addMarkers,
        backupOnly: backupOnly,

        // Pure helpers, exposed so the test harness can check the arithmetic
        // that decides where clips land. Not part of the panel's API.
        _internals: {
            normaliseRegions: normaliseRegions,
            silenceBefore: silenceBefore,
            insideRegion: insideRegion,
            secToTimecode: secToTimecode
        }
    };

}());
