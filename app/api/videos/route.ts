import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videos, transcripts, annotations, scenes, keyMoments } from "@/lib/schema";
import { extractYouTubeId } from "@/lib/youtube";
import { eq, count } from "drizzle-orm";
import { auth } from "@/auth";
import { fetchTranscriptWithFallback } from "@/lib/transcript";

export async function GET() {
  const allVideos = await db.select().from(videos);

  const enriched = await Promise.all(
    allVideos.map(async (v) => {
      const annotationCount =
        (await db.select({ value: count() }).from(annotations).where(eq(annotations.videoId, v.id)))[0]?.value ?? 0;
      const sceneCount =
        (await db.select({ value: count() }).from(scenes).where(eq(scenes.videoId, v.id)))[0]?.value ?? 0;
      const momentCount =
        (await db.select({ value: count() }).from(keyMoments).where(eq(keyMoments.videoId, v.id)))[0]?.value ?? 0;
      const hasTranscript =
        (await db.select().from(transcripts).where(eq(transcripts.videoId, v.id)).limit(1)).length > 0;

      return { ...v, annotationCount, sceneCount, momentCount, hasTranscript };
    }),
  );

  return NextResponse.json(enriched);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  const body = await request.json();
  const { url } = body as { url: string };

  if (!url) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  const youtubeId = extractYouTubeId(url);
  if (!youtubeId) {
    return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
  }

  const existingRows = await db.select().from(videos).where(eq(videos.youtubeId, youtubeId)).limit(1);
  if (existingRows[0]) {
    return NextResponse.json(existingRows[0]);
  }

  let title: string | null = null;
  let thumbnailUrl: string | null = null;
  const durationSeconds: number | null = null;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`;
    const oembedRes = await fetch(oembedUrl);
    if (oembedRes.ok) {
      const oembedData = (await oembedRes.json()) as {
        title?: string;
        thumbnail_url?: string;
      };
      title = oembedData.title ?? null;
      thumbnailUrl = oembedData.thumbnail_url ?? null;
    }
  } catch {}

  const [video] = await db
    .insert(videos)
    .values({
      youtubeUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
      youtubeId,
      title,
      thumbnailUrl,
      durationSeconds,
      createdBy: session?.user?.name ?? "anonymous",
    })
    .returning();

  const transcript = await fetchTranscriptWithFallback(youtubeId);

  if (transcript && transcript.segments.length > 0) {
    await db.insert(transcripts).values({
      videoId: video.id,
      segments: JSON.stringify(transcript.segments),
      language: transcript.language,
      source: transcript.source,
    });
  }

  return NextResponse.json(video, { status: 201 });
}
