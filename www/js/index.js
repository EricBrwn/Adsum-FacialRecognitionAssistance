// =====================================================================
// 📷 ADSUM SCANNER (index.html)
//
// Pipeline per frame (~12 fps):
//   1. Grab the current video frame into an offscreen canvas
//   2. TinyFaceDetector + 68 landmarks           (fast, every frame)
//   3. FaceTracker: same face between frames → blink liveness per face
//   4. Every RECOGNIZE_EVERY_MS: 128-D descriptor + gallery match + vote
//   5. Identity stable (3/5 votes) AND blinked → attendance is recorded
//   6. Draw big labels on the overlay + big banner under the video
// =====================================================================
import {
    loadModels, tinyDetectorOptions, computeDescriptor,
    FaceGallery, FaceTracker, addVote, serializeSample,
} from "./face-engine.js";
import * as data from "./data.js";
import {
    buildAttendanceMatrix, exportGroupXlsx, syncGroupToSharePoint, graphEnabled, handleGraphRedirect,
} from "./excel.js";

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------
const video = document.getElementById("camera");
const overlay = document.getElementById("overlay");
const cameraContainer = document.getElementById("cameraContainer");
const scannerMessage = document.getElementById("scannerMessage");
const banner = document.getElementById("banner");
const bannerTitle = document.getElementById("bannerTitle");
const bannerSubtitle = document.getElementById("bannerSubtitle");
const recentStrip = document.getElementById("recentStrip");
const cameraSelect = document.getElementById("cameraSelect");

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
let gallery = new FaceGallery([]);
let groupDatabases = {};   // { group: [emails] }
let userDictionary = {};   // { email: { name, groups } }
let groupOptions = [];
let currentTeacherName = "Teacher";
let currentStream = null;

const tracker = new FaceTracker();
const lastLogged = {};     // { email: timestamp }
const recentCheckins = []; // [{ name, time }]
let bannerHoldUntil = 0;
let lastReport = null;     // { group, session }

const frameCanvas = document.createElement("canvas");
const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

emailjs.init("PVySdKrUGNpDOYaCs");

// ---------------------------------------------------------------------
// STARTUP
// ---------------------------------------------------------------------
async function initializeScanner() {
    try {
        setStatus("1/3 Loading AI...");
        await loadModels({ tiny: true });

        setStatus("2/3 Turning on camera...");
        await populateCameraList();
        await turnOnCamera(cameraSelect.value);

        setStatus("3/3 Synchronizing database...");
        await refreshDatabase();
        await loadSessionAutocomplete();

        startLoop();
        await resumePendingExcelSync();
    } catch (error) {
        console.error("Error starting the scanner:", error);
        setStatus("Error: " + (error.message || error), "red");
    }
}

function setStatus(text, color = "") {
    scannerMessage.innerText = text;
    scannerMessage.style.color = color;
}

async function populateCameraList() {
    try {
        // Ask permission once so the browser reveals real camera names, then RELEASE it.
        // (Keeping this stream open locks the camera on many Android tablets.)
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter((d) => d.kind === "videoinput");
        cameraSelect.innerHTML = "";
        videoDevices.forEach((device, i) => {
            const option = document.createElement("option");
            option.value = device.deviceId;
            option.text = device.label || `Camera ${i + 1}`;
            cameraSelect.appendChild(option);
        });

        const saved = localStorage.getItem("adsum.camera");
        if (saved && videoDevices.some((d) => d.deviceId === saved)) cameraSelect.value = saved;
    } catch (error) {
        console.error("Error enumerating devices:", error);
    }
}

cameraSelect.addEventListener("change", () => {
    localStorage.setItem("adsum.camera", cameraSelect.value);
    turnOnCamera(cameraSelect.value);
});

