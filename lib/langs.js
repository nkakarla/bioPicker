// BioPicker — film languages. A translated film is its own version: "short-te" is the Telugu
// translation of the short version, "long-hi" the Hindi long version, "ep3-ta" episode 3 in Tamil.
// Copyright (c) 2026 EPerf

/** Languages a script can be translated into, with the free (Microsoft neural) voices that read them. */
export const LANGS = {
  hi: { name: "Hindi", native: "हिन्दी", edge: { male: "hi-IN-MadhurNeural", female: "hi-IN-SwaraNeural" } },
  te: { name: "Telugu", native: "తెలుగు", edge: { male: "te-IN-MohanNeural", female: "te-IN-ShrutiNeural" } },
  ta: { name: "Tamil", native: "தமிழ்", edge: { male: "ta-IN-ValluvarNeural", female: "ta-IN-PallaviNeural" } },
  kn: { name: "Kannada", native: "ಕನ್ನಡ", edge: { male: "kn-IN-GaganNeural", female: "kn-IN-SapnaNeural" } },
  ml: { name: "Malayalam", native: "മലയാളം", edge: { male: "ml-IN-MidhunNeural", female: "ml-IN-SobhanaNeural" } },
  mr: { name: "Marathi", native: "मराठी", edge: { male: "mr-IN-ManoharNeural", female: "mr-IN-AarohiNeural" } },
  bn: { name: "Bengali", native: "বাংলা", edge: { male: "bn-IN-BashkarNeural", female: "bn-IN-TanishaaNeural" } },
  gu: { name: "Gujarati", native: "ગુજરાતી", edge: { male: "gu-IN-NiranjanNeural", female: "gu-IN-DhwaniNeural" } },
  es: { name: "Spanish", native: "Español", edge: { male: "es-MX-JorgeNeural", female: "es-MX-DaliaNeural" } },
  fr: { name: "French", native: "Français", edge: { male: "fr-FR-HenriNeural", female: "fr-FR-DeniseNeural" } },
  de: { name: "German", native: "Deutsch", edge: { male: "de-DE-ChristophNeural", female: "de-DE-TanjaNeural" } },
};

const LANG_KEYS = Object.keys(LANGS).join("|");
export const VERSION_RE = new RegExp(`^(short|long|ep([1-9]|1[0-9]|20))(-(${LANG_KEYS}))?$`);

/** "short-te" → "short"; "ep3" → "ep3". */
export const baseOf = (v) => String(v || "").split("-")[0];
/** "short-te" → "te"; "short" → "" (the original, English, script). */
export const langOf = (v) => {
  const l = String(v || "").split("-")[1] || "";
  return LANGS[l] ? l : "";
};
export const langVersion = (base, lang) => (lang ? `${base}-${lang}` : base);

export const baseLabel = (v) => (v === "short" ? "Short version" : v === "long" ? "Long version" : `Episode ${String(v).slice(2)}`);
/** "Short version", "Short version · Telugu" */
export const versionLabel = (v) => {
  const l = langOf(v);
  return `${baseLabel(baseOf(v))}${l ? ` · ${LANGS[l].name}` : ""}`;
};
