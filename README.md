# Adsum — Facial Recognition Attendance

Automatic roll call for a classroom: an Android tablet at the door recognizes each student,
checks they are a **live person** (not a photo), records the entry, and at the end of class
generates the attendance report, emails absentees and exports it to **Excel**.

Web app (HTML/JS + [face-api.js](https://github.com/justadudewhohacks/face-api.js)) packaged
for Android with **Capacitor**. Data in **Firebase Firestore**, emails via **EmailJS**.

## Pages
| Page | What it does |
|---|---|
| `index.html` – Scanner | Real-time recognition + blink check, big name banner, roll call report, Excel |
| `registration.html` | Register students with 3–10 face samples (camera or photos) and their groups |
| `admin.html` (double-click the watermark, password in `config.js`) | Register teachers, **calibrate the threshold** |

## How recognition works (`www/js/face-engine.js`)
```
camera frame ──► TinyFaceDetector + 68 landmarks (every frame, ~12 fps)
                   │
                   ├─► FaceTracker (same face between frames, IoU)
                   │      └─► BlinkLiveness  (A: eye geometry  B: eye pixels vs nose bridge)
                   │
                   └─► every 250 ms: 128-D descriptor ─► FaceGallery.match (threshold + margin)
                                                            └─► vote 3 of last 5
identity confirmed AND blinked ──► History entry ──► (confident?) learn new appearance
```
* **Anti-photo (liveness):** a natural blink is required. A printed photo, an ID card or a photo on
  a phone can't blink; tilting, moving or blurring a photo changes the whole face and is rejected.
  Limitation: a *video* of the student replayed on a phone could pass — acceptable for a
  classroom with a teacher present; the next level would be a passive anti-spoofing model.
* **Threshold:** see [`docs/THRESHOLD.md`](docs/THRESHOLD.md) (measured data, glasses decision).
* **Excel:** see [`docs/EXCEL.md`](docs/EXCEL.md).
* **All parameters** are in [`www/js/config.js`](www/js/config.js), documented one by one.
  Set `LIVENESS.DEBUG = true` to see live EAR / correlation / distance numbers on the scanner.

## Firestore data model
| Collection | Document | Fields |
|---|---|---|
| `Users` | email | `fullName, email, groups[], descriptors[{v[128], src, at}], descriptor (legacy), registrationDate` |
| `Teachers` | email | `name, groups[]` |
| `History` | auto | `name, email, timestamp, dayKey, date, time, distance, margin, liveness` |
| `Sessions` | name | `name` |
| `Attendance` | `group__session` | `group, session, dayKey, startMs, endMs, teacherEmail, records{email:{name,status,time}}` |

Old users with a single `descriptor` still work; re-register them to get 3+ samples
(the scanner status line tells you how many still have only 1–2).

## Build & run on the tablet
```bash
npm install                 # first time / after pulling (adds filesystem + share plugins)
npx cap sync android        # copies www/ into the Android project
# then Run ▶ in Android Studio
```

## Tests
```bash
npm test                    # liveness timing, gallery margin, voting (Node, no browser)
```
End-to-end tests were run in headless Chrome with a fake camera: static photo (not recorded ✅),
blinking face (recorded ✅ + new appearance learned), unregistered person, registration quality
gate + duplicate detection, roll call report, Excel export and Graph sync (mocked).
