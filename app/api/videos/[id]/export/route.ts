import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { annotations, videos } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { formatTimestamp } from "@/lib/youtube";

export async function GET(
  request: NextRequest,
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

  const videoAnnotations = await db
    .select()
    .from(annotations)
    .where(eq(annotations.videoId, videoId))
    .orderBy(annotations.timestampStart);

  const format = request.nextUrl.searchParams.get("format") ?? "chapters";

  let output: string;
  switch (format) {
    case "json":
      output = JSON.stringify(
        videoAnnotations.map((a) => ({
          timestamp: formatTimestamp(a.timestampStart),
          timestampStart: a.timestampStart,
          label: a.label,
          tags: a.tags,
          note: a.note,
        })),
        null,
        2,
      );
      break;
    case "timestamps":
      output = videoAnnotations
        .map((a) => `${formatTimestamp(a.timestampStart)} - ${a.label}`)
        .join("\n");
      break;
    case "chapters":
    default:
      output = videoAnnotations
        .map((a) => `${formatTimestamp(a.timestampStart)} ${a.label}`)
        .join("\n");
      break;
  }

  return NextResponse.json({
    videoId: video.youtubeId,
    title: video.title,
    output,
    annotationCount: videoAnnotations.length,
  });
}
