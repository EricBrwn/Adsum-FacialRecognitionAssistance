# Recognition threshold, multiple samples & glasses

## What the numbers mean
Every face becomes a 128‑number vector (*descriptor*). The **Euclidean distance** between two
descriptors says how similar two faces are: small = same person, large = different people.
`ACCEPT_DISTANCE` is the maximum distance at which we say "it's this student".

## Measurements (face-api.js models used by Adsum)
40 photos of 8 different people, faces padded into a 640×480 frame like a camera image.

| | median | p95 | worst |
|---|---|---|---|
| Same person, different photo | 0.44 | 0.56 | 0.59 |
| Different people (closest pair) | 0.76 | — | **0.60** |

Accept rate of a **single frame** with the old setup vs. the new one:

| Samples per person | thr 0.45 | thr 0.50 | thr 0.55 | wrong person accepted |
|---|---|---|---|---|
| 1 (old: one photo) | 52.5 % | 77.5 % | 92.5 % | 0 % |
| 2 | 70.8 % | 92.9 % | 99.2 % | 0 % |
| 3 | 78.8 % | **97.5 %** | 100 % | 0 % |

**Conclusion:** the old problem was not the threshold alone but having **one photo per person**.
With 0.45 and one photo, half of the genuine attempts failed on any given frame.

## What Adsum does now (config.js → `RECOGNITION`)
1. **≥ 3 samples per student** (registration enforces it; camera capture takes 5 automatically).
2. **ACCEPT_DISTANCE = 0.50** – conservative for a class of similar-age students (a real
   classroom has more look-alikes than 8 TV actors, so we keep a ~0.10 gap to the 0.60 we measured).
3. **MIN_MARGIN = 0.06** – the 2nd-best *other* student must be at least 0.06 farther.
   This rejects ambiguous faces between two similar students instead of guessing.
4. **Temporal vote** – 3 of the last 5 recognitions (≈ 1.25 s) must agree before the identity
   is confirmed. One bad frame can't mark the wrong student.

## Calibrating with YOUR students
Admin Console → **🎯 Recognition Calibration → Analyze database**. It computes the same table
with your real database, lists the most similar pairs of students and the students with fewer
than 3 samples, and suggests a threshold. "Apply" stores it **on that tablet** (no rebuild needed).
Every entry in `History` now stores `distance` and `margin`, so the tool also shows what the
scanner is really seeing in the classroom.

## Glasses — decision
* **Students never have to remove their glasses at the scanner.** The descriptor network is
  trained to be robust to normal glasses (in the tests, a sample with glasses and two without
  were matched as the same person).
* **At registration**, if a student sometimes wears glasses and sometimes not, capture once
  **with** and once **without** (the page shows this tip). That costs 10 seconds.
* **Automatic (adaptive gallery):** when a student is recognized with high confidence
  (distance 0.20–0.45, margin ≥ 0.12) **and** passed the blink check, the scanner stores that
  live descriptor as an extra `auto` sample (max 6, one every 12 h, oldest replaced).
  New glasses, a haircut or a beard are learned by themselves over the semester.
  The strict conditions + liveness prevent learning a wrong face.
* Sunglasses, masks or caps covering the eyes do reduce accuracy and also block the blink
  check — those must be removed (the scanner will just keep showing "Analyzing…").
