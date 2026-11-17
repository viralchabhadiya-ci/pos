import ar400 from "@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff2";
import ar700 from "@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-700-normal.woff2";
import la400 from "@fontsource/noto-sans-arabic/files/noto-sans-arabic-latin-400-normal.woff2";
import la700 from "@fontsource/noto-sans-arabic/files/noto-sans-arabic-latin-700-normal.woff2";

/**
 * Noto Sans Arabic ships with the till (the service worker caches it), so Arabic looks the
 * same on every device, offline too, and printed receipts are drawn with a known font.
 */
export const ARABIC_FONT = "Noto Sans Arabic";

const ARABIC_RANGE = "U+0600-06FF, U+0750-077F, U+08A0-08FF, U+200C-200E, U+FB50-FDFF, U+FE70-FEFC";
const LATIN_RANGE = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2212";

let loading: Promise<void> | null = null;

/** Registers and loads the font once. Safe to call often; resolves even if loading fails. */
export function loadArabicFont(): Promise<void> {
  if (loading) return loading;
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return Promise.resolve();
  const faces = [
    new FontFace(ARABIC_FONT, `url(${ar400}) format("woff2")`, { weight: "400", unicodeRange: ARABIC_RANGE }),
    new FontFace(ARABIC_FONT, `url(${ar700}) format("woff2")`, { weight: "700", unicodeRange: ARABIC_RANGE }),
    new FontFace(ARABIC_FONT, `url(${la400}) format("woff2")`, { weight: "400", unicodeRange: LATIN_RANGE }),
    new FontFace(ARABIC_FONT, `url(${la700}) format("woff2")`, { weight: "700", unicodeRange: LATIN_RANGE }),
  ];
  loading = Promise.all(
    faces.map(async (f) => {
      document.fonts.add(f);
      await f.load();
    }),
  ).then(
    () => undefined,
    () => undefined,
  );
  return loading;
}
