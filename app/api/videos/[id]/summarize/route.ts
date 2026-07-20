import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videos, transcripts, keyMoments } from "@/lib/schema";
import { eq, and } from "drizzle-orm";

export const maxDuration = 300;

const GROQ_URL = "https://api.groq.com/openai/v1";
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = "llama-3.3-70b-versatile";

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

  // Strip markdown code fences
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Try direct parse
  try {
    return JSON.parse(clean);
  } catch { /* continue */ }

  // Try to find JSON object in the text
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(clean.slice(firstBrace, lastBrace + 1));
    } catch { /* continue */ }
  }

  // Try to find JSON array
  const firstBracket = clean.indexOf("[");
  const lastBracket = clean.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return { moments: JSON.parse(clean.slice(firstBracket, lastBracket + 1)) };
    } catch { /* continue */ }
  }

  return null;
}

function parseStreamResponse(raw: string): string {
  // Try non-streaming first (JSON object)
  try {
    const obj = JSON.parse(raw);
    return obj.choices?.[0]?.message?.content ?? "";
  } catch { /* not JSON, try SSE */ }

  // Try SSE stream
  const lines = raw.split("\n");
  let fullContent = "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") break;
    try {
      const chunk = JSON.parse(data);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) fullContent += delta;
    } catch { /* skip malformed chunk */ }
  }
  return fullContent;
}

// GET - load saved summaries
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

