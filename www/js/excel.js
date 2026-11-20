// =====================================================================
// 📊 ADSUM ↔ EXCEL
//
// Two ways to get attendance into Excel:
//
//  1) exportGroupXlsx()  → generates a .xlsx on the device (works offline,
//     no permissions needed). On Android it opens the "Share" sheet so the
//     teacher can send it to OneDrive / Teams / email.
//
//  2) syncGroupToSharePoint() → writes directly into the teacher's workbook
//     on SharePoint/OneDrive using Microsoft Graph. Adsum ONLY writes into its
//     own sheets ("Adsum - <group>"), never into the teacher's existing sheets,
//     so it works whatever structure the workbook has.
//     Requires CONFIG.EXCEL.GRAPH_CLIENT_ID (see docs/EXCEL.md).
//
// Both use the same matrix layout:
//   Name | Email | Session01 (2026-11-17) | Session02 (...) | ... | Attended | Total | %
// =====================================================================

// ---------------------------------------------------------------------
// MATRIX (pure function → easy to test)
// ---------------------------------------------------------------------
/**
 * @param attendanceDocs  docs from the Attendance collection for ONE group (sorted by date)
 * @param roster          [{id: email, name}] people currently in the group
 * @returns {{ header: string[], rows: (string|number)[][], detail: (string)[][] }}
 */
export function buildAttendanceMatrix(attendanceDocs, roster) {
    const { PRESENT_MARK, ABSENT_MARK } = CONFIG.EXCEL;
    const sessions = attendanceDocs.map(a => ({ label: `${a.session} (${a.dayKey})`, records: a.records || {} }));

    // Include people who appear in old roll calls even if they left the group
    const people = new Map(roster.map(p => [p.id, p.name]));
    attendanceDocs.forEach(a => Object.entries(a.records || {}).forEach(([email, r]) => {
        if (!people.has(email)) people.set(email, r.name || email);
    }));

    const header = ["Name", "Email", ...sessions.map(s => s.label), "Attended", "Total", "%"];
    const rows = [...people.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([email, name]) => {
            let attended = 0, total = 0;
            const cells = sessions.map(s => {
                const r = s.records[email];
                if (!r) return "";
                total++;
                if (r.status === "present") { attended++; return PRESENT_MARK; }
                return ABSENT_MARK;
            });
            const pct = total ? Math.round((attended / total) * 100) : "";
            return [name, email, ...cells, attended, total, pct];
        });

    const detail = [["Session", "Date", "Name", "Email", "Status", "Entry time"]];
    attendanceDocs.forEach(a => Object.entries(a.records || {})
        .sort((x, y) => (x[1].name || "").localeCompare(y[1].name || ""))
        .forEach(([email, r]) => detail.push([a.session, a.dayKey, r.name || email, email, r.status, r.time || ""])));

    return { header, rows, detail };
}

// ---------------------------------------------------------------------
// 1) LOCAL .XLSX EXPORT
// ---------------------------------------------------------------------
export async function exportGroupXlsx(group, matrix) {
    if (typeof XLSX === "undefined") throw new Error("SheetJS (vendor/xlsx.mini.min.js) is not loaded.");
    const wb = XLSX.utils.book_new();

    const title = [[`Adsum attendance — Group ${group}`], [`Generated ${new Date().toLocaleString()}`], []];
    const ws = XLSX.utils.aoa_to_sheet([...title, matrix.header, ...matrix.rows]);
    ws["!cols"] = matrix.header.map((h, i) => ({ wch: i === 0 ? 32 : i === 1 ? 30 : Math.max(8, h.length + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, "Attendance");

    const wsDetail = XLSX.utils.aoa_to_sheet(matrix.detail);
    wsDetail["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 32 }, { wch: 30 }, { wch: 10 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsDetail, "Detail");

    const fileName = `Adsum_${safeFileName(group)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const base64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
    await saveFile(fileName, base64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return fileName;
}

/**
 * Saves a file. In the Android app (Capacitor) a normal browser "download" does nothing,
 * so we write it with the Filesystem plugin and open the Share sheet.
 */
async function saveFile(fileName, base64, mime) {
    const cap = window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
        const { Filesystem, Share } = cap.Plugins;
        if (!Filesystem || !Share) {
            throw new Error("Install the plugins: npm i @capacitor/filesystem @capacitor/share && npx cap sync");
        }
        const result = await Filesystem.writeFile({ path: fileName, data: base64, directory: "CACHE" });
        await Share.share({ title: fileName, url: result.uri, dialogTitle: "Save or send the Excel file" });
        return;
    }
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeFileName = (s) => String(s).replace(/[^\w.-]+/g, "_");

// ---------------------------------------------------------------------
// 2) MICROSOFT GRAPH SYNC  (OAuth 2.0 Authorization Code + PKCE, no SDK)
// ---------------------------------------------------------------------
const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_KEY = "adsum.graph.token";
const PKCE_KEY = "adsum.graph.pkce";
const PENDING_KEY = "adsum.graph.pendingSync";

export const graphEnabled = () => !!CONFIG.EXCEL.GRAPH_CLIENT_ID;

const redirectUri = () => `${window.location.origin}${window.location.pathname}`;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function startSignIn(pendingAction) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    if (pendingAction) localStorage.setItem(PENDING_KEY, JSON.stringify(pendingAction));

    const params = new URLSearchParams({
        client_id: CONFIG.EXCEL.GRAPH_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri(),
        scope: CONFIG.EXCEL.GRAPH_SCOPES.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        prompt: "select_account",
    });
    window.location.assign(`${CONFIG.EXCEL.GRAPH_AUTHORITY}/oauth2/v2.0/authorize?${params}`);
}

async function requestToken(body) {
    const res = await fetch(`${CONFIG.EXCEL.GRAPH_AUTHORITY}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CONFIG.EXCEL.GRAPH_CLIENT_ID, scope: CONFIG.EXCEL.GRAPH_SCOPES.join(" "), ...body }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error_description || json.error || `Token error ${res.status}`);
    const token = { access: json.access_token, refresh: json.refresh_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
    localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    return token;
}

/**
 * Call this once on page load. If we are coming back from the Microsoft login page,
 * it exchanges the code for a token and returns the action that was pending (if any).
 */
export async function handleGraphRedirect() {
    if (!graphEnabled()) return null;
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!code && !error) return null;

    window.history.replaceState({}, document.title, redirectUri()); // clean the URL
    const pkce = JSON.parse(localStorage.getItem(PKCE_KEY) || "null");
    localStorage.removeItem(PKCE_KEY);
    if (error) throw new Error(url.searchParams.get("error_description") || error);
    if (!pkce || pkce.state !== url.searchParams.get("state")) throw new Error("Sign-in state mismatch, please try again.");

    await requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: pkce.verifier });
    const pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
    localStorage.removeItem(PENDING_KEY);
    return pending;
}

