---
name: aiui-workshop
description: Connect to AIUI Workshop, recover an unavailable or outdated Workshop service or missing MCP connection, and coordinate source editing, preview evidence, builds, glasses installation and blocked-task recovery. Use with the official aiui-dev skill when a user asks Workshop to make or improve an app for Rokid glasses.
---

# AIUI Workshop workflow

This skill supplements the official `aiui-dev` skill. The official skill and its referenced delivery checklist own application syntax, components, runtime APIs, design rules and validation requirements. Do not copy or replace those rules here. Read `aiui_context_get` for the project's pinned official revision, then read the relevant references with `aiui_docs_read`. Preserve the user's project instructions and authorization.

## Discover before acting

If the Workshop service is unavailable, first explain that the user should open **AIUI Workshop** and retry. If it is already open but unresponsive, ask the user to restart it, then refresh the MCP connection. If the service is older, its launcher is missing, or required tools still do not appear, direct the user to Workshop's update controls or the current official release, reopen the updated app and refresh the AI connection (or start a new chat if that client caches tools). Do not assume a timeout means an update is required: distinguish not-open, disconnected, busy and outdated states using the evidence available. Use the startup diagnostic/retry tools if exposed. Preserve the request and project/workflow identities; continue after recovery without recreating the project or endlessly repeating failed calls.

Before setup, check your own loaded skills, including plugin/cloud skills. Report an already available `aiui-dev` or `aiui-workshop` through `existingSkills` on context and workflow-start calls when supported, avoiding duplicate installation.

Read the connected service's current tools/list and `aiui_context_get`. The Workshop service version is separate from the Ink runtime and CLI versions. Call only tools and parameters present in the live catalog. An old conversation may retain obsolete tools: request a connection refresh or a new conversation when the host does not refresh its tool list. Do not invent tools or tell a beginner to install development dependencies.

If MCP is unavailable, explain how to open Workshop's **Connect AI tools** page, add its configuration in the AI client's MCP settings and run the connection check. A copied configuration does not prove a working connection. Keep the user's idea and continue after connection succeeds.

## Continue the same project

Use an existing projectId and workflowId when supplied. With workflow tools available, start or resume that workflow, implement the actual application, then continue with explicit application-behavior assertions. Read source before editing; use expectedRevision with the project file tool, or use the host's coding tools and preserve concurrent edits.

For services without workflow tools, use the available project creation/import, coding, preview-test and build tools in order. Follow their live schemas; stop and explain an unavailable prerequisite instead of calling missing methods. Do not create a second project to recover an interrupted task.

## Execute and recover

Let Workshop execute preview interactions, assertions, screenshots, logs and builds. Inspect the evidence and follow the official delivery checklist. Wait only for jobs whose status is running. New source or toolchains invalidate old evidence.

When blocked, read the returned diagnostic or recovery instructions. Fix AI-owned problems, then retry the same task. For user-owned steps, state the blocker, the exact UI action (for example enabling glasses ADB or allowing debugging), and how to continue. Avoid dumping raw logs or repeatedly retrying an unresolved prerequisite.

Tool responses automatically include unread `sharedDiagnostics` for the current project and shared Workshop environment, including failures. Read them directly without asking the user to copy logs. Match each record's projectId, projectPath and workflowId before editing; do not act on a different project or guess the owner of an unassigned record. Reading through MCP/CLI persists readAt/readBy and hides those records from the default unread list. Read is separate from repaired: verify the fix before resolving, and expect recurring errors to become unread again. If remainingUnread is nonzero, use aiui_diagnostics_get with the same projectId and read=false to continue; explicit diagnosticId lookups and markRead=false inspection remain available. An idle external AI cannot be awakened by Workshop; delivery occurs on its next tool call.

Report static checks, simulator execution and actual device/worn acceptance separately, as required by the official checklist. Respect the user's requested scope; installing, uploading or publishing is not implied by a request to validate a package. Formal store submission uses Workshop's existing user-confirmation flow.
