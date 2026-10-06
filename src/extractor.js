(() => {
  "use strict";
  const app = globalThis.MapsLeadFinder;
  const { clean, digits, placeKey, visible } = app.utils;
  const S = app.config.selectors;
  function findFeed() {
    return [...document.querySelectorAll(S.feed)].find(node => visible(node) && node.querySelector(S.placeLink))
      || [...document.querySelectorAll(S.feed)].find(visible) || null;
  }
  function cards(feed) {
    const seen = new Set();
    const results = [];
    for (const link of feed.querySelectorAll(S.placeLink)) {
      let card = link.closest(S.card);
      if (!card || !feed.contains(card)) {
        card = link.parentElement;
        while (card?.parentElement && card.parentElement !== feed && card.parentElement.querySelectorAll(S.placeLink).length === 1) card = card.parentElement;
      }
      if (card && !seen.has(card)) { seen.add(card); results.push({ card, link }); }
    }
    return results;
  }
  function isAd(card) {
    return card.matches(S.ad) || !!card.querySelector(`${S.ad}, ${S.adBadge}`);
  }
  function websiteURL(link) {
    const raw = link?.getAttribute("href") || "";
    if (!raw) return "";
    try {
      const url = new URL(raw, location.href);
      // Strip only Google's outbound redirect wrapper, preserving the target verbatim.
      if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === "/url") return url.searchParams.get("q") || url.searchParams.get("url") || "";
      if (!/^https?:$/.test(url.protocol)) return "";
      return /^https?:\/\//i.test(raw) ? raw : url.href;
    } catch { return ""; }
  }
  function website(card) {
    const action = card.querySelector(S.websiteAction);
    const explicit = card.querySelector(S.website);
    if (explicit) return { value: websiteURL(explicit), ambiguous: !websiteURL(explicit) };
    if (action) return { value: "", ambiguous: true };
    for (const link of card.querySelectorAll(S.externalLinks)) {
      const value = websiteURL(link);
      if (!value) continue;
      const url = new URL(value);
      if (/(^|\.)(?:google\.[a-z.]+|googleusercontent\.com|gstatic\.com|googleadservices\.com)$/i.test(url.hostname)) continue;
      return { value, ambiguous: false };
    }
    return { value: "", ambiguous: false };
  }
  function phoneValue(node) {
    if (!node) return "";
    const text = clean(node.textContent);
    if (digits(text).length >= 3 && digits(text).length <= 20 && /^[+\d٠-٩۰-۹\s().\-]+(?:\s*(?:ext\.?|x)\s*\d+)?$/i.test(text)) return text;
    // Read the localized label's numeric suffix before the compact tel target.
    const label = clean(node.getAttribute("aria-label"));
    const labeled = label.match(/(?:^|:\s*)(\+?[\d٠-٩۰-۹][\d٠-٩۰-۹\s().-]{6,})$/)?.[1]?.trim();
    if (labeled) return labeled;
    const data = node.getAttribute("data-item-id");
    const href = node.getAttribute("href");
    const target = data?.startsWith("phone:tel:") ? clean(data.slice("phone:tel:".length)) : href?.startsWith("tel:") ? clean(decodeURIComponent(href.slice(4))) : "";
    const parsed = app.phone.parseInternational(target);
    return parsed?.isPossible() ? parsed.formatInternational() : target;
  }
  function cardPhone(card) {
    for (const node of card.querySelectorAll(S.phone)) {
      const value = phoneValue(node);
      if (value) return value;
    }
    // Conservative leaf-only fallback avoids mistaking addresses, ratings, hours,
    // or years for phone numbers. A complete phone needs at least two groups.
    for (const node of card.querySelectorAll(S.textLeaves)) {
      if (node.children.length || node.closest(S.rating)) continue;
      const value = clean(node.textContent);
      if (!/^(?:\+|00|0|\()[\d٠-٩۰-۹\s().-]+$/.test(value) || !/[\s()-]/.test(value)) continue;
      const length = digits(value).length;
      if (length >= 9 && length <= 15) return value;
    }
    return "";
  }
  function category(card) {
    const explicit = card.querySelector(S.categoryExplicit);
    if (explicit) return clean(explicit.getAttribute("data-category") || explicit.textContent);
    for (const node of card.querySelectorAll(S.category)) {
      if (node.closest(S.rating) || node.querySelector(S.rating)) continue;
      const value = clean(node.textContent);
      if (!value || /^[\d\s().·]+$/.test(value) || value.includes("·") || node.querySelector(S.styled) || node.hasAttribute("style")) continue;
      return value;
    }
    return "";
  }
  function extractCard({ card, link }) {
    if (isAd(card)) return { ad: true, key: placeKey(link.href) };
    const site = website(card);
    const name = clean(link.getAttribute("aria-label")) || clean(card.querySelector(S.name)?.textContent) || clean(link.textContent);
    const cardCategory = category(card);
    const rawPhone = cardPhone(card);
    const compact = card.matches(S.compactCard);
    const needsContactDetails = compact && (!rawPhone || !site.value);
    const websiteNeedsConfirmation = compact && !site.value;
    const result = {
      key: placeKey(link.href), link: link.href, name, category: cardCategory,
      rawPhone, website: site.value,
      needsDetail: !name || !cardCategory || site.ambiguous || needsContactDetails,
      needsContactDetails, websiteNeedsConfirmation,
      websiteAmbiguous: site.ambiguous || websiteNeedsConfirmation
    };
    return result;
  }
  function details(expectedName) {
    const headings = [...document.querySelectorAll(S.detailHeading)].filter(visible);
    const heading = expectedName ? headings.find(node => clean(node.textContent) === clean(expectedName))
      : headings.find(node => {
        const main = node.closest(S.main);
        return main && !main.querySelector(S.feed) && !node.closest(S.card) && clean(node.textContent);
      });
    if (!heading) return null;
    const main = heading.closest(S.main) || document;
    const phone = [...main.querySelectorAll(S.detailPhone)].find(visible);
    const site = [...main.querySelectorAll(S.detailWebsite)].find(visible);
    const siteAction = [...main.querySelectorAll(S.websiteAction)].find(visible);
    const categoryNode = [...main.querySelectorAll(S.detailCategory)].find(visible);
    const ready = [...main.querySelectorAll(S.detailReady)].some(visible);
    const contactsReady = [...main.querySelectorAll(S.detailContactsReady)].some(visible);
    return { name: clean(heading.textContent), rawPhone: phoneValue(phone), website: websiteURL(site), websiteAmbiguous: !!siteAction && !websiteURL(site), category: clean(categoryNode?.textContent), ready, contactsReady };
  }
  function issue() {
    if (document.querySelector(S.consent) || location.hostname.startsWith("consent.")) return "Complete Google's consent or cookie screen, then return to Maps and click Start.";
    if ([...document.querySelectorAll(S.noResults)].some(visible)) return "Google Maps found no results. Try a different profession or city.";
    if ([...document.querySelectorAll(S.detailHeading)].some(visible)) return "This search opened one place. Search for a profession and city so Maps shows a results list, then click Start.";
    return "The results list could not be found. Wait for Maps to load and try again. If results are visible, Google Maps layout may have changed.";
  }
  app.extractor = { findFeed, cards, extractCard, details, issue, websiteURL, phoneValue, isAd };
})();