async function getAccessToken(pendingAction) {
    const token = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (token && token.expiresAt > Date.now()) return token.access;
    if (token && token.refresh) {
        try { return (await requestToken({ grant_type: "refresh_token", refresh_token: token.refresh })).access; }
        catch (e) { console.warn("Refresh failed, signing in again.", e); }
    }
    await startSignIn(pendingAction); // navigates away
    return new Promise(() => {});    // never resolves: the page is leaving
}

export function graphSignOut() { localStorage.removeItem(TOKEN_KEY); }

async function graph(token, method, path, body) {
    const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(json.error?.message || `Graph ${method} ${path} → ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return json;
}

/** Finds the workbook from its sharing link. Falls back to searching the owner's OneDrive by file name. */
async function resolveWorkbook(token) {
    const shareUrl = CONFIG.EXCEL.SHARE_URL;
    try {
        const encoded = "u!" + btoa(unescape(encodeURIComponent(shareUrl))).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
        const item = await graph(token, "GET", `/shares/${encoded}/driveItem?$select=id,name,parentReference`);
        return { driveId: item.parentReference.driveId, itemId: item.id, name: item.name };
    } catch (e) {
        console.warn("Shares API could not resolve the link, trying search by name.", e);
    }
    const url = new URL(shareUrl);
    const fileName = url.searchParams.get("file");
    const personal = url.pathname.match(/\/personal\/([^/]+)/);
    if (!fileName || !personal) throw new Error("Could not locate the workbook from SHARE_URL.");
    const site = await graph(token, "GET", `/sites/${url.hostname}:/personal/${personal[1]}`);
    const found = await graph(token, "GET", `/sites/${site.id}/drive/root/search(q='${encodeURIComponent(fileName)}')?$select=id,name,parentReference`);
    const item = (found.value || []).find(i => i.name === fileName);
    if (!item) throw new Error(`"${fileName}" not found or you don't have access to it.`);
    return { driveId: item.parentReference.driveId, itemId: item.id, name: item.name };
}

export function columnLetter(n) { // 1 → A, 27 → AA
    let s = "";
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

export function sheetNameFor(group) {
    return (CONFIG.EXCEL.SHEET_PREFIX + group).replace(/[\[\]:*?\/\\]/g, "-").slice(0, 31);
}

/**
 * Writes the matrix of a group into its own sheet of the shared workbook.
 * If the user is not signed in, this redirects to Microsoft and resumes automatically after login.
 */
export async function syncGroupToSharePoint(group, matrix) {
    if (!graphEnabled()) throw new Error("GRAPH_CLIENT_ID is not configured (see docs/EXCEL.md).");
    const token = await getAccessToken({ type: "sync", group });
    const wbInfo = await resolveWorkbook(token);
    const base = `/drives/${wbInfo.driveId}/items/${wbInfo.itemId}/workbook`;
    const sheetName = sheetNameFor(group);
    const sheetRef = `worksheets('${encodeURIComponent(sheetName.replace(/'/g, "''"))}')`;

    // Create the sheet if it doesn't exist yet
    const sheets = await graph(token, "GET", `${base}/worksheets?$select=name`);
    if (!sheets.value.some(s => s.name === sheetName)) {
        await graph(token, "POST", `${base}/worksheets/add`, { name: sheetName });
    }

    const values = [
        [`Adsum attendance — Group ${group}`, ...Array(matrix.header.length - 1).fill("")],
        [`Updated ${new Date().toLocaleString()}`, ...Array(matrix.header.length - 1).fill("")],
        matrix.header,
        ...matrix.rows.map(r => r.map(c => (c === null || c === undefined ? "" : c))),
    ];
    const lastCol = columnLetter(matrix.header.length);

    // Clear old content (the roster may have shrunk) and write everything in one call
    await graph(token, "POST", `${base}/${sheetRef}/range(address='A1:${columnLetter(Math.max(26, matrix.header.length + 5))}2000')/clear`, { applyTo: "Contents" });
    await graph(token, "PATCH", `${base}/${sheetRef}/range(address='A1:${lastCol}${values.length}')`, { values });
    await graph(token, "PATCH", `${base}/${sheetRef}/range(address='A3:${lastCol}3')/format/font`, { bold: true });

    return { workbook: wbInfo.name, sheet: sheetName };
}
