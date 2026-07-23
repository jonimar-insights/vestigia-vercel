import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { videos, transcripts, keyMoments } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { callAIWithUserKeys, checkAIProvider } from "@/lib/ai";
import { auth } from "@/auth";
import { getDecryptedSettings } from "@/lib/user-settings";
import { fetchTranscriptWithFallback } from "@/lib/transcript";

export const maxDuration = 300;

interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

interface SummarizedMoment {
  timestamp: number;
  endTimestamp: number;
  title: string;
  summary: string;
  importance: "high" | "medium" | "low";
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface TimeChunk {
  startSec: number;
  endSec: number;
  lines: string[];
}

function chunkByTime(segments: TranscriptSegment[], segmentDurationSec = 600): TimeChunk[] {
  if (segments.length === 0) return [];

  const totalDuration = segments[segments.length - 1].start + (segments[segments.length - 1].duration || 0);
  const chunks: TimeChunk[] = [];

  for (let startSec = 0; startSec < totalDuration; startSec += segmentDurationSec) {
    const endSec = Math.min(startSec + segmentDurationSec, totalDuration);
    const lines: string[] = [];

    for (const seg of segments) {
      if (seg.start + seg.duration > startSec && seg.start < endSec) {
        lines.push(`[${formatTimestamp(seg.start)}] ${seg.text}`);
      }
    }

    if (lines.length > 0) {
      chunks.push({ startSec, endSec, lines });
    }
  }

  return chunks;
}

function extractJsonFromResponse(text: string): Record<string, unknown> | null {
  let clean = text.trim();

  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    return JSON.parse(clean);
  } catch { /* continue */ }

  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(clean.slice(firstBrace, lastBrace + 1));
    } catch { /* continue */ }
  }

  const firstBracket = clean.indexOf("[");
  const lastBracket = clean.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return { moments: JSON.parse(clean.slice(firstBracket, lastBracket + 1)) };
    } catch { /* continue */ }
  }

  return null;
}

/** Save moments to DB and return the saved records */
async function saveMoments(
  videoId: number,
  moments: SummarizedMoment[],
  db: ReturnType<typeof getDb>,
) {
  const deduped: SummarizedMoment[] = [];
  const importanceOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  moments.sort((a, b) => a.timestamp - b.timestamp);

  for (const moment of moments) {
    const existingMoment = deduped.find(
      (d) => Math.abs(d.timestamp - moment.timestamp) < 10,
    );
    if (existingMoment) {
      if (importanceOrder[moment.importance] < importanceOrder[existingMoment.importance]) {
        Object.assign(existingMoment, moment);
      }
    } else {
      deduped.push(moment);
    }
  }

  const saved = [];
  for (const m of deduped) {
    const confidence = m.importance === "high" ? 1.0 : m.importance === "medium" ? 0.7 : 0.4;
    const [inserted] = await db
      .insert(keyMoments)
      .values({
        videoId,
        timestamp: m.timestamp,
        endTimestamp: m.endTimestamp,
        title: m.title,
        description: m.summary,
        source: "ai-summary",
        confidence,
      })
      .returning();
    saved.push({
      id: inserted.id,
      timestamp: inserted.timestamp,
      endTimestamp: inserted.endTimestamp,
      title: inserted.title,
      summary: inserted.description ?? "",
      importance: m.importance,
    });
  }

  return saved;
}

