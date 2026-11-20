// =====================================================================
// 🧠 ADSUM FACE ENGINE
// Pure logic shared by the scanner (index.js) and registration.js:
//   • Model loading
//   • FaceGallery  → multi-sample matching with margin (open-set recognition)
//   • FaceTracker  → follows each face between frames (IoU) + temporal voting
//   • Liveness     → blink detection that rejects photos / ID cards
//   • Quality      → checks a sample is good enough to be stored
// No DOM manipulation and no Firebase here, so it can be unit-tested.
// =====================================================================

// ---------------------------------------------------------------------
// MODELS
// ---------------------------------------------------------------------
export async function loadModels({ ssd = false, tiny = true } = {}) {
    const nets = [
        faceapi.nets.faceLandmark68Net.loadFromUri(CONFIG.MODEL_PATH),
        faceapi.nets.faceRecognitionNet.loadFromUri(CONFIG.MODEL_PATH),
    ];
    if (tiny) nets.push(faceapi.nets.tinyFaceDetector.loadFromUri(CONFIG.MODEL_PATH));
    if (ssd) nets.push(faceapi.nets.ssdMobilenetv1.loadFromUri(CONFIG.MODEL_PATH));
    await Promise.all(nets);
}

export function tinyDetectorOptions() {
    return new faceapi.TinyFaceDetectorOptions({
        inputSize: CONFIG.DETECTION.INPUT_SIZE,
        scoreThreshold: CONFIG.DETECTION.SCORE_THRESHOLD,
    });
}

/**
 * Computes the 128-D descriptor for an already-detected face.
 * Uses EXACTLY the same alignment face-api uses inside `.withFaceDescriptors()`
 * (dlib alignment), so descriptors are comparable with the stored ones,
 * but lets us decide WHEN to pay for this expensive step.
 */
export async function computeDescriptor(input, withLandmarks) {
    const alignedBox = withLandmarks.landmarks.align(null, { useDlibAlignment: true });
    const [faceCanvas] = await faceapi.extractFaces(input, [alignedBox]);
    return faceapi.computeFaceDescriptor(faceCanvas);
}

// ---------------------------------------------------------------------
// DATABASE FORMAT HELPERS
// Firestore can't store nested arrays, so samples are stored as
//   descriptors: [ { v: [128 numbers], src: "camera"|"upload"|"auto"|"legacy", at: ISO } ]
// Old users only have `descriptor: [128 numbers]` → still supported.
// ---------------------------------------------------------------------
export function readSamples(userData) {
    const samples = [];
    if (Array.isArray(userData.descriptors)) {
        userData.descriptors.forEach(s => {
            if (s && Array.isArray(s.v) && s.v.length === 128) {
                samples.push({ v: new Float32Array(s.v), src: s.src || "unknown", at: s.at || null });
            }
        });
    }
    if (samples.length === 0 && Array.isArray(userData.descriptor) && userData.descriptor.length === 128) {
        samples.push({ v: new Float32Array(userData.descriptor), src: "legacy", at: userData.registrationDate || null });
    }
    return samples;
}

export function serializeSample(descriptor, src) {
    return { v: Array.from(descriptor, x => Math.round(x * 1e6) / 1e6), src, at: new Date().toISOString() };
}

export function euclidean(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
    return Math.sqrt(sum);
}

// ---------------------------------------------------------------------
// GALLERY — "who is this?"
// ---------------------------------------------------------------------
export class FaceGallery {
    /** @param {Array<{id:string, name:string, samples:Array<{v:Float32Array}>}>} people */
    constructor(people = []) {
        this.people = people.filter(p => p.samples && p.samples.length > 0);
    }

    get size() { return this.people.length; }

    get(id) { return this.people.find(p => p.id === id) || null; }

    /** Distance from a descriptor to every person (min over that person's samples). Sorted ascending. */
    rank(descriptor) {
        return this.people
            .map(p => ({ id: p.id, name: p.name, distance: Math.min(...p.samples.map(s => euclidean(descriptor, s.v))) }))
            .sort((a, b) => a.distance - b.distance);
    }

