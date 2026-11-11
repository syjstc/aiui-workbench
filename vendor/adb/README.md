# Bundled Android Debug Bridge

This directory contains unmodified Android Debug Bridge binaries and required runtime libraries from Google's stable Platform-Tools 37.0.1 archives. It does not include fastboot or device flashing utilities.

- Official archive metadata: https://dl.google.com/android/repository/repository2-1.xml
- Official download information: https://developer.android.com/tools/releases/platform-tools
- ADB source and license: https://android.googlesource.com/platform/packages/modules/adb/

Each platform directory retains the complete upstream `NOTICE.txt` and `source.properties`. The notices cover the original archive, including components not bundled here. ADB and its dependencies retain their upstream open-source licenses; the workbench does not replace those licenses or claim authorship.

`manifest.json` pins each archive URL, its SHA-1 from Google's repository metadata, its SHA-256 and every bundled file's SHA-256. `node scripts/prepare-adb.mjs --all` restores the files from those exact archives. Desktop packaging verifies the target platform files and excludes other platforms. macOS contains both Apple Silicon and Intel slices; the Windows and Linux packages target x64. Unsupported architectures fail packaging instead of silently shipping without ADB.

The application uses the bundled executable directly and adds its directory only to the official CLI subprocess environment. It does not change the user's global PATH. An explicitly selected custom ADB directory overrides the bundled version.
