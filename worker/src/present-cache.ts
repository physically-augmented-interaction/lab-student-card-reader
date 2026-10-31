export const PRESENT_CACHE_TAG = "attendance-present";
export const PRESENT_CACHE_TTL_SECONDS = 60;

export function presentCacheHeaders(cutoff: Date, now: Date): Record<string, string> {
  // The session changes at 02:00 JST, even when no scan is recorded.
  const nextCutoff = cutoff.getTime() + 24 * 60 * 60 * 1000;
  const ttl = Math.min(PRESENT_CACHE_TTL_SECONDS, Math.floor((nextCutoff - now.getTime()) / 1000));
  if (ttl <= 0) return { "cache-control": "no-store" };
  return {
    // Keep browser/device caches fresh; only the shared Worker cache reuses this.
    "cache-control": `public, max-age=0, s-maxage=${ttl}, must-revalidate`,
    "cache-tag": PRESENT_CACHE_TAG,
    "expires": new Date(now.getTime() + ttl * 1000).toUTCString(),
  };
}

type PresentCache = {
  purge(options: { tags: string[] }): Promise<{ success: boolean; errors: unknown[] }>;
};

export async function invalidatePresentAfter(
  response: Response,
  cache: PresentCache | undefined,
): Promise<Response> {
  if (!response.ok || !cache) return response;
  try {
    const result = await cache.purge({ tags: [PRESENT_CACHE_TAG] });
    if (!result.success) console.error("present cache purge failed", result.errors);
  } catch (error) {
    // A committed scan must still succeed: retrying it would toggle attendance again.
    // If purge fails, the cached list expires within 60 seconds.
    console.error("present cache purge failed", error);
  }
  return response;
}
