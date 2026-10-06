(() => {
  "use strict";
  const app = globalThis.MapsLeadFinder;
  const lib = globalThis.libphonenumber;
  const { clean, digits } = app.utils;
  const international = value => /^(?:\+|00)/.test(clean(value));
  const ascii = value => clean(value).replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0) - 0x6f0));
  function code(value) {
    const input = clean(value);
    if (!input) return "";
    if (!/^\+?\d{1,3}$/.test(input)) throw new Error("Enter a country code such as +971 or +44, with no spaces or phone number.");
    const number = input.replace(/^\+/, "");
    if (!lib.getCountries().some(country => lib.getCountryCallingCode(country) === number)) throw new Error("That country code is not recognized. Enter a code such as +971 or +44.");
    return number;
  }
  function parseInternational(value) {
    const input = ascii(value).replace(/^00/, "+");
    if (!input.startsWith("+")) return null;
    try { return lib.parsePhoneNumberFromString(input, { extract: false }) || null; } catch { return null; }
  }
  function infer(local, full) {
    const parsed = parseInternational(full);
    if (!parsed?.isPossible()) return null;
    const localDigits = digits(local);
    const national = parsed.nationalNumber;
    if (localDigits && !international(local) && !localDigits.endsWith(national)) return null;
    const dropPrefix = localDigits && !international(local) ? localDigits.slice(0, -national.length) : null;
    if (dropPrefix && dropPrefix !== "0" && dropPrefix !== parsed.countryCallingCode && dropPrefix !== "8") return null;
    return { callingCode: parsed.countryCallingCode, country: parsed.country, dropPrefix, source: "detected" };
  }
  function format(value, rule) {
    const raw = clean(value);
    if (!raw || international(raw)) return { value: raw, unresolved: false };
    if (!rule) return { value: raw, unresolved: true };
    try {
      // National metadata preserves significant Italian zeroes and handles trunk prefixes.
      const parsed = lib.parsePhoneNumberFromString(ascii(raw), {
        defaultCallingCode: rule.callingCode, ...(rule.country ? { defaultCountry: rule.country } : {}), extract: false
      });
      if (parsed?.isPossible()) return { value: parsed.formatInternational(), unresolved: false };
    } catch { /* Preserve ambiguous or invalid numbers instead of inventing a code. */ }
    return { value: raw, unresolved: true };
  }
  app.phone = { code, infer, format, international, parseInternational };
})();
