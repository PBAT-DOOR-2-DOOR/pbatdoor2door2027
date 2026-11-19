// Google Analytics 4 for the public website.
//
// ➜ To turn it on, put the Measurement ID from Google Analytics (Admin → Data streams → your web stream,
//   it looks like G-ABC123XYZ) between the quotes below, or set GA_MEASUREMENT_ID on the server (that wins).
//   Leave it empty ('') to turn analytics off. The ID is not a secret: it is visible in every page anyway.
export const GA_ID_IN_CODE = '';

export const GA_ID = (process.env.GA_MEASUREMENT_ID || GA_ID_IN_CODE).trim();
export const gaValid = (id) => /^G-[A-Z0-9]{4,15}$/.test(id);

// Origins the Content-Security-Policy must allow when analytics is on.
export const GA_SCRIPT = ['https://www.googletagmanager.com'];
export const GA_CONNECT = ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com'];
export const GA_IMG = ['https://*.google-analytics.com', 'https://www.googletagmanager.com'];

/**
 * The /analytics.js file every page loads. Empty when analytics is off.
 * Page addresses are sent without ?… or #… so sign-in codes and links never reach Google,
 * and Google's advertising features are switched off.
 */
export function analyticsScript(id = GA_ID) {
  if (!gaValid(id)) return '// Google Analytics is off (no Measurement ID set).\n';
  return `// Google Analytics 4
(function () {
  var id = ${JSON.stringify(id)};
  var s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', id, {
    page_location: location.origin + location.pathname,
    page_referrer: document.referrer ? document.referrer.split(/[?#]/)[0] : undefined,
    allow_google_signals: false,
    allow_ad_personalization_signals: false
  });
})();
`;
}
