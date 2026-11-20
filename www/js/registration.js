// =====================================================================
// 📝 ADSUM REGISTRATION (registration.html)
//
// A student is stored with SEVERAL face samples (3–10) instead of one photo.
// Why: one photo per person made ~50% of genuine comparisons fail at 0.45;
// with ≥3 samples it's ~97% per frame (see docs/THRESHOLD.md).
//
// Samples can come from:
//   📷 the tablet camera (recommended: same camera/lighting as the scanner)
//   📁 uploaded photos (JPG/PNG/HEIC), e.g. an ID photo
// Every sample passes a quality gate (one face, size, frontal, light, sharpness).
// =====================================================================
import { arrayUnion } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { loadModels, computeDescriptor, assessQuality, serializeSample, euclidean, FaceGallery } from "./face-engine.js";
import * as data from "./data.js";

// UI
const statusMessage = document.getElementById("statusMessage");
const registerBtn = document.getElementById("registerBtn");
const photoInput = document.getElementById("photoInput");
const userNameInput = document.getElementById("userName");
const userEmailInput = document.getElementById("userEmail");
const groupSearch = document.getElementById("groupSearch");
const searchResults = document.getElementById("searchResults");
const groupsContainer = document.getElementById("groupsContainer");
const regVideo = document.getElementById("regVideo");
const regCameraBox = document.getElementById("regCameraBox");
const regCameraSelect = document.getElementById("regCameraSelect");
const captureBtn = document.getElementById("captureBtn");
const captureGuide = document.getElementById("captureGuide");
const samplesGrid = document.getElementById("samplesGrid");
const sampleCounter = document.getElementById("sampleCounter");

const E = CONFIG.ENROLLMENT;
let allGroupsMemory = [];
let samples = [];          // [{ descriptor: Float32Array, src: "camera"|"upload", thumb: HTMLCanvasElement }]
let cameraStream = null;
let modelsReady = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(text, color = "#ddd") {
    statusMessage.innerText = text;
    statusMessage.style.color = color;
}

// ---------------------------------------------------------------------
// STARTUP
// ---------------------------------------------------------------------
async function initialize() {
    try {
        setStatus("1/3 Loading AI engine...");
        await loadModels({ ssd: true, tiny: false }); // SSD: slower but more accurate for still photos
        modelsReady = true;

        setStatus("2/3 Synchronizing existing groups...");
        await loadGroupsFromFirebase();

        setStatus("3/3 Turning on camera...");
        await populateCameras();
        await startCamera(regCameraSelect.value);

        setStatus("Ready. Fill in the details and capture the face.", "#7fd3ff");
    } catch (error) {
        console.error(error);
        setStatus("Error initializing registration: " + (error.message || error), "#ff6b6b");
    }
    renderSamples();
}

async function loadGroupsFromFirebase() {
    const { groups } = await data.loadUsers();
    allGroupsMemory = Object.keys(groups).filter((g) => g !== "No Group");
}

async function populateCameras() {
    try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        regCameraSelect.innerHTML = "";
        cams.forEach((c, i) => regCameraSelect.add(new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
        const saved = localStorage.getItem("adsum.camera");
        if (saved && cams.some((c) => c.deviceId === saved)) regCameraSelect.value = saved;
    } catch (e) {
        console.warn("No camera available, only photo upload will work.", e);
        captureGuide.textContent = "No camera available — use 📁 Photos";
        captureBtn.disabled = true;
    }
}

async function startCamera(deviceId) {
    if (!deviceId && regCameraSelect.options.length === 0) return;
    if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }), width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    regVideo.srcObject = cameraStream;
    await regVideo.play();
}

regCameraSelect.addEventListener("change", () => startCamera(regCameraSelect.value).catch(console.error));

// ---------------------------------------------------------------------
// SAMPLES
// ---------------------------------------------------------------------
function makeThumb(source, box) {
    const c = document.createElement("canvas");
    c.width = 96; c.height = 96;
    const m = box.width * 0.25;
    c.getContext("2d").drawImage(source, box.x - m, box.y - m, box.width + 2 * m, box.height + 2 * m, 0, 0, 96, 96);
    return c;
}

/**
 * Detects + validates + describes the face in a source (image or canvas).
 * @returns {{ok:true, descriptor, thumb} | {ok:false, reason, thumb?}}
 */
async function analyze(source) {
    const detections = await faceapi.detectAllFaces(source).withFaceLandmarks();
    if (detections.length === 0) return { ok: false, reason: "no face detected" };
    if (detections.length > 1) return { ok: false, reason: "more than one face" };
    const det = detections[0];
    const thumb = makeThumb(source, det.detection.box);
    const quality = assessQuality(det, source);
    if (!quality.ok) return { ok: false, reason: quality.issues[0], thumb, quality };
    const descriptor = await computeDescriptor(source, det);
    return { ok: true, descriptor, thumb, quality };
}

