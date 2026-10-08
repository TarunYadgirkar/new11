'use strict';

// A compact built-in list of well-known third-party tracking & ad domains.
// Requests to these (or their subdomains) are blocked unless they are first-party
// for the page, the request is a top-level navigation, or the user lowered the
// shield for that site. Kept deliberately conservative to avoid breaking sites.
const TRACKER_DOMAINS = [
  // Ads / ad-tech
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'adnxs.com', 'adsrvr.org', 'advertising.com', 'adform.net', 'criteo.com', 'criteo.net',
  'casalemedia.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'taboola.com',
  'outbrain.com', 'moatads.com', 'amazon-adsystem.com', 'media.net', 'smartadserver.com',
  'yieldmo.com', 'sharethrough.com', 'triplelift.com', '3lift.com', 'indexww.com',
  'bidswitch.net', 'contextweb.com', 'sovrn.com', 'lijit.com', 'teads.tv', 'zemanta.com',
  'adroll.com', 'quantserve.com', 'quantcount.com', 'bluekai.com', 'demdex.net',
  'krxd.net', 'exelator.com', 'rlcdn.com', 'tapad.com', 'agkn.com', 'mathtag.com',
  'serving-sys.com', 'eyeota.net', 'adsafeprotected.com', 'doubleverify.com',
  'zedo.com', 'revcontent.com', 'mgid.com', 'popads.net', 'propellerads.com',
  // Analytics / fingerprinting / session replay
  'google-analytics.com', 'analytics.google.com', 'scorecardresearch.com', 'chartbeat.com',
  'chartbeat.net', 'hotjar.com', 'hotjar.io', 'mouseflow.com', 'fullstory.com',
  'crazyegg.com', 'luckyorange.com', 'clarity.ms', 'newrelic.com', 'nr-data.net',
  'mixpanel.com', 'segment.io', 'heap.io', 'heapanalytics.com', 'kissmetrics.com',
  'quantummetric.com', 'contentsquare.net', 'decibelinsight.net', 'inspectlet.com',
  'smartlook.com', 'logrocket.io', 'mxpnl.com', 'statcounter.com', 'parsely.com',
  'omtrdc.net', '2o7.net', 'everesttech.net', 'branch.io', 'app.link', 'adjust.com',
  'appsflyer.com', 'kochava.com', 'fingerprint.com', 'fpjs.io',
  // Social tracking pixels
  'pixel.facebook.com', 'analytics.twitter.com', 'ads-twitter.com',
  'static.ads-twitter.com', 'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com',
  'analytics.tiktok.com', 'ads.tiktok.com', 'ct.pinterest.com', 'tr.snapchat.com',
  'sc-static.net', 'bat.bing.com', 'ads.reddit.com', 'alb.reddit.com',
];

const SET = new Set(TRACKER_DOMAINS);

/** Returns the listed tracker domain matching `host`, or null. */
function trackerFor(host) {
  if (!host) return null;
  let h = host.toLowerCase();
  // Walk up the labels: a.b.doubleclick.net -> b.doubleclick.net -> doubleclick.net
  for (;;) {
    if (SET.has(h)) return h;
    const dot = h.indexOf('.');
    if (dot < 0) return null;
    h = h.slice(dot + 1);
    if (!h.includes('.')) return null;
  }
}

/** Last two labels — good enough to tell "same site" for our first-party exemption. */
function roughSite(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  // Handle common two-part public suffixes (co.uk, com.au …).
  const sl = parts[parts.length - 2];
  const twoPart = ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu'].includes(sl) && parts[parts.length - 1].length === 2;
  return parts.slice(twoPart ? -3 : -2).join('.');
}

function shouldBlock(requestHost, pageHost) {
  const t = trackerFor(requestHost);
  if (!t) return false;
  if (pageHost && roughSite(requestHost) === roughSite(pageHost)) return false;
  return true;
}

module.exports = { TRACKER_DOMAINS, trackerFor, shouldBlock, roughSite };
