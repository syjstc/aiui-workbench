# Official platform drafts and review

[中文](platform-uploads.md) · [Back to README](../README.en.md)

AI prepares code, store text, icons and preview media, then calls Workshop through MCP or CLI. Workshop builds and uploads drafts, verifies official results and presents materials for the user's native desktop confirmation.

> **Experimental in 0.5.8:** this integration follows current Studio endpoints, which may change. Both tabs show a warning. Real-account draft upload and digest verification have been checked; real review submission, approval and store availability remain unverified. Read back uncertain results before attempting further writes.

## First complete workflow

1. On desktop, open **Build & upload → Sign in to Rokid** and complete the official sign-in flow. The main window updates immediately and the sign-in window closes automatically. Valid encrypted sessions are reused after restart. Keep desktop Workshop running when using Web, CLI or MCP; signing in through an ordinary browser does not authorize Workshop.
2. In the build/upload tab, select one local app and set its official binding. Verify the formal name and full highlighted **Official Agent ID**. Existing apps use their existing official identity; create a new identity on the website first when needed. All stages share this binding, and MCP cannot change it.
3. Check/build the AIX, then upload it as a cloud draft. Workshop reports success after reading back and verifying the official target, version and package/code digests. Local and cloud version numbers are separate; official draft/material saves may increment the cloud version.
4. Use `aiui_platform_review_prepare` to prepare text, icon, previews and permission purposes. The desktop form also supports text and preview-file paths; icon replacement and permission purposes use MCP parameters. Saving materials does not submit a review.
5. AI requests confirmation with `aiui_platform_review_request`, or you use the desktop confirmation button. Check the target, version, package hash, text, permissions and media, then confirm in the native dialog. Cancelling does not submit.
6. Open **Official apps** and refresh the official status. Check draft, review and published versions separately. **Only confirm when the version and materials are ready for public release: store availability after approval follows official rules, and Workshop does not guarantee another publication confirmation.**

An app can have an older published version and a newer draft at the same time. A published status does not mean that the newest draft has been reviewed or released.

## Read-only official records and permissions

The official-apps tab displays the official icon, description, intent, greeting, category, permission purposes, images/video and version/status fields. Images can be enlarged. Missing fields remain explicitly missing rather than being filled with local draft materials. Results are refresh-time snapshots, not a complete version history or live push feed.

| Operation | User action | MCP capability |
| --- | --- | --- |
| Official sign-in / sign-out | Desktop official window and account buttons | Read login status; no password or cookie input |
| Change the official binding | Workshop UI after checking name and Agent ID | Read the binding; cannot change it |
| Check/build | Desktop/Web or AI | `aiui_project_build`, local output only |
| Upload a new draft | Upload action or AI | `aiui_platform_upload`, no review submission |
| Save review materials | Form or AI | `aiui_platform_review_prepare`, no review submission |
| Request confirmation | Desktop button or AI | `aiui_platform_review_request`, only `awaiting-user` |
| Submit for review | User confirms the native desktop dialog | No public MCP submission tool |
| Read official records | Official-apps tab | `aiui_platform_agents` / `aiui_platform_status` |
| Delete official records | User acts on the official website | Neither Workshop nor MCP provides deletion |

MCP may still upload new drafts and prepare materials. The official record viewer itself is read only. Deleting local task logs does not delete official records.

## Sessions and sign-out

Official sign-in uses a separate in-memory browser session, isolated from previews. Cookies and SSO state are persisted only as an OS-encrypted snapshot using Electron `safeStorage`. macOS uses Keychain; Windows uses system protection. A Linux `basic_text` backend is treated as insecure and uses memory-only sessions. Passwords are not stored, and official tokens, STS credentials and native-confirmation secrets are not returned to AI or included in task logs or packages.

Sign-out closes official and renewal windows, clears cookies/SSO/cache and the encrypted snapshot, revokes pending confirmations and stops platform tasks. It preserves local projects, materials and receipts. Account records are hidden until the same account signs in again. Requests already sent cannot be recalled by signing out.

Official cookie expiry is respected, including tokens without `exp`. Workshop may try official SSO renewal once for a session; it does not bypass expired credentials or verification. If the platform requires a new sign-in, the user completes it. Shared authorization expires within 45 seconds after desktop heartbeats stop. A manually opened official management window stays open; only the completed sign-in window closes automatically.

## Material requirements

| Material | Workshop checks |
| --- | --- |
| Description | 1–500 characters |
| Greeting | 1–300 characters |
| Change log | 5–1000 characters, including actual changes and validation limits |
| Icon / preview image | PNG/JPG/JPEG, 1 KB–5 MB, matching file signature |
| Preview video | MP4, 1 KB–50 MB, readable duration up to 60 seconds |
| Preview count | 3–5 files, including at least one image and one video |
| Permission purposes | `permissionUsage` covers each permission declared by the app, 1–500 characters per purpose |

