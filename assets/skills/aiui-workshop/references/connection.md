# Connecting and using glasses

Read the live tools/list first. These tools require a service that exposes them; do not infer availability from the runtime or CLI version.

## Detect and explain

**Connect glasses** has equal **Wireless connection** and **Wired connection** tabs. Follow the user's choice and available hardware; neither method is preferred. Workshop remembers the selected tab and checks/installs against that tab's transport. Pass `method:"wireless"` or `method:"usb"` to `aiui_connection_guide` when guiding a specific method.

Read `aiui_environment_check` or the environment returned by setup. Missing glasses do not block implementation, simulator verification or packaging. Tell the user promptly: “The glasses are not connected yet. I can finish the app and package first; please connect before installation.” For unauthorized or offline targets, give that specific state instead. Do not call a saved record, successful pairing or downloaded APK an online connection.

Call `aiui_connection_guide({step,locale})` for `overview`, `install`, `pair` or `ready`. It returns current transport status and example screenshots from the actual Workshop interface as native MCP images. Display the relevant image with concise next steps. Screenshots are examples, not evidence of the user's current device state. Never invent screenshots of the Rokid phone app or glasses settings. After connection, use `aiui_glasses_screenshot` if a current device image is useful and that tool is available.

Environment checks read Rokid's vendor operation gate and run a read-only basic command probe even when ADB lists a device as online. Read `devices[].adbAccess` and `connection.diagnostic`: `rokid-adb-disabled` confirms the Rokid App operation switch is off, while `missing`, `unauthorized`, `offline`, `restricted`, `unavailable` and `tool-unavailable` describe other observed failures. `available` confirms basic access, not every operation. Failures include `deviceDiagnostic` and user-owned `recovery` steps, including in asynchronous jobs.

The Rokid App switch is separate from Android USB/wireless debugging and AIUI developer mode. A 2026-11-16 on/off/on test on RG-glasses firmware `1.29.013-20261110-150201` confirmed: transport stays online and Android `adb_enabled=1`, but `persist.vendor.adb` changes true/false/true; while false, screencap and input return `error: closed`. Workshop reads this property only after confirming Rokid brand/manufacturer. Missing or unrecognized values stay `unknown` and must not become a confirmed off claim. `phoneAdbSwitch` reports `on`, `off` or `unknown`; `rokidAppAdb` retains the property, model and firmware evidence.

For `rokid-adb-disabled`, tell the user to enable **Rokid AI → Home → gear beside the glasses card → Developer → Glasses ADB debugging**. Do not ask them to change Android's developer settings or AIUI developer mode to fix this vendor gate. Distinguish authorization, network/cable problems and ordinary Android file permissions. After enabling the switch, run `aiui_environment_check` again and resume the same project/workflow.

## Wired connection

Select **Wired connection**. Use a Rokid data debugging cable compatible with the glasses model. In **Rokid AI → Home → gear beside the glasses card → Developer → Glasses ADB debugging**, enable debugging, connect the cable and confirm **Allow USB debugging** on the glasses. The phone Toolbox remote can confirm this prompt. Workshop detects authorization and runtime readiness automatically. Keep the cable connected while using this transport. `aiui_connection_guide({method:"usb",locale})` returns these steps and the wired-tab screenshot.

## First connection with a phone

1. Computer and glasses must use a mutually reachable Wi-Fi network. The phone also needs to reach the computer while downloading the helper. A Bluetooth phone connection alone does not put the glasses on that Wi-Fi.
2. In Workshop, open **Connect glasses → Install Wireless Setup with your phone**. Alternatively, `aiui_connection_guide({step:"install",locale,shareHelper:true})` creates the same temporary download page and a phone-download QR image. Keep Workshop open; links expire after ten minutes. The selected language follows Workshop/the supplied locale, regardless of the phone browser language.
3. Scan the **download code with the phone camera**, download the named APK, then open **Rokid AI → Toolbox → Glasses app management → Install new app**, and select that exact file from Downloads. Downloading does not prove installation.
4. Use **Rokid AI → Toolbox → Remote control** to operate glasses: swipe to move focus, tap to confirm, Back to return. The glasses temple is another option. Open **AIUI Wireless Setup** in the glasses app list and follow its settings button. If Developer options are locked, open Device info, focus Build number and tap seven times. Android version opens a clock; return and find Build number instead.

## Choose one pairing method

**Six digits:** On glasses, open **Wireless debugging → Pair device with pairing code** and keep that window open. Discover the pairing address with `aiui_adb_discover`, then call `aiui_adb_connect({address,pairingCode})`. Avoid asking the user for an address already discovered. If multiple devices are present, identify the intended target. A manual `connectAddress` comes from the main Wireless debugging screen and normally uses a different port.

**QR pairing:** Call `aiui_adb_pair_qr({action:"start"})` and display its native image. The **glasses' Wireless debugging → Pair device with QR code scanner** must scan this image. A normal phone camera cannot pair the glasses on their behalf. If firmware has no working scanner, use the six-digit method. Do not claim that every Rokid firmware supports the scanner.

Use the returned `id` to query `action:"status"`, with about 1–2 seconds between calls, only while waiting for the user scan and at most until `expiresAt` (two minutes). A scan detected before expiry enters `pairing`; keep checking that handshake until connected, paired, failed or expired. Cancel the same session when the user changes methods, leaves or cancels. Credentials stay in memory and are discarded on completion, cancellation or expiration. Only the matching QR service is eligible; never pair an unrelated nearby service.

`paired:true,connected:false` means authorization succeeded but transport is pending. Explain the main debugging screen's connection address instead of pairing repeatedly. `connected:true` is verified online transport; AIUI runtime readiness is checked separately before deployment.

## Install, open and operate

After connection, continue the same `projectId`/`workflowId`. Workshop's **Install on glasses → Open on glasses** installs and starts an AIUI project. Ordinary Android APKs can be installed through **Rokid AI → Toolbox → Glasses app management → Install new app**. Do not present an AIUI project package as an Android APK.

Tell the user where to open their app and how to use the phone remote or temple. Use the project's actual controls; one physical temple swipe must perform at most one discrete menu operation. For later sessions, keep glasses on, on the same Wi-Fi, with wireless debugging enabled; Workshop attempts reconnecting saved devices. Avoid promising reconnection across every restart or network change.
