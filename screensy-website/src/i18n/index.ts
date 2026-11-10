import type { MessageKey, Messages } from "./en.ts";
import { en } from "./en.ts";
import { ja } from "./ja.ts";

export type { MessageKey } from "./en.ts";

const DICTIONARIES: Record<string, Messages> = { en, ja };

/**
 * The language of the page. The server picks the page by Accept-Language, and the page names its language in
 * <html lang>.
 */
export const pageLanguage = (): string => {
  const lang = document.documentElement.lang;
  return lang in DICTIONARIES ? lang : "en";
};

const messages = (): Messages => DICTIONARIES[pageLanguage()] ?? en;

/**
 * The text of a key in the page's language, with "{name}" and the like filled in. The values are text: React inserts
 * them as text, never as HTML.
 */
export const t = (key: MessageKey, params: Record<string, string | number> = {}): string =>
  messages()[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );

/**
 * The name to display for a participant: someone without a name is a guest numbered by the order of joining, the same
 * on every screen
 */
export const displayName = (name: string | undefined, participantId: string): string =>
  name != null && name !== "" ? name : t("name.anonymous", { number: Number(participantId) + 1 });