function addSample(result, src) {
    if (samples.length >= E.MAX_SAMPLES) return false;
    // Skip near-identical frames: they add nothing
    if (samples.some((s) => euclidean(s.descriptor, result.descriptor) < 0.06)) return false;
    samples.push({ descriptor: result.descriptor, src, thumb: result.thumb });
    renderSamples();
    return true;
}

function showRejected(result, label) {
    const el = document.createElement("div");
    el.className = "sample rejected";
    if (result.thumb) el.appendChild(result.thumb);
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = `✕ ${label}: ${result.reason}`;
    el.appendChild(tag);
    samplesGrid.appendChild(el);
    setTimeout(() => el.remove(), 5000);
}

function renderSamples() {
    samplesGrid.querySelectorAll(".sample:not(.rejected)").forEach((n) => n.remove());
    samples.forEach((s, i) => {
        const el = document.createElement("div");
        el.className = "sample";
        el.appendChild(s.thumb);
        const tag = document.createElement("div");
        tag.className = "tag";
        tag.textContent = s.src === "camera" ? "📷 camera" : "📁 photo";
        const remove = document.createElement("button");
        remove.className = "remove";
        remove.textContent = "✕";
        remove.title = "Remove sample";
        remove.addEventListener("click", () => { samples.splice(i, 1); renderSamples(); });
        el.append(tag, remove);
        samplesGrid.prepend(el);
    });
    sampleCounter.textContent = `${samples.length} / ${E.MIN_SAMPLES}`;
    sampleCounter.classList.toggle("ok", samples.length >= E.MIN_SAMPLES);
    registerBtn.disabled = samples.length === 0;
}

// 📷 Automatic multi-capture from the camera
captureBtn.addEventListener("click", async () => {
    if (!modelsReady || !cameraStream) return;
    captureBtn.disabled = true;
    regCameraBox.classList.add("capturing");
    const guides = ["Look straight at the camera", "Turn your head slightly LEFT", "Turn your head slightly RIGHT", "Look straight again", "Tilt your chin slightly up"];
    const frame = document.createElement("canvas");
    let captured = 0;
    const deadline = Date.now() + 12000;

    while (captured < E.CAMERA_SAMPLES && Date.now() < deadline && samples.length < E.MAX_SAMPLES) {
        captureGuide.textContent = `${guides[captured % guides.length]} (${captured}/${E.CAMERA_SAMPLES})`;
        await sleep(E.CAMERA_SAMPLE_GAP_MS);
        frame.width = regVideo.videoWidth; frame.height = regVideo.videoHeight;
        frame.getContext("2d").drawImage(regVideo, 0, 0);
        const result = await analyze(frame);
        if (!result.ok) { captureGuide.textContent = `⚠️ ${result.reason}`; continue; }
        if (addSample(result, "camera")) captured++;
    }

    captureGuide.textContent = captured >= E.CAMERA_SAMPLES
        ? `✅ ${captured} samples captured`
        : `Captured ${captured}. Improve light / move closer and try again.`;
    regCameraBox.classList.remove("capturing");
    captureBtn.disabled = false;
});

// 📁 Upload one or more photos (with iPhone HEIC support)
photoInput.addEventListener("change", async () => {
    const files = Array.from(photoInput.files || []);
    photoInput.value = "";
    if (!modelsReady || files.length === 0) return;

    for (const original of files) {
        let file = original;
        const name = original.name.toLowerCase();
        setStatus(`Analyzing ${original.name}...`, "#7fd3ff");
        try {
            if (name.endsWith(".heic") || original.type === "image/heic") {
                setStatus("Converting iPhone image (this might take a few seconds)...", "orange");
                const converted = await heic2any({ blob: original, toType: "image/jpeg", quality: 0.9 });
                file = Array.isArray(converted) ? converted[0] : converted;
            }
            const img = await loadImage(URL.createObjectURL(file));
            const result = await analyze(img);
            if (result.ok) {
                if (!addSample(result, "upload")) showRejected({ ...result, reason: "duplicate / max reached" }, original.name);
            } else {
                showRejected(result, original.name);
            }
        } catch (e) {
            console.error(e);
            showRejected({ reason: "could not read image" }, original.name);
        }
    }
    setStatus(samples.length >= E.MIN_SAMPLES ? "Samples ready ✅" : `Add at least ${E.MIN_SAMPLES - samples.length} more sample(s).`,
              samples.length >= E.MIN_SAMPLES ? "#2ecc71" : "orange");
});

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

// ---------------------------------------------------------------------
// GROUPS (smart search / create)
// ---------------------------------------------------------------------
function addCheckboxGroup(groupName) {
    const cleanName = groupName.trim();
    if (cleanName === "") return;
    const alreadyExists = Array.from(groupsContainer.querySelectorAll("input")).some((i) => i.value.toLowerCase() === cleanName.toLowerCase());
    if (!alreadyExists) {
        const label = document.createElement("label");
        label.className = "group-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = cleanName;
        checkbox.checked = true;
        label.append(checkbox, document.createTextNode(" " + cleanName));
        groupsContainer.appendChild(label);
    }
    if (!allGroupsMemory.includes(cleanName)) allGroupsMemory.push(cleanName);
    groupSearch.value = "";
    searchResults.style.display = "none";
}

