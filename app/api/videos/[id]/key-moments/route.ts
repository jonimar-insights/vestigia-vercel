import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { videos, keyMoments, transcripts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import {
  extractYouTubeChapters,
  extractTranscriptKeyMoments,
  extractAIKeyMoments,
} from "@/lib/key-moments";
import { fetchTranscriptWithFallback } from "@/lib/transcript";
import { auth } from "@/auth";
import { getDecryptedSettings } from "@/lib/user-settings";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const videoRows = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!videoRows[0]) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }
  const video = videoRows[0];

  const existing = await db
    .select()
    .from(keyMoments)
    .where(eq(keyMoments.videoId, videoId));
  if (existing.length > 0) {
    return NextResponse.json({
      message: "Key moments already extracted",
      moments: existing,
    });
  }

  const allMoments = [];

  const chapters = await extractYouTubeChapters(video.youtubeId);
  for (const ch of chapters) {
    const [inserted] = await db
      .insert(keyMoments)
      .values({
        videoId,
        timestamp: ch.timestamp,
        title: ch.title,
        description: ch.description,
        source: "chapter",
        confidence: ch.confidence,
      })
      .returning();
    allMoments.push(inserted);
  }

  // Get session early for YouTube API access
  const session = await auth();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessToken = (session as any)?.accessToken;

  const existingTranscript = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.videoId, videoId))
    .limit(1);

  let transcriptSegments: { start: number; duration: number; text: string }[] = [];

  if (existingTranscript[0]) {
    transcriptSegments = JSON.parse(existingTranscript[0].segments);
  } else {
    const fetched = await fetchTranscriptWithFallback(video.youtubeId, accessToken);
    if (fetched) {
      await db.insert(transcripts).values({
        videoId,
        segments: JSON.stringify(fetched.segments),
        language: fetched.language,
        source: fetched.source,
      });
      transcriptSegments = fetched.segments;
    }
  }

  if (transcriptSegments.length > 0) {
    const transcriptMoments = await extractTranscriptKeyMoments(video.youtubeId, transcriptSegments);
    for (const tm of transcriptMoments) {
      const tooClose = allMoments.some(
        (m) => Math.abs(m.timestamp - tm.timestamp) < 3,
      );
      if (!tooClose) {
        const [inserted] = await db
          .insert(keyMoments)
          .values({
            videoId,
            timestamp: tm.timestamp,
            title: tm.title,
            description: tm.description,
            source: "transcript",
            confidence: tm.confidence,
          })
          .returning();
        allMoments.push(inserted);
      }
    }
  }

  // Always attempt AI extraction to enrich results with AI-identified key moments
  let userKeys: Record<string, string> | undefined;
  let preferred: string | null = null;
  if (session?.user?.id) {
    const settings = await getDecryptedSettings(session.user.id);
    userKeys = Object.keys(settings.aiKeys).length > 0 ? settings.aiKeys : undefined;
    preferred = settings.preferredProvider ?? null;
  }

  const aiMoments = await extractAIKeyMoments(video.youtubeId, transcriptSegments, userKeys, preferred);
  for (const am of aiMoments) {
    const tooClose = allMoments.some(
      (m) => Math.abs(m.timestamp - am.timestamp) < 3,
    );
    if (!tooClose) {
      const [inserted] = await db
        .insert(keyMoments)
        .values({
          videoId,
          timestamp: am.timestamp,
          title: am.title,
          description: am.description,
          source: "ai",
          confidence: am.confidence,
        })
        .returning();
      allMoments.push(inserted);
    }
  }

  allMoments.sort((a, b) => a.timestamp - b.timestamp);

  return NextResponse.json({
    message: `Extracted ${allMoments.length} key moments`,
    moments: allMoments,
    sources: {
      chapters: chapters.length,
      transcript: allMoments.filter((m) => m.source === "transcript").length,
      ai: allMoments.filter((m) => m.source === "ai").length,
    },
    transcriptStored: transcriptSegments.length > 0 && existingTranscript.length === 0,
  });
}

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

  const moments = await db
    .select()
    .from(keyMoments)
    .where(eq(keyMoments.videoId, videoId));

  return NextResponse.json(moments);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const { source } = body as { source?: string };

  if (source) {
    await db.delete(keyMoments)
      .where(
        and(eq(keyMoments.videoId, videoId), eq(keyMoments.source, source)),
      );
  } else {
    await db.delete(keyMoments).where(eq(keyMoments.videoId, videoId));
  }

  return NextResponse.json({ success: true });
}
