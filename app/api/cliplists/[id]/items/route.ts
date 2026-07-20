import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clipItems, cliplists } from "@/lib/schema";
import { eq, and } from "drizzle-orm";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const listId = parseInt(id, 10);
  if (isNaN(listId)) {
    return NextResponse.json({ error: "Invalid cliplist ID" }, { status: 400 });
  }

  // Verify cliplist exists
  const listRows = await db.select().from(cliplists).where(eq(cliplists.id, listId)).limit(1);
  if (!listRows[0]) {
    return NextResponse.json({ error: "Cliplist not found" }, { status: 404 });
  }

  const body = await request.json();
  const { type, videoId, timestamp, endTimestamp, title, detail, tags } = body;

  if (!type || !videoId || timestamp === undefined || !title) {
    return NextResponse.json({ error: "Missing required fields: type, videoId, timestamp, title" }, { status: 400 });
  }

  const [result] = await db
    .insert(clipItems)
    .values({
      cliplistId: listId,
      type,
      videoId,
      timestamp,
      endTimestamp: endTimestamp ?? null,
      title,
      detail: detail || null,
      tags: tags ? JSON.stringify(tags) : null,
    })
    .returning();

  // Update cliplist's updatedAt
  await db.update(cliplists)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(cliplists.id, listId));

  return NextResponse.json(result, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const listId = parseInt(id, 10);
  if (isNaN(listId)) {
    return NextResponse.json({ error: "Invalid cliplist ID" }, { status: 400 });
  }

  const body = await request.json();
  const { itemId } = body;

  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }

  await db.delete(clipItems)
    .where(and(eq(clipItems.id, itemId), eq(clipItems.cliplistId, listId)));

  // Update cliplist's updatedAt
  await db.update(cliplists)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(cliplists.id, listId));

  return NextResponse.json({ success: true });
}
