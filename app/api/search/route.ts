import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videos, annotations, scenes, keyMoments } from "@/lib/schema";
import { like, or, eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const pattern = `%${q}%`;

  const matchedAnnotations = await db
    .select({
      type: annotations.id,
      kind: annotations.id,
      videoId: annotations.videoId,
      timestamp: annotations.timestampStart,
      endTimestamp: annotations.timestampEnd,
      title: annotations.label,
      detail: annotations.note,
      tags: annotations.tags,
    })
    .from(annotations)
    .where(
      or(
        like(annotations.label, pattern),
        like(annotations.note, pattern),
        like(annotations.tags, pattern),
      ),
    );

  const matchedScenes = await db
    .select({
      videoId: scenes.videoId,
      timestamp: scenes.timestamp,
      title: scenes.aiDescription,
      detail: scenes.aiTags,
    })
    .from(scenes)
    .where(
      or(
        like(scenes.aiDescription, pattern),
        like(scenes.aiTags, pattern),
      ),
    );

  const matchedMoments = await db
    .select({
      videoId: keyMoments.videoId,
      timestamp: keyMoments.timestamp,
      title: keyMoments.title,
      detail: keyMoments.description,
    })
    .from(keyMoments)
    .where(
      or(
        like(keyMoments.title, pattern),
        like(keyMoments.description, pattern),
      ),
    );

  const allVideoIds = new Set<number>();
  for (const a of matchedAnnotations) allVideoIds.add(a.videoId);
  for (const s of matchedScenes) allVideoIds.add(s.videoId);
  for (const m of matchedMoments) allVideoIds.add(m.videoId);

  const videoMap = new Map<number, { id: number; title: string | null; thumbnailUrl: string | null }>();
  for (const vid of allVideoIds) {
    const vRows = await db.select().from(videos).where(eq(videos.id, vid)).limit(1);
    if (vRows[0]) videoMap.set(vid, { id: vRows[0].id, title: vRows[0].title, thumbnailUrl: vRows[0].thumbnailUrl });
  }

  const results: {
    type: string;
    videoId: number;
    videoTitle: string | null;
    videoThumbnail: string | null;
    timestamp: number;
    endTimestamp: number | null;
    title: string;
    detail: string | null;
    tags?: string[];
  }[] = [];

  for (const a of matchedAnnotations) {
    const v = videoMap.get(a.videoId);
    results.push({
      type: "annotation",
      videoId: a.videoId,
      videoTitle: v?.title ?? null,
      videoThumbnail: v?.thumbnailUrl ?? null,
      timestamp: a.timestamp,
      endTimestamp: a.endTimestamp ?? null,
      title: a.title,
      detail: a.detail,
      tags: a.tags ? JSON.parse(a.tags) : [],
    });
  }

  for (const s of matchedScenes) {
    const v = videoMap.get(s.videoId);
    results.push({
      type: "scene",
      videoId: s.videoId,
      videoTitle: v?.title ?? null,
      videoThumbnail: v?.thumbnailUrl ?? null,
      timestamp: s.timestamp,
      endTimestamp: null,
      title: s.title ?? "Scene",
      detail: s.detail,
    });
  }

  for (const m of matchedMoments) {
    const v = videoMap.get(m.videoId);
    results.push({
      type: "key_moment",
      videoId: m.videoId,
      videoTitle: v?.title ?? null,
      videoThumbnail: v?.thumbnailUrl ?? null,
      timestamp: m.timestamp,
      endTimestamp: null,
      title: m.title,
      detail: m.detail,
    });
  }

  results.sort((a, b) => a.videoId - b.videoId || a.timestamp - b.timestamp);

  return NextResponse.json({ query: q, results });
}
