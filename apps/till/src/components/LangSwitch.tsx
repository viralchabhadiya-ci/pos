import { setLang, t, useLang } from "../lib/i18n.js";

/** One tap between English and Arabic. Each label is in its own language so anyone can find it. */
export function LangSwitch() {
  const lang = useLang();
  const next = lang === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      className="btn outline lang-switch"
      onClick={() => setLang(next)}
      aria-label={next === "ar" ? t("Switch to Arabic") : t("Switch to English")}
      title={lang === "ar" ? t("Language: Arabic") : t("Language: English")}
    >
      {next === "ar" ? (
        <span lang="ar" dir="rtl">
          العربية
        </span>
      ) : (
        <span lang="en" dir="ltr">
          English
        </span>
      )}
    </button>
  );
}
