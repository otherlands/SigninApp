# eRIGHT Sign-In → SharePoint off-site copy — Entra app-registration sheet

**One page. For whoever holds Global / Application Administrator on the eRIGHT Microsoft 365 tenant.**
Written 2026-10-05 from `lib/sharepoint.js` and README "SharePoint off-site copy" (tip `bbda11e`).

## Why you are doing this (30 seconds)

The fire register runs on a server **inside** the building (CT 106, `192.168.101.102`). When the building is
on fire that server, its switch and its Wi-Fi are gone. This app registration lets the server push three small
files (`who-is-on-site.txt`, `roster.json`, `events-YYYY-MM-DD.csv`) into **one SharePoint folder** within 15 s
of every tap, so the list of who is still inside can be read on any staff phone at the assembly point.
It writes only. It never reads SharePoint. Until this is done nothing leaves the building automatically.

## What the server does with the credentials (so you can judge the permissions)

| Step | Call | Needs |
| --- | --- | --- |
| Token | `POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` — `grant_type=client_credentials`, `scope=https://graph.microsoft.com/.default` | client ID + secret |
| Find the site | `GET https://graph.microsoft.com/v1.0/sites/eright.sharepoint.com:/sites/<SiteName>` | read on that site |
| Find the library | `GET /sites/<id>/drive` (default library) or `GET /sites/<id>/drives` (named) | read on that site |
| Write the files | `PUT /drives/<id>/root:/<folder>/<file>:/content` (≤ 4 MB, creates folders) | **write on that site** |

## The five things to do

### 1 · Register the app
Entra admin centre → **App registrations → New registration**
- Name: `eRIGHT Sign-In Server`
- Supported account types: **this organisational directory only**
- Redirect URI: **none**
- Click Register, then copy from Overview:

| Copy this | Goes into |
| --- | --- |
| **Directory (tenant) ID** | `SP_TENANT_ID` |
| **Application (client) ID** | `SP_CLIENT_ID` |

> Expected tenant GUID (from llm-cluster's own SharePoint connector env, 2026-05): `b7f14193-e91d-4ce1-ae93-389c62e6d9e0`.
> Confirm it matches what Overview shows — do not type it from here.

### 2 · Create the secret
**Certificates & secrets → Client secrets → New client secret**
- Description `signin-server`, expiry **24 months** (the longest offered). **Put the expiry date in the eRIGHT diary now.**
- Copy the **Value** column (not Secret ID) **immediately** — it is shown once. → `SP_CLIENT_SECRET`
- Hand it over **only** by typing it straight into `/etc/eright-signin.env` on the server (step 5). Never paste it into Teams
  or a chat — a Teams webhook signature was pasted in chat on 2026-09-30 and has to be regenerated because of it.

### 3 · Permissions — least privilege
**API permissions → Add a permission → Microsoft Graph → Application permissions**

| Option | Permission | What the app can then touch |
| --- | --- | --- |
| **Preferred** | `Sites.Selected` | **nothing** until step 4 grants it one site |
| Fallback | `Files.ReadWrite.All` | every library in the tenant — only if step 4 is more than you want to do |

Then click **Grant admin consent for eRIGHT** (status column goes green).

### 4 · (Sites.Selected only) grant the app WRITE on the one site
Open **Graph Explorer** (developer.microsoft.com/graph/graph-explorer), sign in as the admin, consent to the
delegated `Sites.FullControl.All` scope when prompted, then run:

```
GET  https://graph.microsoft.com/v1.0/sites/eright.sharepoint.com:/sites/<SiteName>
```
copy the `id` from the answer (it is `hostname,guid,guid`), then:

```
POST https://graph.microsoft.com/v1.0/sites/<that id>/permissions
Content-Type: application/json

{
  "roles": ["write"],
  "grantedToIdentities": [ { "application": { "id": "<Application (client) ID>", "displayName": "eRIGHT Sign-In Server" } } ]
}
```
A `201 Created` is the proof. (Standard Graph "sites permissions" API — check the current Graph docs if the shape has changed.)

### 5 · Folder + six lines on the server
- In the chosen site's **Documents** library create the folder **`eRIGHT Ltd/Sign-in`** (any name, but match `SP_FOLDER`).
- On the server (`ssh root@192.168.101.102`), append to `/etc/eright-signin.env` (file is `chmod 600` root, alongside `ADMIN_PIN` and `API_TOKEN`):

```
SP_TENANT_ID=<Directory (tenant) ID>
SP_CLIENT_ID=<Application (client) ID>
SP_CLIENT_SECRET=<secret Value>
SP_SITE=eright.sharepoint.com:/sites/<SiteName>
SP_DRIVE=
SP_FOLDER=eRIGHT Ltd/Sign-in
```
`SP_DRIVE=` blank = the site's default Documents library; put a library's display name there to use another.
Then: `systemctl restart eright-signin`

## Proof it works (do not stop before this)

1. Sign someone in on `http://192.168.101.102:3000/` (or tap a card at the back door).
2. Within 15 s: **Admin → Off-site copies** shows the push time and the three paths — or the exact Graph error text.
   Same data at `curl -s http://192.168.101.102:3000/api/health | jq .sharepoint.last`.
3. Metrics: `curl -s http://192.168.101.102:3000/metrics | grep signin_sharepoint` →
   `signin_sharepoint_configured 1` and `signin_sharepoint_last_push_ok 1`.
   (platform-a's alert rule fires on `configured == 1 and last_push_ok == 0` once monitoring is deployed.)
4. On a **phone**, SharePoint or Teams app → the folder → tap `who-is-on-site.txt`. If the preview is poor, say so —
   the server can write a `.csv`/`.docx`-friendly form instead. Put a shortcut to the folder on every staff phone and a QR
   code to it on the assembly-point sign.

## If it fails — the message tells you which step

| Error shown in Admin / health | Means | Go back to |
| --- | --- | --- |
| `token request failed: 401 … AADSTS7000215` | secret wrong / expired | 2 |
| `token request failed: 400 … AADSTS700016` | client ID or tenant ID wrong | 1 |
| `Graph GET /sites/… -> 403` | consent not granted, or Sites.Selected without the site grant | 3 / 4 |
| `Graph GET /sites/… -> 404` | `SP_SITE` path wrong (hostname:/sites/Name) | 5 |
| `library "<name>" not found on site; have: …` | `SP_DRIVE` display name wrong — the list in the message shows the real ones | 5 |
| `Graph PUT … -> 403` | app has read but not write on the site | 4 |

## Keep on record
App name · client ID · secret expiry date · site + folder · who did it and when → add a row to the README history table.
The secret itself lives in exactly one place: `/etc/eright-signin.env` on CT 106 (backups go to `/root/eright-signin.env.bak-*`).
