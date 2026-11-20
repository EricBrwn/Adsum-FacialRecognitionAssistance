# Excel integration

Adsum stores every roll call in Firestore (`Attendance` collection) and generates the
same layout for Excel:

| Name | Email | Session01 (2026-11-10) | Session02 (2026-11-17) | … | Attended | Total | % |
|---|---|---|---|---|---|---|---|
| Ana López | ana@tec.mx | A | P | | 1 | 2 | 50 |

Empty cell = the student wasn't in the group yet for that session.

## Option 1 — 📥 Download Excel (works today, no setup)
Scanner → ⚙️ Configure Roll Call → *Generate Full Report* → **📥 Download Excel**.
On the tablet it opens Android's *Share* menu → choose OneDrive / Teams / Outlook to put it
in the teacher's folder. Requires the two Capacitor plugins (already in `package.json`):

```bash
npm install
npx cap sync android
```

## Option 2 — ☁️ Sync to SharePoint Excel (writes directly into GanttDates.xlsx)
Adsum writes into **its own sheets** named `Adsum - <group>` inside the workbook, so it never
touches the teacher's existing sheets, whatever their structure is. Each sync rewrites the sheet
with all the sessions of that group.

The button is hidden until `CONFIG.EXCEL.GRAPH_CLIENT_ID` is set. To enable it:

1. Sign in at <https://portal.azure.com> → **Microsoft Entra ID → App registrations → New registration**
   * Name: `Adsum`
   * Supported account types: *Accounts in any organizational directory (Multitenant)*
   * Redirect URI → platform **Single-page application (SPA)**:
     * `https://localhost/index.html` (Android app)
     * `http://localhost:5500/www/index.html` (or whatever URL you use for testing in the browser)
2. **API permissions → Add → Microsoft Graph → Delegated**: `Files.ReadWrite.All`, `User.Read`, `offline_access`.
3. Copy the **Application (client) ID** into `www/js/config.js → EXCEL.GRAPH_CLIENT_ID`.
4. The person who presses the button signs in with their **@tec.mx** account and must have
   **edit** permission on GanttDates.xlsx (David Sotelo, or someone he shared it with).

⚠️ **Possible blocker:** the Tec tenant may require **admin consent** for third-party apps.
If the Microsoft login shows "Need admin approval", you need to ask Tec IT (or the professor
can request it) — or use Option 1 meanwhile. Nothing else in Adsum depends on this.

### How it works (technical)
* OAuth 2.0 **Authorization Code + PKCE** implemented in `excel.js` (no SDK). The token is kept in
  `localStorage` and refreshed automatically; after the Microsoft login the page comes back
  and **resumes the sync by itself**.
* The workbook is located from its sharing link with `GET /shares/{encoded-url}/driveItem`;
  if that fails, it searches the owner's OneDrive by file name.
* Writes with the Excel REST API: `worksheets/add` → `range/clear` → `PATCH range {values}`.
* `capacitor.config.json → server.allowNavigation` lets the Microsoft login open inside the app.
