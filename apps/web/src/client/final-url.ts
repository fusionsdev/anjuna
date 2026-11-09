/** `hostnames[0]` is the apex when core returns an apex-first list; a core-only brand gets whatever core returned, so it is used as given. */
export function siteUrl(hostnames: readonly string[]): string | null {
  const host = hostnames[0];
  return host ? `https://${host}` : null;
}

/**
 * The `{keyword}` and `{campaignid}` placeholders stay literal: Google Ads substitutes them, and percent-encoding the
 * braces would break that. Core maps a campaign to its brand from `utm_campaign` on the clicks (T13 Part A1).
 */
export function finalUrl(hostnames: readonly string[]): string | null {
  const site = siteUrl(hostnames);
  return site ? `${site}/?keyword={keyword}&utm_campaign={campaignid}` : null;
}
