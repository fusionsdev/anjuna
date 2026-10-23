/** `hostnames[0]` is the apex when core returns an apex-first list; a core-only brand gets whatever core returned, so it is used as given. */
export function siteUrl(hostnames: readonly string[]): string | null {
  const host = hostnames[0];
  return host ? `https://${host}` : null;
}

/** The `{keyword}` placeholder stays literal: Google Ads substitutes it, and percent-encoding the braces would break that. */
export function finalUrl(hostnames: readonly string[]): string | null {
  const site = siteUrl(hostnames);
  return site ? `${site}/?keyword={keyword}` : null;
}
