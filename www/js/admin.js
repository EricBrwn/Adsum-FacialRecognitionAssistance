// =====================================================================
// 🔐 ADSUM ADMIN CONSOLE
//   • Register teachers
//   • Calibrate the recognition threshold with the REAL database
//   • Per-device overrides (threshold / liveness) stored in localStorage
// =====================================================================
import * as data from "./data.js";
import { euclidean } from "./face-engine.js";

// ---------------------------------------------------------------------
// TEACHERS
// ---------------------------------------------------------------------
async function registerNewTeacher() {
    const name = document.getElementById("newTeacherName").value.trim();
    const email = document.getElementById("newTeacherEmail").value.trim().toLowerCase();
    const groupsInput = document.getElementById("newTeacherGroups").value.trim();

    if (!name || !email || !groupsInput) { alert("⚠️ All fields are required."); return; }
    const groups = [...new Set(groupsInput.split(",").map((g) => g.trim()).filter(Boolean))];

    try {
        await data.saveTeacher(email, { name, groups });
        alert(`✅ Success! Teacher ${name} registered successfully with ${groups.length} groups.`);
        ["newTeacherName", "newTeacherEmail", "newTeacherGroups"].forEach((id) => (document.getElementById(id).value = ""));
    } catch (error) {
        console.error("Database Error:", error);
        alert("❌ Failed to register teacher. Check console for details.");
    }
}
document.getElementById("registerTeacherBtn").addEventListener("click", registerNewTeacher);

// ---------------------------------------------------------------------
// CALIBRATION
// ---------------------------------------------------------------------
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);
const maxOf = (arr) => (arr.length ? Math.max(...arr) : NaN);
const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Pure analysis, exported for testing. */
export function analyzeGallery(people) {
    const genuine = [];
    people.forEach((p) => {
        for (let i = 0; i < p.samples.length; i++)
            for (let j = i + 1; j < p.samples.length; j++) genuine.push(euclidean(p.samples[i].v, p.samples[j].v));
    });

    // For every pair of DIFFERENT people: the closest pair of samples (what the matcher would see)
    const impostorPairs = [];
    for (let a = 0; a < people.length; a++) {
        for (let b = a + 1; b < people.length; b++) {
            let min = Infinity;
            for (const sa of people[a].samples) for (const sb of people[b].samples) min = Math.min(min, euclidean(sa.v, sb.v));
            if (Number.isFinite(min)) impostorPairs.push({ a: people[a], b: people[b], distance: min });
        }
    }
    impostorPairs.sort((x, y) => x.distance - y.distance);
    const impostor = impostorPairs.map((p) => p.distance);

    const genuineP95 = pct(genuine, 0.95);
    const impostorMin = impostor[0];
    // Recommended: as high as possible (fewer "not recognized") but with a 0.05 safety gap
    // below the closest pair of different people. Never below 0.40 or above 0.60.
    let suggested = Number.isFinite(impostorMin) ? impostorMin - 0.05 : CONFIG.RECOGNITION.ACCEPT_DISTANCE;
    if (Number.isFinite(genuineP95)) suggested = Math.min(suggested, Math.max(genuineP95, 0.45));
    suggested = Math.min(0.60, Math.max(0.40, suggested));

    return {
        genuine, impostor, impostorPairs, suggested: Math.round(suggested * 100) / 100,
        fewSamples: people.filter((p) => p.samples.length < CONFIG.ENROLLMENT.MIN_SAMPLES),
    };
}

