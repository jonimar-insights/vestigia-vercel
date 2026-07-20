import { NextResponse } from "next/server";

export const runtime = "nodejs";

const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

export async function GET() {
  const results: Record<string, unknown> = {};

  // Test raw HTML for MIT video
  try {
    const resp = await fetch("https://www.youtube.com/watch?v=GtOGurrUPmQ", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36" },
    });
    const html = await resp.text();
    results.htmlLength = html.length;
    results.hasPlayabilityStatus = html.includes('"playabilityStatus":');
    results.hasYtInitial = html.includes("var ytInitialPlayerResponse = ");
    results.hasRecaptcha = html.includes('class="g-recaptcha"');
    // Check if captionTracks exist anywhere
    const captionIdx = html.indexOf("captionTracks");
    results.captionTracksInHtml = captionIdx !== -1;
    if (captionIdx !== -1) {
      results.captionContext = html.slice(Math.max(0, captionIdx - 50), captionIdx + 200);
    }
    // Check for consent/bot detection
    results.hasConsent = html.includes("consent") || html.includes("CONSENT");
    results.hasBeforeContent = html.includes("beforeContent");
    // Sample the ytInitialPlayerResponse
    const startToken = "var ytInitialPlayerResponse = ";
    const startIdx = html.indexOf(startToken);
    if (startIdx !== -1) {
      const jsonStart = startIdx + startToken.length;
      let depth = 0;
      for (let i = jsonStart; i < html.length && i < jsonStart + 50000; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") { depth--; if (depth === 0) { try { const obj = JSON.parse(html.slice(jsonStart, i + 1)); results.playabilityStatus = obj?.playabilityStatus?.status; results.hasCaptions = !!obj?.captions; } catch {} break; } }
      }
    }
  } catch (e: unknown) {
    results.htmlError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json(results);
}
