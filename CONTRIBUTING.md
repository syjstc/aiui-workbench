# Contributing

Use Node.js 24 LTS (minimum 22.22) and npm. Clone this repository, run `npm ci`, then `npm run prepare:tools` and `npm run dev`.

Before opening a pull request:

```sh
npm test
npm run build
npm run check:public
```

For changes to desktop, MCP or preview behavior, run the relevant integration checks described in [development](docs/development.md). Keep generated user profiles and test evidence under `.local/` and `output/`. Use the public examples for screenshots and bug reports; remove connection tokens, device serials, account information and private source paths.

The interface uses Chinese strings as message IDs, with English translations in `shared/locales/en.json`. Update both when changing user-facing copy. Keep simulator, physical-device and platform-publishing results distinct.

One physical temple swipe must produce at most one discrete action. Follow [the input contract](docs/rokid-discrete-input.md), including repeat events, keyup-only firmware, rendering stalls and lifecycle cleanup.

Describe the behavior change and the checks you ran in your pull request. Signing certificates, Apple API keys and account sessions belong in local credentials or CI secrets, never in Git.
