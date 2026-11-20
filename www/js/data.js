// =====================================================================
// 🗄️ ADSUM DATA LAYER (Firestore)
// All reads/writes to the database go through here.
//
// Collections:
//   Users/{email}        fullName, email, groups[], descriptor (legacy), descriptors[{v,src,at}], registrationDate
//   Teachers/{email}     name, groups[]
//   History/{auto}       one doc per recognized entry (name, email, timestamp, date, dayKey, distance, margin, liveness)
//   Sessions/{name}      name
//   Attendance/{group__session}   final roll call: group, session, dayKey, records{email:{name,status,time}}
// =====================================================================
import { db } from "./firebase-config.js";
import {
    collection, getDocs, addDoc, query, where, doc, setDoc, getDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { readSamples } from "./face-engine.js";

/** Local date as YYYY-MM-DD (doesn't depend on the device's language, unlike toLocaleDateString). */
export function dayKey(date = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * Downloads every registered user.
 * @returns {{ people: Array<{id,name,groups,samples}>, groups: Object<string,string[]> }}
 *          groups = { groupName: [emails] }
 */
export async function loadUsers() {
    const snapshot = await getDocs(collection(db, "Users"));
    const people = [];
    const groups = {};
    snapshot.forEach((d) => {
        const data = d.data();
        if (!data.fullName) return;
        const samples = readSamples(data);
        const personGroups = Array.isArray(data.groups) && data.groups.length ? data.groups : ["No Group"];
        people.push({ id: d.id, name: String(data.fullName), groups: personGroups, samples });
        personGroups.forEach((g) => (groups[g] ||= []).push(d.id));
    });
    return { people, groups };
}

export async function getUser(email) {
    const snap = await getDoc(doc(db, "Users", email));
    return snap.exists() ? snap.data() : null;
}

export async function saveUser(email, data) {
    await setDoc(doc(db, "Users", email), data, { merge: true });
}

export async function replaceUserSamples(email, serializedSamples) {
    await updateDoc(doc(db, "Users", email), { descriptors: serializedSamples });
}

export async function getTeacher(email) {
    const snap = await getDoc(doc(db, "Teachers", email));
    return snap.exists() ? snap.data() : null;
}

export async function saveTeacher(email, data) {
    await setDoc(doc(db, "Teachers", email), data);
}

/** One entry per recognized person. Extra fields (distance/margin) are kept for threshold calibration. */
export async function logEntry({ email, name, distance, margin, liveness }) {
    const now = new Date();
    await addDoc(collection(db, "History"), {
        name,
        email,
        date: now.toLocaleDateString(),   // kept for backwards compatibility
        time: now.toLocaleTimeString(),
        dayKey: dayKey(now),
        timestamp: now.getTime(),
        distance: Number.isFinite(distance) ? Math.round(distance * 1000) / 1000 : null,
        margin: Number.isFinite(margin) ? Math.round(margin * 1000) / 1000 : null,
        liveness: !!liveness,
    });
}

/** Entries between two timestamps (single-field range query → no composite index needed). */
export async function getEntriesBetween(startMs, endMs) {
    const q = query(collection(db, "History"), where("timestamp", ">=", startMs), where("timestamp", "<=", endMs));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data());
}

export async function getSessions() {
    const snap = await getDocs(collection(db, "Sessions"));
    return snap.docs.map((d) => d.id);
}

export async function saveSession(name) {
    await setDoc(doc(db, "Sessions", name), { name });
}

const attendanceId = (group, session) => `${group}__${session}`.replace(/\//g, "-");

/** Stores the final roll call of a session (source of truth for the Excel export). */
export async function saveAttendance({ group, session, startMs, endMs, teacherEmail, records }) {
    await setDoc(doc(db, "Attendance", attendanceId(group, session)), {
        group, session, teacherEmail: teacherEmail || null,
        dayKey: dayKey(new Date(startMs)), startMs, endMs,
        records, updatedAt: Date.now(),
    });
}

export async function getGroupAttendance(group) {
    const snap = await getDocs(query(collection(db, "Attendance"), where("group", "==", group)));
    return snap.docs.map((d) => d.data()).sort((a, b) => a.startMs - b.startMs);
}

export async function getRecentEntries(sinceMs) {
    const snap = await getDocs(query(collection(db, "History"), where("timestamp", ">=", sinceMs)));
    return snap.docs.map((d) => d.data());
}
