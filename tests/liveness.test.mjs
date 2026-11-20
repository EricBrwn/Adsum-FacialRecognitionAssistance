// Run: node tests/liveness.test.mjs   (pure logic, no browser needed)
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const cfgSrc = fs.readFileSync(new URL("../www/js/config.js", import.meta.url), "utf8");
vm.runInThisContext(cfgSrc.replace("const CONFIG", "globalThis.CONFIG"));
const E = await import("../www/js/face-engine.js");

// Synthetic normalized patches
const rnd = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
const norm = (v) => { const m = v.reduce((a, b) => a + b) / v.length; const c = v.map(x => x - m); const s = Math.sqrt(c.reduce((a, b) => a + b * b) / c.length); return Float32Array.from(c.map(x => x / s)); };
const patch = (seed, n) => { const r = rnd(seed); return norm(Array.from({ length: n }, r)); };
const mix = (a, b, t) => norm(Array.from(a, (x, i) => x * (1 - t) + b[i] * t));
const OPEN = { left: patch(11, 288), right: patch(12, 288), ref: patch(13, 256) };
const CLOSED = { left: patch(21, 288), right: patch(22, 288), ref: OPEN.ref };
const MOVED = { left: mix(OPEN.left, patch(31, 288), 0.6), right: mix(OPEN.right, patch(32, 288), 0.6), ref: mix(OPEN.ref, patch(33, 256), 0.6) };

function run(seq, frameMs = 80) {
    const L = new E.BlinkLiveness(CONFIG.LIVENESS);
    seq.forEach((p, i) => L.updateWithPatches(null, i * frameMs, p));
    return L.passed;
}
const rep = (p, n) => Array(n).fill(p);
// The student changes posture / the light changes: everything about the "open eyes" look is different
// from what was learned at the start, and stays different.
const OPEN2 = { left: patch(41, 288), right: patch(42, 288), ref: patch(43, 256) };
const CLOSED2 = { left: patch(51, 288), right: patch(52, 288), ref: OPEN2.ref };
const cases = {
    "natural blink (240 ms @ 12 fps)": [[...rep(OPEN, 8), ...rep(CLOSED, 3), ...rep(OPEN, 3)], true],
    "very fast blink (1 frame)": [[...rep(OPEN, 8), CLOSED, ...rep(OPEN, 3)], true],
    "static photo": [rep(OPEN, 40), false],
    "eyes closed too long (1 s) — not a blink": [[...rep(OPEN, 8), ...rep(CLOSED, 13), ...rep(OPEN, 3)], false],
    "photo moved/shaken (everything changes)": [[...rep(OPEN, 8), ...rep(MOVED, 3), ...rep(OPEN, 3)], false],
    "blink before template is learned": [[OPEN, CLOSED, OPEN], false],
    "blink after changing posture/light (must not stay stuck)": [[...rep(OPEN, 8), ...rep(OPEN2, 40), ...rep(CLOSED2, 3), ...rep(OPEN2, 3)], true],
    "blink at slow tablet speed (500 ms between frames)": [[...rep(OPEN, 8), CLOSED, ...rep(OPEN, 3)], true, 500],
};
let fails = 0;
for (const [name, [seq, expected, frameMs]] of Object.entries(cases)) {
    const got = run(seq, frameMs);
    console.log(`${got === expected ? "✅" : "❌"} ${name}: passed=${got}`);
    if (got !== expected) fails++;
}

// isClosing: the scanner uses it to skip heavy work while the eyes are closed
{
    const L = new E.BlinkLiveness(CONFIG.LIVENESS);
    rep(OPEN, 8).forEach((p, i) => L.updateWithPatches(null, i * 80, p));
    assert.equal(L.isClosing, false);
    L.updateWithPatches(null, 700, CLOSED);
    assert.equal(L.isClosing, true);
    console.log("✅ isClosing is true while the eyes are closed");
}

// Gallery: margin rule
const g = new E.FaceGallery([
    { id: "a", name: "A", samples: [{ v: new Float32Array(128).fill(0) }] },
    { id: "b", name: "B", samples: [{ v: new Float32Array(128).fill(0.04) }] }, // B is 0.45 away from A
]);
const probe = new Float32Array(128).fill(0.005); // close to A (0.057) but also close-ish to B
const m = g.match(probe);
assert.equal(m.id, "a");
console.log(`✅ gallery match: best=${m.id} d=${m.distance.toFixed(3)} margin=${m.margin.toFixed(3)} accepted=${m.accepted}`);
const ambiguous = g.match(new Float32Array(128).fill(0.02)); // exactly between A and B
assert.equal(ambiguous.accepted, false);
console.log(`✅ ambiguous face between two students is rejected (margin=${ambiguous.margin.toFixed(3)})`);

// Votes
const t = { votes: [] };
["a", null, "a", "a"].forEach(id => E.addVote(t, { accepted: !!id, id }));
assert.equal(t.identity, "a");
console.log("✅ temporal vote: 3 of last 5 → identity confirmed");

process.exit(fails ? 1 : 0);
