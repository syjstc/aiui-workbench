# Third-party notices

AIUI Workbench / AIUI 工坊 is an independent community project. It is not an official Rokid product and is not affiliated with or endorsed by Rokid, YodaOS, Electron, Google or Genymobile. Product names and trademarks belong to their respective owners.

The MIT license in this repository covers the original workbench code and examples. Third-party code, documentation and bundled tools retain their own licenses and notices.

| Component | Source | License / notices |
| --- | --- | --- |
| AIUI official documentation and public `aiui-dev` skill | [yodaos-project/AIUI](https://github.com/yodaos-project/AIUI), pinned revision in `vendor/official/current.json` | Apache-2.0; see `vendor/official/LICENSE` and `NOTICE.md` |
| Ink Web SDK | [jsar-project/ink](https://github.com/jsar-project/ink), `@yodaos-pkg/ink` | Apache-2.0; package metadata and original notices retained |
| AIX CLI / project scaffolder | `@yodaos-pkg/aix-cli`, `@yodaos-pkg/create-aiui-agent` | MIT; original package metadata retained |
| Android Debug Bridge and its runtime libraries | [Android Platform-Tools](https://developer.android.com/tools/releases/platform-tools) | Upstream notices in `vendor/adb/<platform>/NOTICE.txt` in desktop packages |
| scrcpy, its server and runtime libraries | [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy) | Apache-2.0 and bundled dependency licenses; upstream `LICENSE` / `LICENSE.txt` retained in `vendor/scrcpy/<platform-arch>/` |
| Electron, Chromium and Node.js | [electron/electron](https://github.com/electron/electron) | MIT and third-party licenses; `LICENSE` and `LICENSES.chromium.html` retained beside the runtime |
| npm and JavaScript dependencies | Exact versions in `package-lock.json` | Individual package licenses retained in packaged `node_modules`; generated inventory in `THIRD_PARTY_LICENSES.json` |

ADB and scrcpy binaries are downloaded from pinned upstream releases during packaging and verified against the repository manifests. Generated platform binaries are excluded from Git. On macOS, nested executables are re-signed for Developer ID distribution; the upstream archive and original file hashes remain recorded in the manifests.

Documentation screenshots use only the standalone examples in `examples/`, captured with a fresh local profile. They show simulated runtime output, not optical capture or worn-device acceptance.
