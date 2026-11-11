import { readFileSync } from 'node:fs';

export const APP_INFO = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const APP_VERSION = APP_INFO.version;
