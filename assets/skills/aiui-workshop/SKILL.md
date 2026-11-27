---
name: aiui-workshop
description: Connect to AIUI Workshop, recover an unavailable or outdated Workshop service or missing MCP connection, and coordinate source editing, preview evidence, builds, glasses installation and blocked-task recovery. Use with the official aiui-dev skill when a user asks Workshop to make or improve an app for Rokid glasses.
---

# AIUI Workshop workflow

This skill supplements the official `aiui-dev` skill. The official skill and its referenced delivery checklist own application syntax, components, runtime APIs, design rules and validation requirements. Do not copy or replace those rules here. Read `aiui_context_get` for the project's pinned official revision, then read the relevant references with `aiui_docs_read`. Preserve the user's project instructions and authorization.

## Discover before acting

If the Workshop service is unavailable, first explain that the user should open **AIUI Workshop** and retry. If it is already open but unresponsive, ask the user to restart it, then refresh the MCP connection. If the service is older, its launcher is missing, or required tools still do not appear, direct the user to Workshop's update controls or the current official release, reopen the updated app and refresh the AI connection (or start a new chat if that client caches tools). Do not assume a timeout means an update is required: distinguish not-open, disconnected, busy and outdated states using the evidence available. Use the startup diagnostic/retry tools if exposed. Preserve the request and project/workflow identities; continue after recovery without recreating the project or endlessly repeating failed calls.

Before setup, check your loaded AIUI skills, including plugin-provided copies. Report their names through `existingSkills` when the tool supports them to avoid duplicate installation.

Installation makes skills available for later use. Start development with the pinned `aiui-dev`. When a task reaches a specialty, use the matching version already loaded or read its `path` and `revision` from `officialSkills` via `aiui_docs_read`. `aiui-debug` covers failure diagnosis, `aiui-cloud-apis` covers the app's built-in `open` module, and `aiui-cloud-integration` covers server integration.

## Load optimization guidance when it can change a decision

- Before choosing or exporting substantial image or audio assets, or when reducing package size, read official `aiui-optimize` for the AIX budget and [asset optimization](references/asset-optimization.md) for a repeatable media workflow.
- Before designing an animated game scene or adding continuous input, use the early design section in [game performance](references/optimization.md). Use the profiling section for slow startup, frame drops or input stalls. See the official `aiui-dev` API reference for the specific runtime capability in use.
- For a small UI or logic edit, use the relevant development reference. Open specialists and supporting references when the work reaches their topic.

Context checks managed global and inherited copies even when reported in `existingSkills`. Workshop updates intact managed copies and verified original snapshots, including supporting references; user edits and linked folders are preserved. Use the current inline guide immediately if a client's cached skill is older. Do not repeatedly reinstall or reread all context. Official project rules stay pinned to that project's revision; global copies follow the current official snapshot.

Read the connected service's current tools/list and `aiui_context_get`. The Workshop service version is separate from the Ink runtime and CLI versions. Call only tools and parameters present in the live catalog. An old conversation may retain obsolete tools: request a connection refresh or a new conversation when the host does not refresh its tool list. Do not invent tools or tell a beginner to install development dependencies.

If MCP is unavailable, explain how to open Workshop's **Connect AI tools** page, add its configuration in the AI client's MCP settings and run the connection check. A copied configuration does not prove a working connection. Keep the user's idea and continue after connection succeeds.

## Continue the same project

Use an existing projectId and workflowId when supplied. With workflow tools available, start or resume that workflow, implement the actual application, then continue with explicit application-behavior assertions. Read source before editing; use expectedRevision with the project file tool, or use the host's coding tools and preserve concurrent edits.

For services without workflow tools, use the available project creation/import, coding, preview-test and build tools in order. Follow their live schemas; stop and explain an unavailable prerequisite instead of calling missing methods. Do not create a second project to recover an interrupted task.

## Execute and recover

Let Workshop execute preview interactions, assertions, screenshots, logs and builds. Inspect the evidence and follow the official delivery checklist. Wait only for jobs whose status is running. New source or toolchains invalidate old evidence.

When blocked, read the returned diagnostic or recovery instructions. Fix AI-owned problems, then retry the same task. For user-owned steps, state the blocker, the exact UI action (for example enabling glasses ADB or allowing debugging), and how to continue. Avoid dumping raw logs or repeatedly retrying an unresolved prerequisite.

When glasses are missing, unauthorized or offline, explain the observed state and the next action while continuing work that can proceed. Read `devices[].adbAccess` and returned `deviceDiagnostic`/`recovery`, then use `aiui_connection_guide` for localized steps and example screenshots. The Rokid App ADB switch has its own verified state and recovery in [Connecting and using glasses](references/connection.md). Resume the same workflow after connection.

Use attached `sharedDiagnostics` when present. Match projectId and workflowId, and confirm the owner of unassigned issues. Reading marks them read; resolve after verifying the fix. For remaining unread items, use `aiui_diagnostics_get` with the same scope and `read=false`. Use diagnosticId for targeted lookup.

Report static checks, simulator execution and actual device/worn acceptance separately, as required by the official checklist. Respect the user's requested scope; installing, uploading or publishing is not implied by a request to validate a package. Formal store submission uses Workshop's existing user-confirmation flow.

## Reuse local lessons

When `aiui_local_lessons` is available, use the relevant hints returned by context or search by symptom and project. Treat saved notes as prior evidence; check the current request, official docs and environment before applying a fix. After a reproduced fix or an explicit reusable preference, save one short trigger, action and verification boundary. Use the project ID for project-specific findings, or omit it for the user's reusable local preferences. Update an existing entry when evidence changes. Keep credentials, raw logs and project source out of the notes, and keep private details out of shared skills and feedback. Ask the user before forgetting an entry unless they already requested it.

## Common workflows

For feedback, use `aiui_feedback_prepare` only for a diagnosed Workshop defect or a suggestion explicitly raised by the user, when present in the live catalog. As the external MCP assistant, you supply the draft text; Workshop applies deterministic local redaction and formatting without calling an AI model. Users can also fill in the feedback form directly without connecting AI. Ordinary application bugs, missing device authorization and transient failures stay in the current development workflow. Supply a minimal report, reuse an existing draft, and let the user review and submit it from **Feedback & suggestions**. The target is the saved update-source repository. Do not automatically publish diagnostics, repeatedly create reports, or use external GitHub tools to bypass this flow. Read issue receipts with `aiui_feedback_status`; an unknown write result requires reconciliation, not replay.

Read only the reference relevant to the request, from the installed skill folder or `aiui_skill_read` if local files are unavailable:

- [Common issues](references/project-lessons.md): input, lifecycle, entry routes, services, assertions and media troubleshooting.
- [Verification and recovery](references/verification.md): discrete temple input, 3DoF direction, camera, recording, source changes and device handoff.
- [Connecting and using glasses](references/connection.md): first connection, helper APK installation through Rokid AI, pairing codes and QR codes, screenshots and phone remote control.
- [AI-assisted simulator verification](references/simulator-ai.md): temporary event handoff to the active AI during automation. Ordinary simulator users test AI features on glasses. This does not start an AI process or wake an idle chat.