async function turnOnCamera(deviceId = null) {
    try {
        if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
        const isValidId = deviceId && deviceId !== "undefined";
        const constraints = {
            audio: false,
            video: {
                ...(isValidId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
                width: { ideal: 1280 }, height: { ideal: 720 },
            },
        };
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = currentStream;
        await video.play();
        tracker.clear();
    } catch (error) {
        alert("⛔ Could not access the selected camera.");
        console.error(error);
    }
}

// Keep the overlay exactly the same size/aspect as the real video stream
function syncOverlaySize() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return false;
    if (overlay.width !== w || overlay.height !== h) {
        overlay.width = w; overlay.height = h;
        frameCanvas.width = w; frameCanvas.height = h;
        cameraContainer.style.setProperty("--ar", `${w / h}`);
    }
    return true;
}

async function refreshDatabase() {
    const { people, groups } = await data.loadUsers();
    gallery = new FaceGallery(people);
    groupDatabases = groups;
    userDictionary = {};
    people.forEach((p) => (userDictionary[p.id] = { name: p.name, groups: p.groups }));

    groupOptions = [{ value: "all", text: "All registered users" }];
    Object.keys(groupDatabases).sort().forEach((g) => groupOptions.push({ value: g, text: `${g} (${groupDatabases[g].length} people)` }));
    document.getElementById("modalGroupSearch").value = "";
    document.getElementById("hiddenGroupSelect").value = "";

    const withoutSamples = people.filter((p) => p.samples.length === 0).length;
    const fewSamples = people.filter((p) => p.samples.length > 0 && p.samples.length < CONFIG.ENROLLMENT.MIN_SAMPLES).length;
    if (gallery.size === 0) {
        setStatus("No users with faces found in database.", "orange");
    } else {
        setStatus("System ready", "lightgreen");
        // Details go to the console (and to Admin → Calibration), not to the students' screen.
        console.info(`[Adsum] ${gallery.size} people loaded · ${fewSamples} with < ${CONFIG.ENROLLMENT.MIN_SAMPLES} samples · ${withoutSamples} without face`);
    }
}

async function loadSessionAutocomplete() {
    const sessions = await data.getSessions();
    const list = document.getElementById("sessionList");
    list.innerHTML = "";
    sessions.forEach((s) => { const o = document.createElement("option"); o.value = s; list.appendChild(o); });
}

// ---------------------------------------------------------------------
// REAL-TIME LOOP (self-scheduling → frames never overlap)
// ---------------------------------------------------------------------
function startLoop() {
    const tick = async () => {
        const t0 = performance.now();
        try { await processFrame(); } catch (e) { console.error("Frame error:", e); }
        setTimeout(tick, Math.max(0, CONFIG.DETECTION.TARGET_FRAME_MS - (performance.now() - t0)));
    };
    tick();
}

async function processFrame() {
    if (video.readyState < 2 || !syncOverlaySize()) return;
    frameCtx.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);

    const minWidth = frameCanvas.width * CONFIG.DETECTION.MIN_FACE_WIDTH_RATIO;
    const detections = (await faceapi.detectAllFaces(frameCanvas, tinyDetectorOptions()).withFaceLandmarks())
        .filter((d) => d.detection.box.width >= minWidth);

    const now = Date.now();
    const tracks = tracker.update(detections, now, frameCanvas);

    // The descriptor is the expensive step (~100-300 ms on a tablet). Doing it for every face on
    // every frame made the video freeze and blinks (100-400 ms) fall between two frames.
    // So: at most ONE descriptor per frame, never for a face that is blinking right now, and
    // rarely once the identity is already confirmed.
    if (gallery.size > 0) {
        const R = CONFIG.RECOGNITION;
        const due = tracks
            .filter((t) => !t.markedAt && !t.liveness.isClosing &&
                now - t.lastRecognizedAt >= (t.identity ? R.VERIFY_EVERY_MS : R.RECOGNIZE_EVERY_MS))
            .sort((a, b) => a.lastRecognizedAt - b.lastRecognizedAt)[0];
        if (due) {
            due.lastRecognizedAt = now;
            const descriptor = await computeDescriptor(frameCanvas, due.det);
            due.lastDescriptor = descriptor;
            addVote(due, gallery.match(descriptor));
        }
    }

    // Someone already recorded in the last minute doesn't need to blink again
    // (e.g. they stepped out of frame and came back).
    for (const track of tracks) {
        const recentlyLogged = track.identity && lastLogged[track.identity] && now - lastLogged[track.identity] < CONFIG.ATTENDANCE.COOLDOWN_MS;
        if (track.identity && !track.markedAt && (track.live || recentlyLogged)) markAttendance(track);
    }

    drawOverlay(tracks, now);
    updateBanner(tracks, now);
}

