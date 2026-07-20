import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { transcripts } from "@/lib/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const body = await request.json();
  const { segments, language = "en", source = "manual" } = body as {
    segments: { start: number; duration: number; text: string }[];
    language?: string;
    source?: string;
  };

  if (!segments?.length) {
    return NextResponse.json({ error: "segments array is required" }, { status: 400 });
  }

  const existing = await db.select().from(transcripts).where(eq(transcripts.videoId, videoId)).limit(1);

  if (existing[0]) {
    await db.update(transcripts).set({
      segments: JSON.stringify(segments),
      language,
      source,
    }).where(eq(transcripts.videoId, videoId));
  } else {
    await db.insert(transcripts).values({
      videoId,
      segments: JSON.stringify(segments),
      language,
      source,
    });
  }

  return NextResponse.json({ ok: true, segmentCount: segments.length, source });
}
