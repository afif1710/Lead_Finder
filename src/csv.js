(() => {
  "use strict";
  const app = globalThis.MapsLeadFinder;
  const columns = ["business name", "category", "phone number", "website", "profession", "city"];
  function cell(value, isPhone = false) {
    let text = String(value ?? "");
    // Defend spreadsheet formulas in scraped text. A genuine phone is allowed its +.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) && !(isPhone && /^\+?[\d\s().-]+(?:\s*(?:ext\.?|x)\s*\d+)?$/i.test(text))) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function create(records, options) {
    const rows = [columns.map(value => cell(value)).join(",")];
    for (const record of records) {
      if (options.onlyWithoutWebsite && record.website) continue;
      rows.push([record.name, record.category, record.phone, record.website, options.profession, options.city].map((value, index) => cell(value, index === 2)).join(","));
    }
    return "\uFEFF" + rows.join("\r\n") + "\r\n";
  }
  function slug(value, fallback) {
    const text = String(value || "").normalize("NFKC").toLocaleLowerCase().trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/g, "");
    return text || fallback;
  }
  function filename(options, date = new Date()) {
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return `${slug(options.profession, "businesses")}_${slug(options.city, "location")}_${day}.csv`;
  }
  function download(records, options) {
    const blob = new Blob([create(records, options)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename(options);
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  app.csv = { create, filename, download, cell };
})();
