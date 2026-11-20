// =====================================================================
// ⚙️ ADSUM — GLOBAL CONFIGURATION
// Every tunable parameter lives here so nothing is "hard-coded" inside
// the logic files. Loaded as a classic <script> BEFORE the modules, so
// `CONFIG` is available everywhere (shared.js, index.js, registration.js...).
// =====================================================================
const CONFIG = {
    MODEL_PATH: './models',
    ADMIN_PASSWORD: "adsum",

    // -----------------------------------------------------------------
    // 🎯 RECOGNITION (threshold tuning)
    // Distances are Euclidean distances between 128-D face descriptors.
    // Lower distance = more similar.
    //
    // Calibrated with real measurements (see docs/THRESHOLD.md):
    //   • same person, different photo:  mean ≈ 0.44, p95 ≈ 0.56
    //   • different people:              min  ≈ 0.60, mean ≈ 0.82
    // With ONE photo per person + 0.45, ~50% of genuine comparisons failed.
    // With ≥3 samples per person + 0.50, ~97.5% pass per single frame and
    // the temporal vote below pushes it to ~100% in 1–2 seconds.
    // -----------------------------------------------------------------
    RECOGNITION: {
        ACCEPT_DISTANCE: 0.50,   // best match must be at or below this
        MIN_MARGIN: 0.06,        // 2nd-best (another person) must be at least this much farther
        VOTE_WINDOW: 5,          // look at the last N recognitions of a tracked face...
        VOTES_REQUIRED: 3,       // ...and require this many to agree on the same person
        RECOGNIZE_EVERY_MS: 250, // how often a face still being identified gets a new descriptor (expensive step)
        VERIFY_EVERY_MS: 2000,   // once the identity is confirmed, re-check this rarely (keeps the video smooth for blinking)
    },

    // -----------------------------------------------------------------
    // 📷 REAL-TIME DETECTION LOOP
    // TinyFaceDetector is ~5x faster than SSD on tablets and our tests
    // showed descriptors of the same quality (avg diff 0.087).
    // -----------------------------------------------------------------
    DETECTION: {
        INPUT_SIZE: 320,          // 160 / 224 / 320 / 416 / 512 / 608 (multiple of 32). Higher = sees smaller/farther faces, slower
        SCORE_THRESHOLD: 0.5,
        TARGET_FRAME_MS: 80,      // ~12 fps target; on slow devices it just runs as fast as it can
        MIN_FACE_WIDTH_RATIO: 0.10, // ignore faces narrower than 10% of the frame (people far away in the background)
        TRACK_IOU: 0.3,           // overlap needed to consider two boxes the same person between frames
        TRACK_TTL_MS: 1500,       // forget a face after it disappears this long
    },

    // -----------------------------------------------------------------
    // 👁️ LIVENESS (anti-photo / anti-spoofing)
    // A printed photo or an ID card cannot blink. We require a natural
    // blink while the face is being tracked before attendance is recorded.
    // Two independent signals (see face-engine.js → BlinkLiveness):
    //   A) eye landmarks flatten (EAR) while the face shape stays stable
    //   B) eye pixels change while the nose-bridge pixels stay identical
    // Tilting / moving / bending a photo changes the whole face → rejected.
    // -----------------------------------------------------------------
    LIVENESS: {
        ENABLED: true,
        CLOSED_RATIO: 0.72,       // eye counts as "closed" when EAR < baseline * this
        REOPEN_RATIO: 0.88,       // and "open again" when EAR > baseline * this
        MAX_BLINK_MS: 900,        // a real blink lasts 100–400 ms; longer closures are ignored (margin for slow tablets)
        MIN_BASELINE_SAMPLES: 4,  // frames of open eyes needed before we trust the baseline
        MAX_FACE_SHAPE_CHANGE: 0.10, // if the face proportions change >10% during the "blink", it's a tilted photo
        // Appearance signal (eye pixels vs. learned "open eyes" template, 1 = identical)
        EYE_CLOSED_CORR: 0.60,    // eyes count as "closed" when correlation drops below this...
        EYE_OPEN_CORR: 0.80,      // ...and "open again" above this
        REF_MIN_CORR: 0.80,       // the nose-bridge patch must stay this similar (otherwise it's motion, not a blink)
        RELEARN_AFTER_MS: 2000,   // if the 'open eyes' reference stops matching for this long (head moved, light changed), learn it again
        RESET_AFTER_MS: 6000,     // safety net: a face that hasn't blinked in this long gets a fresh blink detector
        DEBUG: false,             // true → shows live EAR / correlation numbers on the scanner (for tuning on the tablet)
    },

    // -----------------------------------------------------------------
    // 🧠 ADAPTIVE GALLERY (glasses / haircut / beard changes, automatically)
    // When someone is recognized with high confidence AND passed liveness,
    // the system stores that live descriptor as an extra sample. This way the
    // database learns "with glasses" / "without glasses" by itself over time.
    // -----------------------------------------------------------------
    ADAPTIVE: {
        ENABLED: true,
        MAX_DISTANCE: 0.45,       // only learn from very confident matches...
        MIN_MARGIN: 0.12,         // ...that are clearly not anyone else
        MIN_NOVELTY: 0.20,        // and only if the sample is different from what we already have
        MAX_AUTO_SAMPLES: 6,      // keep at most N automatic samples per person (oldest replaced)
        MIN_HOURS_BETWEEN: 12,    // at most one new automatic sample per person every N hours
    },

    // -----------------------------------------------------------------
    // 📝 REGISTRATION QUALITY GATE
    // -----------------------------------------------------------------
    ENROLLMENT: {
        MIN_SAMPLES: 3,           // a registration needs at least this many good samples
        MAX_SAMPLES: 10,
        CAMERA_SAMPLES: 5,        // automatic captures per "Capture from camera" press
        CAMERA_SAMPLE_GAP_MS: 400,
        MIN_FACE_PX: 100,         // face box must be at least this wide (in pixels of the source image)
        MIN_DETECTION_SCORE: 0.80,
        MAX_YAW: 0.30,            // 0 = perfectly frontal. Higher = more turned
        MIN_BRIGHTNESS: 60,       // 0–255 mean luminance inside the face
        MAX_BRIGHTNESS: 210,
        MIN_SHARPNESS: 25,        // variance of Laplacian; lower = blurry
        DUPLICATE_DISTANCE: 0.42, // warn if the face is this close to ANOTHER registered person
    },

    // -----------------------------------------------------------------
    // 🕒 ATTENDANCE
    // -----------------------------------------------------------------
    ATTENDANCE: {
        COOLDOWN_MS: 60000,       // don't log the same person twice within this time
        BANNER_HOLD_MS: 3500,     // how long the big "✅ NAME" banner stays on screen
    },

    // -----------------------------------------------------------------
    // 📊 EXCEL / MICROSOFT 365
    // Fill GRAPH_CLIENT_ID after registering the app in Azure (docs/EXCEL.md).
    // If it's empty, the "Sync to SharePoint" button is hidden and only the
    // local .xlsx export is available.
    // -----------------------------------------------------------------
    EXCEL: {
        GRAPH_CLIENT_ID: "",
        GRAPH_AUTHORITY: "https://login.microsoftonline.com/organizations",
        GRAPH_SCOPES: ["Files.ReadWrite.All", "offline_access", "User.Read"],
        // Sharing link of the target workbook (GanttDates.xlsx). The person signing in must have EDIT rights.
        SHARE_URL: "https://tecmx-my.sharepoint.com/:x:/r/personal/david_sotelo_tec_mx/_layouts/15/Doc.aspx?sourcedoc=%7B24D97235-775A-4680-88A0-D0B8D6EA1BE0%7D&file=GanttDates.xlsx&action=default&mobileredirect=true&share=cQo1ctkkWneARoig0LjW6hvgEgUDoTtorksOg2KT8JWdnns5ww",
        // Adsum writes into its OWN sheets ("Adsum - <group>") so it never touches the teacher's existing sheets.
        SHEET_PREFIX: "Adsum - ",
        PRESENT_MARK: "P",
        ABSENT_MARK: "A",
    },
};

// Per-device overrides set from the Admin Console (Recognition Calibration).
// They let you tune one tablet without rebuilding the app.
try {
    const o = JSON.parse(localStorage.getItem("adsum.overrides") || "{}");
    if (typeof o.ACCEPT_DISTANCE === "number") CONFIG.RECOGNITION.ACCEPT_DISTANCE = o.ACCEPT_DISTANCE;
    if (typeof o.LIVENESS_ENABLED === "boolean") CONFIG.LIVENESS.ENABLED = o.LIVENESS_ENABLED;
} catch (e) { /* storage not available: use defaults */ }
