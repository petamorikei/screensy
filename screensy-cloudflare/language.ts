/**
 * The languages of the pages in translations/, with the fallback first
 */
const LANGUAGES = ["en", "ja"] as const;

export type Language = (typeof LANGUAGES)[number];

const isLanguage = (value: string): value is Language => (LANGUAGES as readonly string[]).includes(value);

/**
 * Chooses the page for an Accept-Language header, like the Go server: the supported language with the highest
 * weight (a region such as "ja-JP" counts as its language), and English if there is none.
 */
export const pickLanguage = (header: string | null): Language => {
  const ranges = (header ?? "")
    .split(",")
    .map((range, index) => {
      const [tag = "", ...parameters] = range.split(";").map((part) => part.trim());
      const weight = parameters.find((parameter) => parameter.startsWith("q="));
      const quality = weight === undefined ? 1 : Number.parseFloat(weight.slice(2));

      return {
        language: tag.toLowerCase().split("-")[0] ?? "",
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((range) => range.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  return ranges.map((range) => range.language).find(isLanguage) ?? LANGUAGES[0];
};
