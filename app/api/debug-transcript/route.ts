import { NextResponse } from "next/server";

export const runtime = "nodejs";

const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

export async function GET() {
  const results: Record<string, unknown> = {};

  const testIds = ["GtOGurrUPmQ", "dQw4w9WgXcQ", "jNQXAC9IVRw"];

  for (const youtubeId of testIds) {
    try {
      const resp = await fetch(INNERTUBE_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion: "2.20241001.00.00" } },
          videoId: youtubeId,
        }),
      });
      const data = await resp.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      const trackCount = Array.isArray(tracks) ? tracks.length : 0;
      results[youtubeId] = { trackCount, firstLang: tracks?.[0]?.languageCode ?? null };
    } catch (e: unknown) {
      results[youtubeId] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Test all with library
  const { fetchTranscript } = await import("youtube-transcript");
  for (const youtubeId of testIds) {
    try {
      const r = await fetchTranscript(youtubeId);
      results[`lib_${youtubeId}`] = { ok: true, segments: r.length, sample: r[0]?.text };
    } catch (e: unknown) {
      results[`lib_${youtubeId}`] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const pkg = await import("youtube-transcript/package.json", { with: { type: "json" } }).catch(() => null);
  results.libVersion = pkg?.default?.version ?? "unknown";

  return NextResponse.json(results);
}
