import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videos, transcripts, annotations, scenes, keyMoments } from "@/lib/schema";
import { eq } from "drizzle-orm";

export async function GET(
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

  const transcriptRows = await db.select().from(transcripts).where(eq(transcripts.videoId, videoId)).limit(1);
  const transcript = transcriptRows[0] ?? null;

  const videoAnnotations = await db.select().from(annotations).where(eq(annotations.videoId, videoId));
  const videoScenes = await db.select().from(scenes).where(eq(scenes.videoId, videoId));
  const videoKeyMoments = await db.select().from(keyMoments).where(eq(keyMoments.videoId, videoId));

  return NextResponse.json({
    ...video,
    transcript: transcript
      ? { ...transcript, segments: JSON.parse(transcript.segments) }
      : null,
    annotations: videoAnnotations.map((a) => ({
      ...a,
      tags: a.tags ? JSON.parse(a.tags) : [],
    })),
    scenes: videoScenes.map((s) => ({
      ...s,
      aiTags: s.aiTags ? JSON.parse(s.aiTags) : [],
    })),
    keyMoments: videoKeyMoments,
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  await db.delete(annotations).where(eq(annotations.videoId, videoId));
  await db.delete(keyMoments).where(eq(keyMoments.videoId, videoId));
  await db.delete(scenes).where(eq(scenes.videoId, videoId));
  await db.delete(transcripts).where(eq(transcripts.videoId, videoId));
  await db.delete(videos).where(eq(videos.id, videoId));

  return NextResponse.json({ success: true });
}