// POST - generate and save summaries
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseInt(id);
  const body = await request.json().catch(() => ({}));
  const regenerate = body.regenerate === true;

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  if (!GROQ_KEY) {
    return NextResponse.json({ error: "GROQ_API_KEY not configured" }, { status: 500 });
  }

  // Test Groq connection
  try {
    const testRes = await fetch(`${GROQ_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        stream: false,
        messages: [{ role: "user", content: "Say OK" }],
        max_tokens: 5,
      }),
    });
    if (!testRes.ok) {
      const errText = await testRes.text();
      let msg = errText;
      try { const parsed = JSON.parse(errText); msg = parsed?.error?.message ?? errText; } catch { /* not JSON */ }
      if (testRes.status === 429 || msg.includes("rate_limit") || msg.includes("tokens per day")) {
        return NextResponse.json(
          { error: "Groq daily token limit reached. Try again tomorrow or use a different API key." },
          { status: 429 },
        );
      }
      return NextResponse.json({ error: `Groq unavailable: ${msg.slice(0, 200)}` }, { status: 500 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Groq not reachable: ${msg.slice(0, 200)}` }, { status: 500 });
  }

  const videoRows = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!videoRows[0]) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }
  const video = videoRows[0];

  // Check for existing saved summary
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

  // If regenerating, delete old ones
  if (regenerate && existing.length > 0) {
    await db.delete(keyMoments)
      .where(and(eq(keyMoments.videoId, videoId), eq(keyMoments.source, "ai-summary")));
  }

  const transcriptRows = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.videoId, videoId))
    .limit(1);
  const transcript = transcriptRows[0] ?? null;

  if (!transcript) {
    return NextResponse.json({ error: "No transcript available. Extract transcript first." }, { status: 404 });
  }

  const segments: TranscriptSegment[] = JSON.parse(transcript.segments);
  if (segments.length === 0) {
    return NextResponse.json({ error: "Transcript is empty" }, { status: 404 });
  }

  const chunks = chunkByTime(segments);
  const allMoments: SummarizedMoment[] = [];
  const chunkErrors: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkText = chunk.lines.join("\n");
    const timeRange = `${formatTimestamp(chunk.startSec)} - ${formatTimestamp(chunk.endSec)}`;
    const chunkLabel = chunks.length > 1 ? ` (segment ${i + 1}/${chunks.length}: ${timeRange})` : "";

    try {
      let text = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${GROQ_URL}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${GROQ_KEY}`,
            },
            body: JSON.stringify({
              model: GROQ_MODEL,
              stream: false,
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
              max_tokens: 4096,
            }),
          });

          if (!res.ok) {
            const errBody = await res.text();
            // Detect rate limit
            if (res.status === 429 || errBody.includes("rate_limit") || errBody.includes("tokens per day")) {
              const wait = (attempt + 1) * 10000;
              console.warn(`Rate limited on chunk ${i}, attempt ${attempt + 1}, waiting ${wait}ms...`);
              await new Promise((r) => setTimeout(r, wait));
              continue;
            }
            throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
          }

          const raw = await res.text();
          text = parseStreamResponse(raw);
          if (!text.trim()) {
            console.warn(`Empty response on chunk ${i}, attempt ${attempt + 1}`);
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          break;
        } catch (rateErr: unknown) {
          const msg = rateErr instanceof Error ? rateErr.message : "";
          if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("rate") || msg.includes("503")) {
            const wait = (attempt + 1) * 10000;
            console.warn(`Rate limited on chunk ${i}, retrying in ${wait}ms...`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw rateErr;
        }
      }

      if (!text.trim()) {
        chunkErrors.push(`Chunk ${i + 1}: Empty response after retries`);
        continue;
      }

      try {
        const parsed = extractJsonFromResponse(text) as { moments?: SummarizedMoment[] } | null;
        if (!parsed || !Array.isArray(parsed.moments)) {
          console.warn(`Chunk ${i + 1}: Could not parse moments from response`);
          chunkErrors.push(`Chunk ${i + 1}: Unparseable response`);
          continue;
        }

        let accepted = 0;
        for (const m of parsed.moments) {
          if (typeof m.timestamp !== "number" || typeof m.endTimestamp !== "number") continue;

          // Reject moments outside chunk range instead of clamping
          if (m.timestamp < chunk.startSec || m.timestamp >= chunk.endSec) continue;
          if (m.endTimestamp <= m.timestamp) continue;
          if (m.endTimestamp > chunk.endSec + 30) continue; // allow small overshoot

          // Clamp endTimestamp to chunk range if slightly over
          m.endTimestamp = Math.min(m.endTimestamp, chunk.endSec);

          if (!m.title || typeof m.title !== "string") continue;
          m.title = m.title.trim().slice(0, 100);
          m.summary = (typeof m.summary === "string" ? m.summary : "").trim().slice(0, 500);
          m.importance = (["high", "medium", "low"].includes(m.importance) ? m.importance : "medium") as "high" | "medium" | "low";

          allMoments.push(m);
          accepted++;
        }
        console.log(`Chunk ${i + 1}/${chunks.length}: accepted ${accepted}/${parsed.moments.length} moments`);
      } catch {
        chunkErrors.push(`Chunk ${i + 1}: Failed to parse JSON response`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to summarize chunk ${i}:`, msg);
      chunkErrors.push(`Chunk ${i + 1}: ${msg.slice(0, 120)}`);
    }

    // Delay between chunks to respect rate limits
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // If every single chunk failed, return the errors
  if (allMoments.length === 0 && chunkErrors.length > 0) {
    return NextResponse.json(
      { error: "Summarization failed for all segments", details: chunkErrors },
      { status: 500 },
    );
  }

  // Deduplicate by timestamp (within 10s), keep highest importance
  const deduped: SummarizedMoment[] = [];
  const importanceOrder = { high: 0, medium: 1, low: 2 };
  allMoments.sort((a, b) => a.timestamp - b.timestamp);

  for (const moment of allMoments) {
    const existingMoment = deduped.find(
      (d) => Math.abs(d.timestamp - moment.timestamp) < 10,
    );
    if (existingMoment) {
      if (
        importanceOrder[moment.importance] < importanceOrder[existingMoment.importance]
      ) {
        Object.assign(existingMoment, moment);
      }
    } else {
      deduped.push(moment);
    }
  }

  deduped.sort((a, b) => a.timestamp - b.timestamp);

  // Save to key_moments table
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

  return NextResponse.json({
    moments: saved,
    videoTitle: video.title,
    totalSegments: segments.length,
    totalChunks: chunks.length,
    totalMomentsGenerated: allMoments.length,
    totalMomentsAfterDedup: deduped.length,
    saved: true,
  });
}

// DELETE - clear saved summaries
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  await db.delete(keyMoments)
    .where(and(eq(keyMoments.videoId, videoId), eq(keyMoments.source, "ai-summary")));

  return NextResponse.json({ success: true });
}