    /**
     * Open-set match: returns the best person only if
     *   1) best distance ≤ ACCEPT_DISTANCE, AND
     *   2) the 2nd-best DIFFERENT person is at least MIN_MARGIN farther.
     * Rule 2 avoids confusing two similar-looking students.
     */
    match(descriptor, { acceptDistance = CONFIG.RECOGNITION.ACCEPT_DISTANCE, minMargin = CONFIG.RECOGNITION.MIN_MARGIN } = {}) {
        const ranking = this.rank(descriptor);
        if (ranking.length === 0) return { accepted: false, id: null, name: null, distance: Infinity, margin: Infinity };
        const best = ranking[0];
        const second = ranking[1];
        const margin = second ? second.distance - best.distance : Infinity;
        const accepted = best.distance <= acceptDistance && margin >= minMargin;
        return { accepted, id: best.id, name: best.name, distance: best.distance, margin };
    }

    /** Smallest distance between this descriptor and a given person's samples. */
    novelty(id, descriptor) {
        const p = this.get(id);
        if (!p) return Infinity;
        return Math.min(...p.samples.map(s => euclidean(descriptor, s.v)));
    }
}

// ---------------------------------------------------------------------
// GEOMETRY HELPERS
// ---------------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (pts) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

/** Eye Aspect Ratio (Soukupová & Čech, 2016). ~0.25–0.35 open, < ~0.2 closed. */
export function eyeAspectRatio(eye) {
    // eye = 6 points: [0] corner, [1],[2] top, [3] corner, [4],[5] bottom
    const vertical = dist(eye[1], eye[5]) + dist(eye[2], eye[4]);
    const horizontal = 2 * dist(eye[0], eye[3]);
    return horizontal > 0 ? vertical / horizontal : 0;
}

/**
 * Vertical proportion of the face (eyes → nose tip, divided by the distance between eyes).
 * Blinking does NOT change it; tilting a printed photo backwards DOES (it squashes vertically).
 */
export function faceShapeRatio(landmarks) {
    const pts = landmarks.positions;
    const leftEye = mid(landmarks.getLeftEye());
    const rightEye = mid(landmarks.getRightEye());
    const interocular = dist(leftEye, rightEye);
    const noseTip = pts[33];
    return interocular > 0 ? dist(mid([leftEye, rightEye]), noseTip) / interocular : 0;
}

/** Rough head yaw: 0 = frontal. Nose horizontal offset from the eye midpoint, normalized. */
export function estimateYaw(landmarks) {
    const leftEye = mid(landmarks.getLeftEye());
    const rightEye = mid(landmarks.getRightEye());
    const interocular = dist(leftEye, rightEye);
    const noseTip = landmarks.positions[30];
    return interocular > 0 ? (noseTip.x - (leftEye.x + rightEye.x) / 2) / interocular : 0;
}

function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// ---------------------------------------------------------------------
// LIVENESS — blink detector (one per tracked face)
//
// Two independent signals; a blink on EITHER of them passes:
//
//  A) GEOMETRY (EAR): eye landmarks get flatter when the eye closes.
//     Guard: the face proportions must stay stable (a tilted photo squashes
//     the whole face, a real blink only the eyes).
//
//  B) APPEARANCE: the eye pixels (iris/sclera) are briefly replaced by the
//     eyelid, while a reference patch (bridge of the nose) stays identical.
//     Compares each frame against a learned "open eyes" template using
//     normalized correlation (robust to lighting changes).
//     Guard: if the reference patch ALSO changes, it's motion/blur → ignored.
//
// A printed photo / ID card / photo on a phone produces neither.
// ---------------------------------------------------------------------
const PATCH_W = 24, PATCH_H = 12, REF_SIZE = 16;
let patchCanvas = null;

function samplePatch(source, cx, cy, w, h, outW, outH) {
    if (!patchCanvas) {
        patchCanvas = document.createElement("canvas");
        patchCanvas.width = 64; patchCanvas.height = 64;
    }
    const ctx = patchCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, cx - w / 2, cy - h / 2, w, h, 0, 0, outW, outH);
    const { data } = ctx.getImageData(0, 0, outW, outH);
    const v = new Float32Array(outW * outH);
    let mean = 0;
    for (let i = 0; i < v.length; i++) { v[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]; mean += v[i]; }
    mean /= v.length;
    let sd = 0;
    for (let i = 0; i < v.length; i++) { v[i] -= mean; sd += v[i] * v[i]; }
    sd = Math.sqrt(sd / v.length) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= sd;
    return v;
}

