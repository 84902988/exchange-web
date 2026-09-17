import AsyncStorage from '@react-native-async-storage/async-storage';
import {branding} from '../config/brandingConfig';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createTranslator,
  defaultLocale,
  isMobileLocale,
  type MobileLocale,
  type Translator,
} from './catalog';

export const MOBILE_LOCALE_STORAGE_KEY = 'exchange.mobile.locale.v1';

type LanguageContextValue = {
  locale: MobileLocale;
  ready: boolean;
  setLocale: (locale: MobileLocale) => Promise<void>;
  t: Translator;
};

const defaultContext: LanguageContextValue = {
  locale: defaultLocale,
  ready: true,
  setLocale: async () => {},
  t: createTranslator(defaultLocale),
};

const LanguageContext = createContext<LanguageContextValue>(defaultContext);

async function loadStoredLocale() {
  const current = await AsyncStorage.getItem(MOBILE_LOCALE_STORAGE_KEY);
  if (isMobileLocale(current)) return current;
  for (const key of branding.legacyLocaleStorageKeys) {
    const previous = await AsyncStorage.getItem(key);
    if (isMobileLocale(previous)) {
      await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, previous).catch(() => {});
      return previous;
    }
  }
  return current;
}

export function LanguageProvider({children}: {children: ReactNode}) {
  const [locale, setLocaleState] = useState<MobileLocale>(defaultLocale);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    loadStoredLocale()
      .then(storedLocale => {
        if (active && isMobileLocale(storedLocale)) {
          setLocaleState(storedLocale);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const setLocale = useCallback(async (nextLocale: MobileLocale) => {
    if (!isMobileLocale(nextLocale)) return;
    setLocaleState(nextLocale);
    try {
      await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // The selected language remains active for this session even if the
      // device cannot persist preferences.
    }
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({
      locale,
      ready,
      setLocale,
      t: createTranslator(locale),
    }),
    [locale, ready, setLocale],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
