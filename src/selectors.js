/* All Maps-specific DOM hooks live here. Structural hooks precede class fallbacks.
   data-item-id / data-value are Maps identifiers, independent of UI language. */
(() => {
  "use strict";
  const app = globalThis.MapsLeadFinder = globalThis.MapsLeadFinder || {};
  app.config = Object.freeze({
    selectors: Object.freeze({
      search: '#searchboxinput, input[name="q"], input[role="combobox"]',
      feed: '[role="feed"]',
      placeLink: 'a[href*="/maps/place/"], a[href*="?cid="]',
      card: '[role="article"], .Nv2PK',
      // Compact results hide contact fields; this class is also used by organic
      // restaurants and dentists and is not evidence of an advertisement.
      compactCard: '.CpccDe',
      name: '[role="heading"], .fontHeadlineSmall, .qBF1Pd',
      category: '[data-category], .W4Efsd > span:first-child > span:first-child',
      categoryExplicit: '[data-category]',
      main: '[role="main"]',
      styled: '[style]',
      phone: 'a[href^="tel:"], [data-item-id^="phone:tel:"], .UsdlK',
      website: 'a[data-item-id="authority"], a[data-value="Website"]',
      websiteAction: '[data-item-id="authority"], [data-value="Website"]',
      actions: '[data-value], [data-item-id]',
      externalLinks: 'a[href^="http"]',
      ad: '[data-ad], [data-ad-id], [data-ad-slot], [data-is-ad="true"], a[href*="googleadservices.com"], a[href*="/aclk?"], [jsaction*="adclick"]',
      // Maps' sponsored badge is identified by its advertising tooltip action.
      adBadge: '[data-url*="adssettings.google.com/aboutthisad"], [data-url*="myadcenter.google.com"], [jsaction*="pane.advertising"], a[href*="adssettings.google.com/aboutthisad"]',
      detailHeading: 'h1.fontHeadlineLarge, [role="main"] h1, h1',
      detailPhone: '[data-item-id^="phone:tel:"], a[href^="tel:"]',
      detailAddress: '[data-item-id="address"]',
      detailWebsite: 'a[data-item-id="authority"], a[data-value="Website"]',
      detailCategory: 'button[jsaction*="category"], [data-item-id="category"]',
      detailReady: '[data-item-id="address"], [data-item-id^="phone:tel:"], [data-item-id="authority"], [jsaction*="category"]',
      detailContactsReady: '[data-item-id="address"], [data-item-id^="phone:tel:"], [data-item-id="authority"]',
      back: 'button[jsaction*="backToList"], button[jsaction*="backToSearch"], button[jsaction*="pane.back"], [role="main"] [jslog^="146078"] button, [role="main"] .hWERUb button[data-disable-idom="true"]',
      end: '.HlvSq, [data-end-of-list="true"]',
      busy: '[role="progressbar"], [aria-busy="true"]',
      consent: 'form[action*="consent.google"], iframe[src*="consent.google"], [data-consent-screen]',
      challenge: '#captcha-form, #recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-captcha-screen]',
      noResults: '[data-no-results="true"], .Q2vNVc',
      // Generic category candidates, excluding ratings and opening-hour text.
      cardMetadata: '.W4Efsd, [data-category]',
      rating: '[role="img"], .MW4etd, .UY7F9',
      textLeaves: 'span'
    }),
    timing: Object.freeze({
      poll: 120,
      scrollSettle: 320,
      idleRetry: 850,
      idleAttempts: 7,
      initialTimeout: 18000,
      detailTimeout: 6500,
      maxRun: 10 * 60 * 1000,
      navigationPoll: 350
    })
  });
})();
