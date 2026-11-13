# Common verification workflows

Reuse the project's context and revision, and the evidence already returned. Read logs incrementally with `afterSequence`; request screenshots only to inspect a visual result. A passing static check or healthy runtime does not prove behavior.

## Temple input and menu navigation

Read the project's AGENTS.md and its discrete-input reference. One physical swipe performs at most one discrete operation. Use `aiui_preview_test` steps to cover a long swipe, repeated keyup-only aliases, a second swipe after silence, reversal, page changes and back. Keep original event times; callback delays caused by drawing are not separate gestures. Assert the application's selected item/page with fresh logs or state, not just absence of errors. Report worn gestures as pending until tested on glasses.

## 3DoF

Simulator controls use wearer directions: positive yaw turns right, positive pitch looks up, positive roll tilts right. The ghost head is viewed from behind the wearer. SDK quaternions are `[x,y,z,w]`, in the Android Z-up world; the level simulator basis is a 90° X rotation. This is a simulator mounting convention, not proof that every glasses host uses the same mounting axes.

Test each axis both ways, reset, and a combined rotation through `pose`, `pose_stream` and `pose_motion`. Assert the app's gaze/view behavior, not only the slider numbers. Stationary world objects move opposite to the view when the wearer turns. Do not fix an application's inverse camera transform by reversing simulator sensor axes. Confirm actual device directions with a worn left/right, up/down and tilt check before claiming hardware parity.

## Camera and recording

Use `camera_fixture` with a known local image for repeatable frames. `camera_source=webcam` requires the computer's real permission and exposes computer-camera frames. Test denied permission and cleanup on hide/exit. Captured PNGs are preview frames, not the glasses' native photo modes. Record a bounded clip using `aiui_record_clip` or a preview test with `record=true`; report simulated rendering separately from glasses screen capture and worn optical footage.

## AI and device handoff

For temporary AI-assisted automation, read [simulator-ai.md](simulator-ai.md). Unsupported image input, speech/audio, hardware-only services or unavailable AI workers require an honest device-test handoff. Keep unrelated static and input tests moving. If the workflow supports it, use `verification={mode:"device",reason:"<specific missing capability and device test plan>"}` on the same workflow. Do not claim a feature passed because a canned response or text-only substitute was returned.

## Recover without losing the project

Read the returned diagnostic and recovery owner. Fix AI-owned source/runtime failures and rerun current evidence; describe the exact device connection/authorization step for user-owned blockers. Resume the same project and workflow. Source or toolchain changes invalidate earlier tests/builds. Do not reinstall tools merely because the connection is slow, or mark a diagnostic resolved before verification.