/** Fetch video metadata with fallback chain (YouTube API → oEmbed → page scrape) */
async function fetchVideoMetadataForSummary(
  youtubeId: string,
): Promise<{
  title: string;
  description: string;
  duration: number;
  channelTitle: string;
  category: string;
  tags: string[];
  viewCount: number;
} | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${youtubeId}&key=${apiKey}`,
      );
      const data = await res.json();
      const item = data.items?.[0];
      if (item) {
        const durationStr = item.contentDetails?.duration || "PT0S";
        const durationMatch = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        const hours = parseInt(durationMatch?.[1] || "0");
        const minutes = parseInt(durationMatch?.[2] || "0");
        const seconds = parseInt(durationMatch?.[3] || "0");
        return {
          title: item.snippet?.title || "",
          description: item.snippet?.description || "",
          duration: hours * 3600 + minutes * 60 + seconds,
          channelTitle: item.snippet?.channelTitle || "",
          category: item.snippet?.categoryId || "",
          tags: item.snippet?.tags || [],
          viewCount: parseInt(item.statistics?.viewCount || "0"),
        };
      }
    } catch {
      console.warn("YouTube Data API failed, trying fallback");
    }
  }

  // oEmbed fallback
  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`,
    );
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      return {
        title: oembed.title || "",
        description: oembed.author_name || "",
        duration: 600,
        channelTitle: oembed.author_name || "",
        category: "",
        tags: [],
        viewCount: 0,
      };
    }
  } catch {}

  // Page scrape fallback
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${youtubeId}`);
    const html = await pageRes.text();
    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(" - YouTube", "").trim() : "";
    const descMatch = html.match(/"shortDescription":"([\s\S]*?)"(?:,|})/);
    const description = descMatch
      ? descMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      : "";
    return { title, description, duration: 600, channelTitle: "", category: "", tags: [], viewCount: 0 };
  } catch {
    return null;
  }
}

const CATEGORY_MAP: Record<string, string> = {
  "1": "Film & Animation", "2": "Autos & Vehicles", "10": "Music",
  "15": "Pets & Animals", "17": "Sports", "18": "Short Movies",
  "19": "Travel & Events", "20": "Gaming", "21": "Videoblogging",
  "22": "People & Blogs", "23": "Comedy", "24": "Entertainment",
  "25": "News & Politics", "26": "Howto & Style", "27": "Education",
  "28": "Science & Technology", "29": "Nonprofits & Activism",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const saved = await db
    .select()
    .from(keyMoments)
    .where(and(eq(keyMoments.videoId, videoId), eq(keyMoments.source, "ai-summary")));

  const moments = saved.map((m) => ({
    id: m.id,
    timestamp: m.timestamp,
    endTimestamp: m.endTimestamp,
    title: m.title,
    summary: m.description ?? "",
    importance: m.confidence >= 0.9 ? "high" : m.confidence >= 0.6 ? "medium" : "low",
  }));

  return NextResponse.json({ moments });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await params;
  const videoId = parseInt(id);
  const body = await request.json().catch(() => ({}));
  const regenerate = body.regenerate === true;

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const health = await checkAIProvider();
  if (!health.available) {
    return NextResponse.json(
      { error: `No AI provider available. Set one of: GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY. ${health.error ?? ""}` },
      { status: 500 },
    );
  }

  const videoRows = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!videoRows[0]) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }
  const video = videoRows[0];

  const existing = await db
    .select()
    .from(keyMoments)
    .where(and(eq(keyMoments.videoId, videoId), eq(keyMoments.source, "ai-summary")));

  if (existing.length > 0 && !regenerate) {
    return NextResponse.json({
      moments: existing.map((m) => ({
        id: m.id,
        timestamp: m.timestamp,
        endTimestamp: m.endTimestamp,
        title: m.title,
        summary: m.description ?? "",
        importance: m.confidence >= 0.9 ? "high" : m.confidence >= 0.6 ? "medium" : "low",
      })),
      saved: true,
    });
  }

  if (regenerate && existing.length > 0) {
    await db.delete(keyMoments)
      .where(and(eq(keyMoments.videoId, videoId), eq(keyMoments.source, "ai-summary")));
  }

  // Get session for OAuth token and user keys
  const session = await auth();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessToken = (session as any)?.accessToken;

  let userKeys: Record<string, string> | undefined;
  let preferred: string | null = null;
  if (session?.user?.id) {
    const settings = await getDecryptedSettings(session.user.id);
    userKeys = Object.keys(settings.aiKeys).length > 0 ? settings.aiKeys : undefined;
    preferred = settings.preferredProvider ?? null;
  }

  // Try to get transcript: check DB first, then fetch
  const transcriptRows = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.videoId, videoId))
    .limit(1);

  let segments: TranscriptSegment[] = [];

  if (transcriptRows[0]) {
    segments = JSON.parse(transcriptRows[0].segments);
  } else {
    const fetched = await fetchTranscriptWithFallback(video.youtubeId, accessToken);
    if (fetched && fetched.segments.length > 0) {
      await db.insert(transcripts).values({
        videoId,
        segments: JSON.stringify(fetched.segments),
        language: fetched.language,
        source: fetched.source,
      });
      segments = fetched.segments;
    }
  }

  if (segments.length > 0) {
    // ── Path A: Transcript available → full timeline analysis ──
    const chunks = chunkByTime(segments);
    const allMoments: SummarizedMoment[] = [];
    const chunkErrors: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkText = chunk.lines.join("\n");
      const timeRange = `${formatTimestamp(chunk.startSec)} - ${formatTimestamp(chunk.endSec)}`;
      const chunkLabel = chunks.length > 1 ? ` (segment ${i + 1}/${chunks.length}: ${timeRange})` : "";

      try {
        const result = await callAIWithUserKeys({
          messages: [
            {
              role: "system",
              content: "You are a video analysis assistant. Respond with JSON only, no markdown, no code blocks, no thinking.",
            },
            {
              role: "user",
              content: `Analyze this video transcript segment${chunkLabel} covering ${timeRange}.