/** Normalized cross-correlation of two zero-mean/unit-std patches: 1 = identical, 0 = unrelated. */
export function correlation(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s / a.length;
}

/** Extracts the 2 eye patches + the reference patch, positioned and scaled by the landmarks. */
export function extractEyePatches(source, landmarks) {
    const le = landmarks.getLeftEye(), re = landmarks.getRightEye();
    const lc = mid(le), rc = mid(re);
    const io = dist(lc, rc);
    const ew = io * 0.62, eh = io * 0.31;   // eye box ~ eye width x half of it
    const bridge = landmarks.positions[28];  // bridge of the nose
    return {
        left: samplePatch(source, lc.x, lc.y, ew, eh, PATCH_W, PATCH_H),
        right: samplePatch(source, rc.x, rc.y, ew, eh, PATCH_W, PATCH_H),
        ref: samplePatch(source, bridge.x, bridge.y, io * 0.45, io * 0.45, REF_SIZE, REF_SIZE),
    };
}

function blendTemplate(tpl, patch, alpha) {
    if (!tpl) return Float32Array.from(patch);
    for (let i = 0; i < tpl.length; i++) tpl[i] = tpl[i] * (1 - alpha) + patch[i] * alpha;
    return tpl;
}

export class BlinkLiveness {
    constructor(cfg = CONFIG.LIVENESS) {
        this.cfg = cfg;
        this.passed = !cfg.ENABLED;
        this.blinks = 0;
        this.passedBy = null;
        // A) geometry
        this.openEars = [];
        this.openShapes = [];
        this.earState = "open";
        this.earClosedAt = 0;
        this.maxShapeDeviation = 0;
        this.lastEar = 0;
        // B) appearance
        this.tpl = { left: null, right: null, ref: null };
        this.tplSamples = 0;
        this.appState = "open";
        this.appClosedAt = 0;
        this.lastEyeCorr = 1;
        this.lastRefCorr = 1;
        this.lastGoodAt = 0;
    }

    get baseline() { return percentile(this.openEars, 0.8); }

    /** True while the eyes are closed (either signal) → the scanner skips heavy work to not miss the reopening. */
    get isClosing() { return this.earState === "closed" || this.appState === "closed"; }

    /**
     * Feed one frame.
     * @param landmarks  face-api FaceLandmarks68
     * @param now        timestamp in ms
     * @param source     (optional) the frame canvas → enables the appearance signal
     * @returns true once a valid blink has been seen
     */
    update(landmarks, now, source = null) {
        if (!this.cfg.ENABLED) return (this.passed = true);
        if (this._geometry(landmarks, now)) this._pass("geometry");
        if (source && this._appearance(extractEyePatches(source, landmarks), now)) this._pass("appearance");
        return this.passed;
    }

    /** Same as update() but with pre-extracted patches (used by unit tests). */
    updateWithPatches(landmarks, now, patches) {
        if (!this.cfg.ENABLED) return (this.passed = true);
        if (landmarks && this._geometry(landmarks, now)) this._pass("geometry");
        if (patches && this._appearance(patches, now)) this._pass("appearance");
        return this.passed;
    }

    _pass(by) { this.blinks++; if (!this.passed) this.passedBy = by; this.passed = true; }

    // --- A) Eye Aspect Ratio --------------------------------------------
    _geometry(landmarks, now) {
        const c = this.cfg;
        const ear = (eyeAspectRatio(landmarks.getLeftEye()) + eyeAspectRatio(landmarks.getRightEye())) / 2;
        const shape = faceShapeRatio(landmarks);
        this.lastEar = ear;
        const baseline = this.baseline;
        const ready = this.openEars.length >= c.MIN_BASELINE_SAMPLES;
        let blink = false;

        if (this.earState === "open") {
            if (ready && ear < baseline * c.CLOSED_RATIO) {
                this.earState = "closed";
                this.earClosedAt = now;
                this.maxShapeDeviation = this._shapeDeviation(shape);
            } else {
                this._pushOpen(ear, shape); // always keep the baseline fresh (squinting, new posture, light)
            }
        } else {
            this.maxShapeDeviation = Math.max(this.maxShapeDeviation, this._shapeDeviation(shape));
            if (ear > baseline * c.REOPEN_RATIO) {
                blink = now - this.earClosedAt <= c.MAX_BLINK_MS && this.maxShapeDeviation <= c.MAX_FACE_SHAPE_CHANGE;
                this.earState = "open";
                this._pushOpen(ear, shape);
            } else if (now - this.earClosedAt > c.MAX_BLINK_MS * 2) {
                this.earState = "open"; // closed too long → not a blink; re-learn
                this.openEars = []; this.openShapes = [];
            }
        }
        return blink;
    }