// ---------------------------------------------------------------------
// ATTENDANCE
// ---------------------------------------------------------------------
function markAttendance(track) {
    const email = track.identity;
    const person = gallery.get(email);
    const now = Date.now();
    track.markedAt = now;

    if (lastLogged[email] && now - lastLogged[email] < CONFIG.ATTENDANCE.COOLDOWN_MS) {
        track.alreadyLogged = true;
        return;
    }
    lastLogged[email] = now;
    const match = track.lastMatch || {};

    data.logEntry({ email, name: person.name, distance: match.distance, margin: match.margin, liveness: track.live })
        .then(() => console.log(`✅ Entry for ${person.name} registered.`))
        .catch((e) => console.error("Could not save entry:", e));

    recentCheckins.unshift({ name: person.name, time: new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
    recentCheckins.splice(6);
    renderRecent();
    bannerHoldUntil = now + CONFIG.ATTENDANCE.BANNER_HOLD_MS;
    showBanner("success", `✅ ${person.name}`, `Attendance recorded · ${recentCheckins[0].time}`);

    if (track.lastDescriptor) learnSample(email, track.lastDescriptor, match);
}

/**
 * 🧠 Adaptive gallery: stores a new live sample when the match is very confident.
 * This is what makes "with glasses / without glasses" work automatically over time.
 */
async function learnSample(email, descriptor, match) {
    const A = CONFIG.ADAPTIVE;
    if (!A.ENABLED) return;
    // match.distance is already the distance to the CLOSEST stored sample of this person,
    // so it also measures how "new" this look is (novelty).
    if (!(match.distance <= A.MAX_DISTANCE && match.distance >= A.MIN_NOVELTY && match.margin >= A.MIN_MARGIN)) return;

    const person = gallery.get(email);
    const autos = person.samples.filter((s) => s.src === "auto");
    const lastAuto = Math.max(0, ...autos.map((s) => Date.parse(s.at) || 0));
    if (Date.now() - lastAuto < A.MIN_HOURS_BETWEEN * 3600 * 1000) return;

    const newSample = { v: descriptor, src: "auto", at: new Date().toISOString() };
    let samples = [...person.samples, newSample];
    if (autos.length >= A.MAX_AUTO_SAMPLES) {
        const oldest = autos.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))[0];
        samples = samples.filter((s) => s !== oldest);
    }
    try {
        await data.replaceUserSamples(email, samples.map((s) => ({ ...serializeSample(s.v, s.src), at: s.at })));
        person.samples = samples;
        console.log(`🧠 Learned a new appearance for ${person.name} (distance ${match.distance.toFixed(3)}).`);
    } catch (e) {
        console.warn("Could not store adaptive sample:", e);
    }
}

// ---------------------------------------------------------------------
// DRAWING (big, readable labels)
// ---------------------------------------------------------------------
const COLORS = { success: "#2ecc71", pending: "#f5a623", unknown: "#e74c3c", analyzing: "#9aa5b1" };

function trackStatus(track, now) {
    if (track.identity && track.markedAt) return "success";
    if (track.identity) return "pending";
    if (track.votes.length >= CONFIG.RECOGNITION.VOTE_WINDOW && !track.identity) return "unknown";
    return "analyzing";
}