CRITICAL: Spread moments EVENLY across the ENTIRE time range from ${formatTimestamp(chunk.startSec)} to ${formatTimestamp(chunk.endSec)}. Do not cluster moments at one point.

Transcript:
${chunkText}

Respond with JSON only:
{
  "moments": [
    {
      "timestamp": 123.4,
      "endTimestamp": 185.2,
      "title": "Short title (3-6 words)",
      "summary": "1-2 sentence summary",
      "importance": "high"
    }
  ]
}

Rules:
- Return 3-8 moments, SPREAD EVENLY from ${chunk.startSec} to ${chunk.endSec}
- timestamp and endTimestamp MUST be between ${chunk.startSec} and ${chunk.endSec}
- endTimestamp must be greater than timestamp
- importance: "high", "medium", or "low"`,
            },
          ],
          temperature: 0.3,
          maxTokens: 4096,
        }, userKeys, preferred);

        console.log(`Chunk ${i + 1}: served by ${result.provider}`);

        if (!result.text.trim()) {
          chunkErrors.push(`Chunk ${i + 1}: Empty response`);
          continue;
        }

        const parsed = extractJsonFromResponse(result.text) as { moments?: SummarizedMoment[] } | null;
        if (!parsed || !Array.isArray(parsed.moments)) {
          chunkErrors.push(`Chunk ${i + 1}: Unparseable response`);
          continue;
        }

        let accepted = 0;
        for (const m of parsed.moments) {
          if (typeof m.timestamp !== "number" || typeof m.endTimestamp !== "number") continue;
          if (m.timestamp < chunk.startSec || m.timestamp >= chunk.endSec) continue;
          if (m.endTimestamp <= m.timestamp) continue;
          if (m.endTimestamp > chunk.endSec + 30) continue;

          m.endTimestamp = Math.min(m.endTimestamp, chunk.endSec);

          if (!m.title || typeof m.title !== "string") continue;
          m.title = m.title.trim().slice(0, 100);
          m.summary = (typeof m.summary === "string" ? m.summary : "").trim().slice(0, 500);
          m.importance = (["high", "medium", "low"].includes(m.importance) ? m.importance : "medium") as "high" | "medium" | "low";

          allMoments.push(m);
          accepted++;
        }
        console.log(`Chunk ${i + 1}/${chunks.length}: accepted ${accepted}/${parsed.moments.length} moments`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Failed to summarize chunk ${i}:`, msg);
        chunkErrors.push(`Chunk ${i + 1}: ${msg.slice(0, 120)}`);
      }

      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (allMoments.length === 0 && chunkErrors.length > 0) {
      return NextResponse.json(
        { error: "Summarization failed for all segments", details: chunkErrors },
        { status: 500 },
      );
    }

    const saved = await saveMoments(videoId, allMoments, db);

    return NextResponse.json({
      moments: saved,
      videoTitle: video.title,
      totalSegments: segments.length,
      totalChunks: chunks.length,
      totalMomentsGenerated: allMoments.length,
      totalMomentsAfterDedup: saved.length,
      saved: true,
    });
  }

  // ── Path B: No transcript → infer key moments from video metadata ──
  console.log("No transcript available, inferring key moments from video metadata");
  const metadata = await fetchVideoMetadataForSummary(video.youtubeId);
  if (!metadata) {
    return NextResponse.json(
      { error: "No transcript or video metadata available to summarize" },
      { status: 404 },
    );
  }

  const descPreview = metadata.description.length > 3000
    ? metadata.description.slice(0, 3000) + "..."
    : metadata.description;

  const categoryName = CATEGORY_MAP[metadata.category] || (metadata.category ? "Unknown" : "Unknown");
  const tagStr = metadata.tags.length > 0
    ? metadata.tags.slice(0, 15).join(", ")
    : "none";

  const durationMin = Math.floor(metadata.duration / 60);

  const prompt = `You are an expert video analyst. Infer the key moments of this YouTube video from its metadata.

VIDEO METADATA:
- Title: "${metadata.title}"
- Channel: "${metadata.channelTitle}"
- Category: ${categoryName}
- Tags: ${tagStr}
- Duration: ${durationMin} minutes (${metadata.duration} seconds)
- Views: ${metadata.viewCount.toLocaleString()}

VIDEO DESCRIPTION:
${descPreview}

INSTRUCTIONS:
1. Analyze the title, channel, category, tags, and description to infer the video's likely structure.
2. Identify 5-10 key moments that would likely appear in this type of video.
3. For each moment, provide:
   - timestamp: approximate start time in SECONDS (spread evenly across ${metadata.duration}s)
   - endTimestamp: end time in SECONDS (must be after timestamp)
   - title: concise descriptive title (max 60 chars)
   - summary: 1-2 sentences on what is discussed
   - importance: "high", "medium", or "low"
4. Spread moments across the full duration. Do not cluster them.
5. These are educated guesses — be conservative with timestamps.

Return ONLY a JSON array. No other text. Example:
[{"timestamp":0,"endTimestamp":60,"title":"Introduction","summary":"Opening remarks and overview","importance":"high"}]`;

  try {
    const result = await callAIWithUserKeys({
      messages: [
        {
          role: "system",
          content: "You are a precise video content analyst. Always return valid JSON arrays. Never include markdown code fences or explanatory text outside the JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      maxTokens: 4000,
    }, userKeys, preferred);

    const text = result.text;
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Could not parse AI response" }, { status: 500 });
    }

    let parsed: SummarizedMoment[] = [];
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      const fixed = jsonMatch[0].replace(/,\s*]/g, "]").replace(/,\s*}/g, "}");
      parsed = JSON.parse(fixed);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return NextResponse.json({ error: "No key moments could be inferred" }, { status: 500 });
    }

    const validMoments: SummarizedMoment[] = [];
    for (const m of parsed) {
      if (typeof m.timestamp !== "number" || typeof m.endTimestamp !== "number") continue;
      if (m.timestamp < 0 || m.timestamp >= metadata.duration) continue;
      if (m.endTimestamp <= m.timestamp) continue;
      if (!m.title || typeof m.title !== "string") continue;
      m.title = m.title.trim().slice(0, 100);
      m.summary = (typeof m.summary === "string" ? m.summary : "").trim().slice(0, 500);
      m.importance = (["high", "medium", "low"].includes(m.importance) ? m.importance : "medium") as "high" | "medium" | "low";
      validMoments.push(m);
    }

    if (validMoments.length === 0) {
      return NextResponse.json({ error: "No valid key moments could be inferred from metadata" }, { status: 500 });
    }

    const saved = await saveMoments(videoId, validMoments, db);

    return NextResponse.json({
      moments: saved,
      videoTitle: video.title,
      totalSegments: 0,
      totalChunks: 0,
      totalMomentsGenerated: validMoments.length,
      totalMomentsAfterDedup: saved.length,
      saved: true,
      source: "metadata-inference",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `AI summary failed: ${msg}` }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  await db.delete(keyMoments)
    .where(and(eq(keyMoments.videoId, videoId), eq(keyMoments.source, "ai-summary")));

  return NextResponse.json({ success: true });
}