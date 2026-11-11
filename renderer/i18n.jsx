import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale } from '../shared/i18n.mjs';
export { getLocale, setLocale, t, translateMessage } from '../shared/i18n.mjs';
export const useLocale = () => useSyncExternalStore(subscribeLocale, getLocale);
