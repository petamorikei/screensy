export const NAME_STORAGE_KEY = "screensy.name";
export const RESUME_STORAGE_PREFIX = "screensy.resume.";

/**
 * Reads a value from Web Storage. Storage can be unavailable, for example in a private window.
 */
export const readStorage = (getStorage: () => Storage, key: string): string | null => {
  try {
    return getStorage().getItem(key);
  } catch {
    return null;
  }
};

/**
 * Writes a value to Web Storage, or removes it if the value is null.
 */
export const writeStorage = (getStorage: () => Storage, key: string, value: string | null): void => {
  try {
    if (value == null) {
      getStorage().removeItem(key);
    } else {
      getStorage().setItem(key, value);
    }
  } catch {
    // Storage is unavailable. The value is simply not remembered.
  }
};

export const getLocalStorage = () => window.localStorage;
export const getSessionStorage = () => window.sessionStorage;