    _pushOpen(ear, shape) {
        this.openEars.push(ear); this.openShapes.push(shape);
        if (this.openEars.length > 30) this.openEars.shift();
        if (this.openShapes.length > 30) this.openShapes.shift();
    }

    _shapeDeviation(shape) {
        const ref = percentile(this.openShapes, 0.5);
        return ref > 0 ? Math.abs(shape - ref) / ref : 0;
    }

    // --- B) Eye appearance ----------------------------------------------
    _appearance(p, now) {
        const c = this.cfg;
        if (this.tplSamples < c.MIN_BASELINE_SAMPLES) {
            // Learn what this face's OPEN eyes look like
            const a = 1 / (this.tplSamples + 1);
            this.tpl.left = blendTemplate(this.tpl.left, p.left, a);
            this.tpl.right = blendTemplate(this.tpl.right, p.right, a);
            this.tpl.ref = blendTemplate(this.tpl.ref, p.ref, a);
            this.tplSamples++;
            this.lastGoodAt = now;
            return false;
        }
        const eyeCorr = (correlation(p.left, this.tpl.left) + correlation(p.right, this.tpl.right)) / 2;
        const refCorr = correlation(p.ref, this.tpl.ref);
        this.lastEyeCorr = eyeCorr; this.lastRefCorr = refCorr;
        const stable = refCorr >= c.REF_MIN_CORR; // the rest of the face didn't change
        let blink = false;

        if (this.appState === "open") {
            if (stable && eyeCorr < c.EYE_CLOSED_CORR) {
                this.appState = "closed";
                this.appClosedAt = now;
            } else if (stable && eyeCorr > c.EYE_OPEN_CORR) {
                // slowly adapt the template (lighting changes, small head moves)
                this.tpl.left = blendTemplate(this.tpl.left, p.left, 0.15);
                this.tpl.right = blendTemplate(this.tpl.right, p.right, 0.15);
                this.tpl.ref = blendTemplate(this.tpl.ref, p.ref, 0.15);
                this.lastGoodAt = now;
            } else if (now - this.lastGoodAt > c.RELEARN_AFTER_MS) {
                // The template no longer matches (new posture / lighting): learn it again instead of
                // staying stuck until the face leaves the screen.
                this.tplSamples = 0; this.tpl = { left: null, right: null, ref: null };
            }
        } else {
            if (!stable) {
                this.appState = "open"; // face moved during the "blink" → discard
            } else if (eyeCorr > c.EYE_OPEN_CORR) {
                blink = now - this.appClosedAt <= c.MAX_BLINK_MS;
                this.appState = "open";
                this.lastGoodAt = now;
            } else if (now - this.appClosedAt > c.MAX_BLINK_MS * 2) {
                this.appState = "open";
                this.tplSamples = 0; this.tpl = { left: null, right: null, ref: null }; // re-learn
            }
        }
        return blink;
    }
}

// ---------------------------------------------------------------------
// TRACKER — keeps identity + liveness per face between frames
// ---------------------------------------------------------------------
function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.width * a.height + b.width * b.height - inter;
    return union > 0 ? inter / union : 0;
}

let nextTrackId = 1;

export class FaceTracker {
    constructor() { this.tracks = []; }