function trackLabel(track, status) {
    const person = track.identity ? gallery.get(track.identity) : null;
    switch (status) {
        case "success": return person.name;
        case "pending": return `${person.name} · Blink`;
        case "unknown": return "Not registered";
        default: return "…";
    }
}

function drawOverlay(tracks, now) {
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const displayScale = overlay.getBoundingClientRect().width / overlay.width || 1;

    for (const track of tracks) {
        const status = trackStatus(track, now);
        const color = COLORS[status];
        const b = track.box;
        // The <video> is mirrored with CSS, the canvas is not → mirror X here.
        const x = overlay.width - b.x - b.width;
        const y = b.y - b.height * 0.25;         // a bit of forehead/hair
        const h = b.height * 1.3;

        ctx.lineWidth = Math.max(4, b.width * 0.025);
        ctx.strokeStyle = color;
        roundRect(ctx, x, y, b.width, h, 16);
        ctx.stroke();

        // Font: at least 30 CSS px on screen, bigger for closer faces
        const fontPx = Math.max(30 / displayScale, b.width * 0.16);
        ctx.font = `bold ${fontPx}px Arial, sans-serif`;
        const text = trackLabel(track, status);
        const padding = fontPx * 0.35;
        const textW = ctx.measureText(text).width + padding * 2;
        const labelH = fontPx + padding * 1.4;
        let lx = Math.min(Math.max(0, x + b.width / 2 - textW / 2), overlay.width - textW);
        let ly = y - labelH - 6;
        if (ly < 0) ly = Math.min(overlay.height - labelH, y + h + 6);

        ctx.fillStyle = color;
        roundRect(ctx, lx, ly, textW, labelH, 12);
        ctx.fill();
        ctx.fillStyle = status === "pending" ? "#111" : "#fff";
        ctx.textBaseline = "middle";
        ctx.fillText(text, lx + padding, ly + labelH / 2);

        if (CONFIG.LIVENESS.DEBUG == true) drawDebug(ctx, track, x, y + h + 4, displayScale);
    }
}

/** Live numbers for tuning thresholds on the real tablet (CONFIG.LIVENESS.DEBUG = true). */
function drawDebug(ctx, track, x, y, displayScale) {
    const L = track.liveness, m = track.lastMatch;
    const lines = [
        `EAR ${L.lastEar.toFixed(3)} / base ${L.baseline.toFixed(3)}`,
        `eye ${L.lastEyeCorr.toFixed(2)}  ref ${L.lastRefCorr.toFixed(2)}`,
        `blinks ${L.blinks}${L.passedBy ? " (" + L.passedBy + ")" : ""}`,
        m ? `dist ${m.distance.toFixed(3)}  margin ${Number.isFinite(m.margin) ? m.margin.toFixed(3) : "∞"}` : "dist —",
    ];
    const fs = 16 / displayScale;
    ctx.font = `${fs}px monospace`;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x, y, fs * 17, fs * 1.25 * lines.length + 6);
    ctx.fillStyle = "#0f0";
    lines.forEach((l, i) => ctx.fillText(l, x + 4, y + 3 + i * fs * 1.25));
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// ---------------------------------------------------------------------
// BIG BANNER (what the student reads)
// ---------------------------------------------------------------------
function showBanner(kind, title, subtitle = "") {
    banner.className = `banner banner--${kind}`;
    if (bannerTitle.textContent !== title) bannerTitle.textContent = title;
    if (bannerSubtitle.textContent !== subtitle) bannerSubtitle.textContent = subtitle;
}

