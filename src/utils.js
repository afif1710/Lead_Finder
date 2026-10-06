(() => {
  "use strict";
  const app = globalThis.MapsLeadFinder;
  const clean = (value) => String(value || "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  function digits(value) {
    return clean(value).replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 0x660))
      .replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0) - 0x6f0)).replace(/\D/g, "");
  }
  function splitSearch(value) {
    const text = clean(value);
    const match = text.match(/^(.+?)\s+(?:in|near|at|في|بـ|en|dans|em|में)\s+(.+)$/iu);
    return match ? { profession: match[1].trim(), city: match[2].trim() } : { profession: text, city: "" };
  }
  function searchText() {
    const input = document.querySelector(app.config.selectors.search);
    if (input?.value?.trim()) return clean(input.value);
    return committedQuery();
  }
  function committedQuery(url = location.href) {
    try {
      const parsed = new URL(url);
      const segment = parsed.pathname.match(/\/maps\/search\/([^/]+)/)?.[1];
      return segment ? clean(decodeURIComponent(segment.replace(/\+/g, " "))) : clean(parsed.searchParams.get("q"));
    } catch { return ""; }
  }
  function placeKey(href) {
    try {
      const url = new URL(href, location.href);
      const cid = url.searchParams.get("cid");
      if (cid) return `cid:${cid}`;
      // Place identity is independent of tracking, map position, and display name.
      const decodedPath = decodeURIComponent(url.pathname);
      // Detail URLs also encode the original query as !1s before the real place.
      const id = decodedPath.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)(?:!|$)/i)?.[1]
        || [...decodedPath.matchAll(/!1s([^!]+)/g)].at(-1)?.[1];
      if (id) return `place:${id}`;
      return `${url.origin}${url.pathname.replace(/\/@.*$/, "").replace(/\/$/, "")}`;
    } catch { return clean(href); }
  }
  function abortError() { return new DOMException("Run stopped", "AbortError"); }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const done = () => { signal?.removeEventListener("abort", stop); resolve(); };
      const timer = setTimeout(done, ms);
      const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(abortError()); };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }
  async function waitFor(read, timeout, signal) {
    const start = Date.now();
    do {
      if (signal?.aborted) throw abortError();
      const result = read();
      if (result) return result;
      await sleep(app.config.timing.poll, signal);
    } while (Date.now() - start < timeout);
    return null;
  }
  const visible = (node) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  function activate(node) {
    node.setAttribute("data-mlf-activate", "true");
    node.dispatchEvent(new Event("mlf:activate-button", { bubbles: true, composed: true }));
    if (node.hasAttribute("data-mlf-activate")) { node.removeAttribute("data-mlf-activate"); node.click(); }
  }
  app.utils = { clean, digits, splitSearch, searchText, committedQuery, placeKey, sleep, waitFor, visible, abortError, activate };
})();
