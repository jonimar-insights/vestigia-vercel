import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cliplists, clipItems, videos } from "@/lib/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const listId = parseInt(id, 10);
  if (isNaN(listId)) {
    return NextResponse.json({ error: "Invalid cliplist ID" }, { status: 400 });
  }

  const listRows = await db.select().from(cliplists).where(eq(cliplists.id, listId)).limit(1);
  if (!listRows[0]) {
    return NextResponse.json({ error: "Cliplist not found" }, { status: 404 });
  }
  const list = listRows[0];

  const items = await db
    .select()
    .from(clipItems)
    .where(eq(clipItems.cliplistId, listId))
    .orderBy(desc(clipItems.createdAt));

  // Attach video info to each item
  const videoIds = [...new Set(items.map((i) => i.videoId))];
  const videoMap = new Map<number, { title: string | null; thumbnailUrl: string | null }>();
  for (const vid of videoIds) {
    const vRows = await db
      .select({ title: videos.title, thumbnailUrl: videos.thumbnailUrl })
      .from(videos)
      .where(eq(videos.id, vid))
      .limit(1);
    if (vRows[0]) videoMap.set(vid, vRows[0]);
  }

  const itemsWithVideo = items.map((item) => ({
    ...item,
    tags: item.tags ? JSON.parse(item.tags) : [],
    videoTitle: videoMap.get(item.videoId)?.title ?? null,
    videoThumbnail: videoMap.get(item.videoId)?.thumbnailUrl ?? null,
  }));

  return NextResponse.json({ ...list, items: itemsWithVideo });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const listId = parseInt(id, 10);
  if (isNaN(listId)) {
    return NextResponse.json({ error: "Invalid cliplist ID" }, { status: 400 });
  }

  await db.delete(cliplists).where(eq(cliplists.id, listId));
  return NextResponse.json({ success: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const listId = parseInt(id, 10);
  if (isNaN(listId)) {
    return NextResponse.json({ error: "Invalid cliplist ID" }, { status: 400 });
  }

  const body = await request.json();
  const { name, description } = body;

  const updateData: Record<string, string> = { updatedAt: new Date().toISOString() };
  if (name !== undefined) updateData.name = name.trim();
  if (description !== undefined) updateData.description = description?.trim() || null;

  await db.update(cliplists).set(updateData).where(eq(cliplists.id, listId));
  const updatedRows = await db.select().from(cliplists).where(eq(cliplists.id, listId)).limit(1);
  return NextResponse.json(updatedRows[0]);
}