function updateBanner(tracks, now) {
    if (now < bannerHoldUntil) return; // keep the success message visible for a moment

    if (gallery.size === 0) return showBanner("idle", "No students registered yet", "Use the Registration page first");
    if (tracks.length === 0) return showBanner("idle", "Step in front of the camera", "Look at the screen and blink");

    const primary = tracks.reduce((a, b) => (b.box.width > a.box.width ? b : a));
    const status = trackStatus(primary, now);
    const person = primary.identity ? gallery.get(primary.identity) : null;

    if (status === "success") {
        const time = new Date(lastLogged[primary.identity] || now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return showBanner("success", `✅ ${person.name}`, primary.alreadyLogged ? `Already recorded at ${time}` : `Attendance recorded · ${time}`);
    }
    if (status === "pending") return showBanner("pending", person.name, "Blink");
    if (status === "unknown") return showBanner("unknown", "Face not recognized", "Ask your teacher to register you");
    return showBanner("analyzing", "Analyzing…", "Look at the screen");
}

function renderRecent() {
    recentStrip.innerHTML = recentCheckins
        .map((c) => `<span class="recent-chip">✅ ${escapeHtml(c.name)} <small>${c.time}</small></span>`)
        .join("");
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------
// ROLL CALL REPORT
// ---------------------------------------------------------------------
async function calculateAbsences() {
    try {
        const selectedGroup = document.getElementById("hiddenGroupSelect").value;
        const startTimeHTML = document.getElementById("startTime").value;
        const endTimeHTML = document.getElementById("endTime").value;
        const selectedSession = document.getElementById("sessionInput").value.trim();
        const sendEmails = document.getElementById("sendEmailsCheck").checked;

        if (selectedGroup === "") {
            alert("⚠️ Action Stopped: You must select a valid group from the dropdown list.");
            return;
        }
        if (!startTimeHTML || !endTimeHTML || !selectedSession) {
            alert("⚠️ Hold on! Please fill in the times (From / To) and the session name before generating the report.");
            return;
        }

        const today = new Date();
        const at = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m, 0).getTime(); };
        const startMs = at(startTimeHTML);
        const endMs = at(endTimeHTML) + 59999; // include the whole last minute
        if (endMs <= startMs) { alert("⚠️ 'To' must be later than 'From'."); return; }

        const guestList = selectedGroup === "all" ? Object.keys(userDictionary) : (groupDatabases[selectedGroup] || []);
        const entries = await data.getEntriesBetween(startMs, endMs);

        const firstEntry = {};
        entries.forEach((e) => { if (e.email && (!firstEntry[e.email] || e.timestamp < firstEntry[e.email])) firstEntry[e.email] = e.timestamp; });

        const attendees = [], absentees = [], records = {};
        guestList.forEach((email) => {
            const info = userDictionary[email] || { name: "Unknown", groups: ["No Group"] };
            const person = { name: info.name, email, groups: info.groups };
            if (firstEntry[email]) {
                attendees.push(person);
                records[email] = { name: info.name, status: "present", time: new Date(firstEntry[email]).toLocaleTimeString() };
            } else {
                absentees.push(person);
                records[email] = { name: info.name, status: "absent" };
            }
        });

        await data.saveSession(selectedSession);
        if (selectedGroup !== "all") {
            await data.saveAttendance({
                group: selectedGroup, session: selectedSession, startMs, endMs,
                teacherEmail: document.getElementById("teacherEmailInput").value.trim() || null, records,
            });
            lastReport = { group: selectedGroup, session: selectedSession };
            document.getElementById("excelActions").style.display = "flex";
            document.getElementById("syncExcelBtn").style.display = graphEnabled() ? "" : "none";
        }

        renderReport(selectedSession, selectedGroup, attendees, absentees);

        if (sendEmails && absentees.length > 0 &&
            confirm(`📧 Send absence emails to ${absentees.length} student(s)?`)) {
            absentees.forEach((p) => sendAbsenceEmail(p.name, p.email, selectedSession));
        }
        const teacherEmail = document.getElementById("teacherEmailInput").value.trim();
        if (sendEmails && teacherEmail && selectedGroup !== "all") {
            sendTeacherSummaryEmail(teacherEmail, currentTeacherName, selectedGroup, selectedSession, attendees, absentees);
        }
    } catch (error) {
        console.error("Report error:", error);
        alert("Error processing report: " + (error.message || error));
    }
}