groupSearch.addEventListener("input", () => {
    const text = groupSearch.value.toLowerCase().trim();
    searchResults.innerHTML = "";
    if (text === "") { searchResults.style.display = "none"; return; }

    allGroupsMemory.filter((g) => g.toLowerCase().includes(text)).forEach((match) => {
        const div = document.createElement("div");
        div.className = "dropdown-item";
        div.innerText = match;
        div.addEventListener("click", () => addCheckboxGroup(match));
        searchResults.appendChild(div);
    });

    const createDiv = document.createElement("div");
    createDiv.className = "dropdown-item";
    createDiv.style.fontWeight = "bold";
    createDiv.style.color = "#007bff";
    createDiv.innerText = `+ Create and select "${groupSearch.value}"`;
    createDiv.addEventListener("click", () => addCheckboxGroup(groupSearch.value));
    searchResults.appendChild(createDiv);
    searchResults.style.display = "block";
});

groupSearch.addEventListener("keypress", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCheckboxGroup(groupSearch.value); }
});

document.addEventListener("click", (e) => {
    if (e.target !== groupSearch && e.target !== searchResults) searchResults.style.display = "none";
});

// ---------------------------------------------------------------------
// SAVE
// ---------------------------------------------------------------------
registerBtn.addEventListener("click", async () => {
    const name = userNameInput.value.trim();
    let email = userEmailInput.value.trim().toLowerCase();
    const chosenGroups = Array.from(groupsContainer.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);

    if (!name || !email) { alert("Please fill in both name and email."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert("⚠️ That email doesn't look valid."); return; }
    if (chosenGroups.length === 0) { alert("⚠️ Hold on! Please select at least one group or create a new one before saving."); return; }
    if (samples.length === 0) { alert("⚠️ Capture or upload at least one face sample."); return; }
    if (samples.length < E.MIN_SAMPLES &&
        !confirm(`Only ${samples.length} sample(s). With fewer than ${E.MIN_SAMPLES} recognition is less reliable.\n\nSave anyway?`)) return;

    registerBtn.innerText = "Checking...";
    registerBtn.disabled = true;

    try {
        // 1) Is this face already registered under ANOTHER email?
        const { people } = await data.loadUsers();
        const existing = people.find((p) => p.id.toLowerCase() === email);
        if (existing) email = existing.id; // keep the original document id
        const others = new FaceGallery(people.filter((p) => p.id !== email));
        const closest = samples
            .map((s) => others.rank(s.descriptor)[0])
            .filter(Boolean)
            .sort((a, b) => a.distance - b.distance)[0];
        if (closest && closest.distance < E.DUPLICATE_DISTANCE &&
            !confirm(`⚠️ This face is very similar to "${closest.name}" (${closest.id}), distance ${closest.distance.toFixed(2)}.\n\nIs it the same person registered twice? Press OK only if they are different people.`)) {
            throw new Error("cancelled");
        }

        // 2) New samples or merge with the existing ones
        let finalSamples = samples.map((s) => serializeSample(s.descriptor, s.src));
        if (existing && existing.samples.length > 0) {
            if (confirm(`${email} is already registered with ${existing.samples.length} sample(s).\n\nOK = ADD these new samples\nCancel = choose replace or abort`)) {
                const kept = existing.samples.map((s) => ({ ...serializeSample(s.v, s.src), at: s.at || new Date().toISOString() }));
                finalSamples = [...kept, ...finalSamples].slice(-E.MAX_SAMPLES);
            } else if (!confirm("REPLACE all existing samples with the new ones?")) {
                throw new Error("cancelled");
            }
        }

        registerBtn.innerText = "Saving...";
        await data.saveUser(email, {
            fullName: name,
            email,
            descriptor: finalSamples[0].v,     // legacy field (older app versions read this)
            descriptors: finalSamples,
            ...(existing ? { updatedAt: new Date().toISOString() } : { registrationDate: new Date().toISOString() }),
            groups: arrayUnion(...chosenGroups),
        });

        alert(`✅ Registration successful! ${name} saved with ${finalSamples.length} face samples.`);
        resetForm();
    } catch (error) {
        if (error.message !== "cancelled") {
            console.error(error);
            alert("Error saving user: " + (error.message || error));
        }
    } finally {
        registerBtn.innerText = "Save Registration";
        registerBtn.disabled = samples.length === 0;
    }
});

function resetForm() {
    userNameInput.value = "";
    userEmailInput.value = "";
    groupsContainer.innerHTML = "";
    samples = [];
    renderSamples();
    captureGuide.textContent = 'Press "Capture" and look at the camera';
    setStatus("Ready for the next student.", "#7fd3ff");
}

initialize();