    /**
     * @param detections array of face-api WithFaceLandmarks results
     * @param now        timestamp (ms)
     * @param source     the frame the detections come from (needed for appearance liveness)
     * @returns the tracks seen this frame
     */
    update(detections, now, source = null) {
        const unmatched = new Set(this.tracks);
        const seen = [];
        // Greedy matching: biggest faces first
        const sorted = [...detections].sort((a, b) => b.detection.box.area - a.detection.box.area);
        for (const det of sorted) {
            const box = det.detection.box;
            let best = null, bestIou = CONFIG.DETECTION.TRACK_IOU;
            for (const t of unmatched) {
                const o = iou(t.box, box);
                if (o > bestIou) { best = t; bestIou = o; }
            }
            if (!best) {
                best = {
                    id: nextTrackId++, firstSeen: now, votes: [], lastRecognizedAt: 0,
                    liveness: new BlinkLiveness(), livenessSince: now, identity: null, lastMatch: null, markedAt: 0,
                };
                this.tracks.push(best);
            } else {
                unmatched.delete(best);
            }
            best.box = { x: box.x, y: box.y, width: box.width, height: box.height };
            best.det = det;
            best.lastSeen = now;
            // Safety net: if this face hasn't passed liveness for a long time, start the detector over.
            if (!best.live && now - best.livenessSince > CONFIG.LIVENESS.RESET_AFTER_MS) {
                best.liveness = new BlinkLiveness();
                best.livenessSince = now;
            }
            best.live = best.liveness.update(det.landmarks, now, source);
            seen.push(best);
        }
        this.tracks = this.tracks.filter(t => now - t.lastSeen < CONFIG.DETECTION.TRACK_TTL_MS);
        return seen;
    }

    clear() { this.tracks = []; }
}

/** Adds a recognition result to a track and returns the stable identity (or null). */
export function addVote(track, matchResult) {
    track.lastMatch = matchResult;
    track.votes.push(matchResult.accepted ? matchResult.id : null);
    if (track.votes.length > CONFIG.RECOGNITION.VOTE_WINDOW) track.votes.shift();

    const counts = {};
    track.votes.forEach(v => { if (v) counts[v] = (counts[v] || 0) + 1; });
    const [topId, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    track.identity = topCount >= CONFIG.RECOGNITION.VOTES_REQUIRED ? topId : null;
    return track.identity;
}

// ---------------------------------------------------------------------
// QUALITY GATE (registration)
// ---------------------------------------------------------------------
/**
 * @param det     face-api result WithFaceLandmarks (detection + landmarks)
 * @param source  the image/canvas/video the face was detected in
 * @returns {{ok:boolean, issues:string[], metrics:object}}
 */
export function assessQuality(det, source) {
    const C = CONFIG.ENROLLMENT;
    const box = det.detection.box;
    const issues = [];

    const metrics = {
        score: det.detection.score,
        width: box.width,
        yaw: Math.abs(estimateYaw(det.landmarks)),
        ...lumaStats(source, box),
    };

    if (metrics.score < C.MIN_DETECTION_SCORE) issues.push("face not clear enough");
    if (metrics.width < C.MIN_FACE_PX) issues.push("face too small / too far");
    if (metrics.yaw > C.MAX_YAW) issues.push("look straight at the camera");
    if (metrics.brightness < C.MIN_BRIGHTNESS) issues.push("too dark");
    if (metrics.brightness > C.MAX_BRIGHTNESS) issues.push("too bright / overexposed");
    if (metrics.sharpness < C.MIN_SHARPNESS) issues.push("blurry");

    return { ok: issues.length === 0, issues, metrics };
}

/** Mean brightness and sharpness (variance of Laplacian) of the face region, normalized to 128x128. */
function lumaStats(source, box) {
    const N = 128;
    const canvas = document.createElement("canvas");
    canvas.width = N; canvas.height = N;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, N, N);
    const { data } = ctx.getImageData(0, 0, N, N);

    const gray = new Float32Array(N * N);
    let sum = 0;
    for (let i = 0; i < N * N; i++) {
        const g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
        gray[i] = g; sum += g;
    }
    let lapSum = 0, lapSq = 0, n = 0;
    for (let y = 1; y < N - 1; y++) {
        for (let x = 1; x < N - 1; x++) {
            const i = y * N + x;
            const lap = gray[i - N] + gray[i + N] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
            lapSum += lap; lapSq += lap * lap; n++;
        }
    }
    const mean = lapSum / n;
    return { brightness: sum / (N * N), sharpness: lapSq / n - mean * mean };
}