function renderReport(session, group, attendees, absentees) {
    const reportArea = document.getElementById("reportArea");
    reportArea.style.display = "block";
    const item = (p) => `<li><strong>${escapeHtml(p.name)}</strong> <span style="color:#aaa; font-size:11px;">(${escapeHtml(p.groups.join(", "))})</span></li>`;
    reportArea.innerHTML = `
        <h3 style="color:#fbc531; margin-top:0; border-bottom:1px solid #444; padding-bottom:5px;">📊 ${escapeHtml(session.toUpperCase())}</h3>
        <p style="margin:5px 0;"><strong>Filter:</strong> Group ${escapeHtml(group.toUpperCase())}</p>
        <h4 style="color:#2ecc71; margin-bottom:5px;">✅ ATTENDED (${attendees.length}):</h4>
        <ul>${attendees.length ? attendees.map(item).join("") : "<li>Nobody attended during this timeframe.</li>"}</ul>
        <h4 style="color:#e74c3c; margin-bottom:5px;">❌ ABSENT (${absentees.length}):</h4>
        <ul>${absentees.length ? absentees.map(item).join("") : "<li>Perfect attendance! Nobody was absent.</li>"}</ul>`;
}

// ---------------------------------------------------------------------
// EXCEL
// ---------------------------------------------------------------------
async function groupMatrix(group) {
    const docs = await data.getGroupAttendance(group);
    const roster = (groupDatabases[group] || []).map((email) => ({ id: email, name: userDictionary[email]?.name || email }));
    return buildAttendanceMatrix(docs, roster);
}

document.getElementById("exportExcelBtn").addEventListener("click", async () => {
    if (!lastReport) return;
    try {
        const name = await exportGroupXlsx(lastReport.group, await groupMatrix(lastReport.group));
        console.log("Excel generated:", name);
    } catch (e) {
        console.error(e);
        alert("❌ Could not generate the Excel file: " + e.message);
    }
});

document.getElementById("syncExcelBtn").addEventListener("click", () => lastReport && runSharePointSync(lastReport.group));

async function runSharePointSync(group) {
    const btn = document.getElementById("syncExcelBtn");
    btn.disabled = true; btn.innerText = "Syncing…";
    try {
        const result = await syncGroupToSharePoint(group, await groupMatrix(group));
        alert(`✅ Excel updated: "${result.workbook}" → sheet "${result.sheet}"`);
    } catch (e) {
        console.error(e);
        alert("❌ SharePoint sync failed: " + e.message);
    } finally {
        btn.disabled = false; btn.innerText = "☁️ Sync to SharePoint Excel";
    }
}

/** After the Microsoft login redirect, finish the sync the teacher had asked for. */
async function resumePendingExcelSync() {
    try {
        const pending = await handleGraphRedirect();
        if (pending && pending.type === "sync" && pending.group) await runSharePointSync(pending.group);
    } catch (e) {
        console.error(e);
        alert("❌ Microsoft sign-in failed: " + e.message);
    }
}

// ---------------------------------------------------------------------
// EMAILS (EmailJS)
// ---------------------------------------------------------------------
async function sendAbsenceEmail(personName, personEmail, sessionName) {
    const parameters = { name: personName, target_email: personEmail, session_name: sessionName, drive_link: "Link pending addition..." };
    try {
        await emailjs.send("service_s9ugx0j", "template_ayapn8q", parameters);
        console.log("✅ Email successfully sent to: " + personEmail);
    } catch (error) {
        console.error("❌ Error sending email to: " + personEmail, error);
    }
}

