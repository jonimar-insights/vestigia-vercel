import { NextResponse } from "next/server";

export const runtime = "nodejs";

const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_CLIENT_VERSION = "20.10.38";
const INNERTUBE_CONTEXT = {
  client: { clientName: "ANDROID", clientVersion: INNERTUBE_CLIENT_VERSION },
};
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;

export async function GET() {
  const youtubeId = "GtOGurrUPmQ";
  const results: Record<string, unknown> = {};

  // Test 1: InnerTube API
  try {
    const resp = await fetch(INNERTUBE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": INNERTUBE_USER_AGENT },
      body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId: youtubeId }),
    });
    results.innertube = { status: resp.status, ok: resp.ok };
    if (resp.ok) {
      const data = await resp.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      results.captionTracks = Array.isArray(tracks) ? tracks.length : 0;
      if (tracks?.[0]?.baseUrl) {
        const trackResp = await fetch(tracks[0].baseUrl);
        results.trackFetch = { status: trackResp.status, ok: trackResp.ok };
        if (trackResp.ok) {
          const xml = await trackResp.text();
          results.xmlLength = xml.length;
          results.xmlSample = xml.slice(0, 300);
        }
      }
    } else {
      results.innertubeBody = await resp.text();
    }
  } catch (e: unknown) {
    results.innertube = { error: e instanceof Error ? e.message : String(e) };
  }

  // Test 2: library
  try {
    const { fetchTranscript } = await import("youtube-transcript");
    const r = await fetchTranscript(youtubeId);
    results.library = { ok: true, segments: r.length };
  } catch (e: unknown) {
    results.library = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(results);
}
