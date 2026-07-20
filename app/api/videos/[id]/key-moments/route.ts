import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videos, keyMoments } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import {
  extractYouTubeChapters,
  extractTranscriptKeyMoments,
} from "@/lib/key-moments";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  // 1. Extract YouTube chapters
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

  // 2. Extract transcript key moments
  const transcriptMoments = await extractTranscriptKeyMoments(video.youtubeId);
  for (const tm of transcriptMoments) {
    // Avoid duplicates with chapters (within 3s)
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

  allMoments.sort((a, b) => a.timestamp - b.timestamp);

  return NextResponse.json({
    message: `Extracted ${allMoments.length} key moments`,
    moments: allMoments,
    sources: {
      chapters: chapters.length,
      transcript: allMoments.filter((m) => m.source === "transcript").length,
    },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