async function sendTeacherSummaryEmail(teacherEmail, teacherName, group, session, attendees, absentees) {
    const parameters = {
        teacher_name: teacherName, teacher_email: teacherEmail, group_name: group, session_name: session,
        attendees_list: attendees.length ? attendees.map((a) => a.name).join(", ") : "Nadie asistió.",
        absentees_list: absentees.length ? absentees.map((a) => a.name).join(", ") : "Asistencia perfecta.",
    };
    try {
        await emailjs.send("service_s9ugx0j", "template_49u2dbi", parameters);
        console.log("✅ Summary sent to teacher: " + teacherEmail);
    } catch (error) {
        console.error("❌ Error sending the teacher summary.", error);
    }
}

// ---------------------------------------------------------------------
// MODAL + SMART GROUP SEARCHER
// ---------------------------------------------------------------------
const adminModal = document.getElementById("adminModal");
document.getElementById("openAdminBtn").addEventListener("click", () => { adminModal.style.display = "flex"; });
document.getElementById("closeModalBtn").addEventListener("click", () => {
    adminModal.style.display = "none";
    document.getElementById("reportArea").style.display = "none";
    document.getElementById("excelActions").style.display = "none";
});
document.getElementById("generateReportBtn").addEventListener("click", calculateAbsences);

const modalGroupSearch = document.getElementById("modalGroupSearch");
const modalGroupResults = document.getElementById("modalGroupResults");
const hiddenGroupSelect = document.getElementById("hiddenGroupSelect");

modalGroupSearch.addEventListener("input", () => {
    const text = modalGroupSearch.value.toLowerCase().trim();
    modalGroupResults.innerHTML = "";
    hiddenGroupSelect.value = ""; // prevents keeping a previous group by accident

    const matches = text === "" ? groupOptions : groupOptions.filter((g) => g.text.toLowerCase().includes(text));
    if (matches.length === 0) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "dropdown-item";
        errorDiv.style.color = "red";
        errorDiv.innerText = "❌ This group does not exist";
        modalGroupResults.appendChild(errorDiv);
    } else {
        matches.forEach((match) => {
            const div = document.createElement("div");
            div.className = "dropdown-item";
            div.innerText = match.text;
            div.addEventListener("click", () => {
                modalGroupSearch.value = match.text;
                hiddenGroupSelect.value = match.value;
                modalGroupResults.style.display = "none";
            });
            modalGroupResults.appendChild(div);
        });
    }
    modalGroupResults.style.display = "block";
});

modalGroupSearch.addEventListener("focus", () => {
    modalGroupSearch.select();
    modalGroupSearch.dispatchEvent(new Event("input"));
});

document.addEventListener("click", (e) => {
    if (e.target !== modalGroupSearch && e.target !== modalGroupResults) {
        modalGroupResults.style.display = "none";
        if (hiddenGroupSelect.value === "") modalGroupSearch.value = "";
    }
});

async function loadTeacherGroups() {
    const emailInput = document.getElementById("teacherEmailInput").value.trim().toLowerCase();
    if (!emailInput) { alert("⚠️ Please enter your teacher email first."); return; }
    try {
        const teacher = await data.getTeacher(emailInput);
        if (!teacher) { alert("❌ Teacher not found in the database. Please check the email."); return; }
        currentTeacherName = teacher.name;
        const teacherGroups = teacher.groups || [];
        if (teacherGroups.length === 0) { alert("⚠️ No groups assigned to this teacher yet."); return; }

        groupOptions = teacherGroups.map((g) => ({ value: g, text: `${g} (${(groupDatabases[g] || []).length} people)` }));
        modalGroupSearch.value = "";
        hiddenGroupSelect.value = "";
        alert(`✅ Welcome ${teacher.name}! Your groups have been loaded.`);
    } catch (error) {
        console.error("Error loading teacher groups:", error);
        alert("Error connecting to the database.");
    }
}
document.getElementById("loadGroupsBtn").addEventListener("click", loadTeacherGroups);

initializeScanner();
