import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videos, transcripts } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { fetchTranscriptWithFallback } from "@/lib/transcript";

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

  const existingRows = await db.select().from(transcripts).where(eq(transcripts.videoId, videoId)).limit(1);
  if (existingRows[0]) {
    return NextResponse.json({
      message: "Transcript already exists",
      source: existingRows[0].source,
    });
  }

  const transcript = await fetchTranscriptWithFallback(videoRows[0].youtubeId);

  if (!transcript || transcript.segments.length === 0) {
    return NextResponse.json(
      { error: "No transcript available for this video" },
      { status: 404 },
    );
  }

  await db.insert(transcripts).values({
    videoId,
    segments: JSON.stringify(transcript.segments),
    language: transcript.language,
    source: transcript.source,
  });

  return NextResponse.json({
    source: transcript.source,
    segmentCount: transcript.segments.length,
  });
}