Use absolute file paths on the computer running Workshop. Omit `iconFile` to keep the current icon. Omit `previewFiles` to reuse official previews that satisfy the requirements. An app with no declared permissions can use `"permissionUsage": {}`. These checks do not establish compliance with every official review requirement.

## MCP and CLI calls

First read `aiui_platform_status`, list official apps with `aiui_platform_agents` and ask the user to set the binding in Workshop. Build with `aiui_project_build`, then upload:

```json
{"name":"aiui_platform_upload","arguments":{"projectId":"<projectId>","agentId":"<cloudAgentId>","waitMs":45000}}
```

Prepare materials; this example app declares the `camera` permission:

```json
{"name":"aiui_platform_review_prepare","arguments":{"projectId":"<projectId>","description":"The app's actual functionality.","prologue":"Choose an example to begin.","versionLog":"Describe the changes and what was verified.","iconFile":"/absolute/app-icon.png","previewFiles":["/absolute/preview-1.png","/absolute/preview-2.png","/absolute/demo.mp4"],"permissionUsage":{"camera":"Capture a photo only when the user requests image recognition."},"waitMs":45000}}
```

Build, upload and material preparation return a job. Use `aiui_job_wait` only while its `status` is `running`. After material preparation succeeds, the draft ID is **`job.result.id`**, not `job.id`. Request confirmation:

```json
{"name":"aiui_platform_review_request","arguments":{"projectId":"<projectId>","draftId":"<reviewPrepareJob.result.id>"}}
```

This call directly returns a draft in `awaiting-user`; it does not submit. Replace all placeholders with real IDs and paths. For CLI, save only the `arguments` object in a JSON file:

```sh
node web/cli.mjs tools aiui_platform_upload
node web/cli.mjs call aiui_platform_upload --args-file /absolute/upload.json
node web/cli.mjs call aiui_platform_review_prepare --args-file /absolute/materials.json
node web/cli.mjs call aiui_platform_review_request --args-file /absolute/request.json
```

Packaged installations expose the correct command, arguments and environment through `aiui_cli_info`; no external Node installation is needed. See [shared MCP/CLI workflows](ai-tool-workflows.md).

## Results and recovery

| Result | Meaning | Next step |
| --- | --- | --- |
| Build job succeeds, `uploaded: false` | Local checks and package completed | Upload the draft |
| Upload job succeeds, `result.stage: verified`, `result.uploaded: true` | Official target and package/code draft verified | Prepare materials |
| Material job succeeds, `result.stage: ready` | Materials saved and verified | Use `result.id` to request confirmation |
| `stage: awaiting-user` | Confirmation requested, not submitted | User checks and confirms on desktop |
| `stage: submitted`, `submittedForReview: true` | Official platform accepted the review request | Refresh official review status |
| `stage: unknown` | The write outcome is uncertain | Read back; do not automatically replay |

Job `status` and receipt `stage` are separate fields. `published: false` means this Workshop workflow did not actively publish; it does not describe whether an older version is already on the store.

Use `aiui_platform_status` with `reconcile: true` to read back uncertain uploads or material saves. One negative read does not prove a delayed write cannot complete. Explicit upload recovery requires the original `resumeUploadId` and unchanged account, project, target, AIX and metadata; use **Resume this upload** when available. Do not delete receipts or caches to force a retry. For uncertain review submission, verify the official website instead of submitting again.

Changes to the source, SDK, AIX, account, binding or cloud materials invalidate previous confirmation. Rebuild/upload/prepare as needed. Native confirmation is bound to the draft digest, account, expiry and a one-time secret; passing `confirm: true` or replaying an old request cannot authorize submission.

## Validation scope

- Platform unit tests and `npm run qa:platform` use isolated data and simulated official responses. They cover binding, immediate login synchronization/window closing, encrypted restart, read-only records/media, AIX/code verification, native confirmation/cancellation and sign-out. They do not use the daily account.
- Real-account draft uploads and digest/material read-back have been checked. Real review submission, approval and store availability remain separate, unverified stages.
- [macOS and Windows 0.4.0 → 0.5.8 real GitHub upgrade checks passed](https://github.com/syjstc/aiui-workbench/actions/runs/43202875753), including verified downloads, project preservation, startup and MCP.

The [Chinese implementation notes](platform-uploads.md#确认与失败边界) describe the fixed official endpoints, scoped OSS uploads, AIX-derived code ZIP, signed-URL normalization and locally retained review fields in more detail.