document.getElementById("analyzeBtn").addEventListener("click", async () => {
    const out = document.getElementById("calibrationReport");
    out.innerHTML = "⏳ Downloading and analyzing...";
    try {
        const { people } = await data.loadUsers();
        const withFaces = people.filter((p) => p.samples.length > 0);
        const r = analyzeGallery(withFaces);
        const since = Date.now() - 30 * 24 * 3600 * 1000;
        const logged = (await data.getRecentEntries(since)).map((e) => e.distance).filter(Number.isFinite);
        const T = CONFIG.RECOGNITION.ACCEPT_DISTANCE;

        out.innerHTML = `
          <p><strong>${withFaces.length}</strong> people with face data ·
             <strong>${withFaces.reduce((s, p) => s + p.samples.length, 0)}</strong> samples</p>
          <table>
            <tr><th></th><th>median</th><th>p95 / p5</th><th>worst</th></tr>
            <tr><td>Same person</td><td>${f(pct(r.genuine, 0.5))}</td><td>${f(pct(r.genuine, 0.95))}</td><td>${f(maxOf(r.genuine))}</td></tr>
            <tr><td>Different people</td><td>${f(pct(r.impostor, 0.5))}</td><td>${f(pct(r.impostor, 0.05))}</td><td>${f(r.impostor[0])}</td></tr>
            <tr><td>Scanner (30 days)</td><td>${f(pct(logged, 0.5))}</td><td>${f(pct(logged, 0.95))}</td><td>${f(maxOf(logged))}</td></tr>
          </table>
          <p class="suggestion">Suggested accept distance: <strong>${r.suggested.toFixed(2)}</strong> (current ${T.toFixed(2)})</p>
          ${r.genuine.length === 0 ? `<p class="warn">⚠️ Nobody has 2+ samples yet, so "same person" can't be measured. Re-register students with the camera capture.</p>` : ""}
          ${r.fewSamples.length ? `<p class="warn">⚠️ ${r.fewSamples.length} people have fewer than ${CONFIG.ENROLLMENT.MIN_SAMPLES} samples (re-register them):<br>${r.fewSamples.slice(0, 15).map((p) => esc(p.name)).join(", ")}${r.fewSamples.length > 15 ? "…" : ""}</p>` : ""}
          <p><strong>Most similar different people</strong> (risk of confusion):</p>
          <ul>${r.impostorPairs.slice(0, 5).map((p) => `<li>${esc(p.a.name)} ↔ ${esc(p.b.name)}: <strong>${f(p.distance)}</strong>${p.distance <= T ? " ⚠️ below threshold" : ""}</li>`).join("") || "<li>Need at least 2 people.</li>"}</ul>`;
        document.getElementById("thresholdInput").value = r.suggested.toFixed(2);
    } catch (e) {
        console.error(e);
        out.innerHTML = `❌ ${esc(e.message || e)}`;
    }
});

// ---------------------------------------------------------------------
// PER-DEVICE OVERRIDES
// ---------------------------------------------------------------------
const OVERRIDES_KEY = "adsum.overrides";
const readOverrides = () => { try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}"); } catch { return {}; } };
const writeOverrides = (o) => localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o));

function renderOverrides() {
    document.getElementById("currentThreshold").textContent = CONFIG.RECOGNITION.ACCEPT_DISTANCE.toFixed(2);
    document.getElementById("livenessCheck").checked = CONFIG.LIVENESS.ENABLED;
}

document.getElementById("applyThresholdBtn").addEventListener("click", () => {
    const value = parseFloat(document.getElementById("thresholdInput").value.replace(",", "."));
    if (!(value >= 0.3 && value <= 0.7)) { alert("⚠️ Use a value between 0.30 and 0.70."); return; }
    writeOverrides({ ...readOverrides(), ACCEPT_DISTANCE: value });
    CONFIG.RECOGNITION.ACCEPT_DISTANCE = value;
    renderOverrides();
    alert(`✅ Threshold ${value.toFixed(2)} saved on this device. Reload the scanner to apply.`);
});

document.getElementById("livenessCheck").addEventListener("change", (e) => {
    writeOverrides({ ...readOverrides(), LIVENESS_ENABLED: e.target.checked });
    CONFIG.LIVENESS.ENABLED = e.target.checked;
});

document.getElementById("resetOverridesBtn").addEventListener("click", () => {
    localStorage.removeItem(OVERRIDES_KEY);
    alert("Defaults restored. Reloading...");
    location.reload();
});

renderOverrides();
