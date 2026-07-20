import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cliplists, clipItems } from "@/lib/schema";
import { eq, desc, count } from "drizzle-orm";

export async function GET() {
  const lists = await db
    .select()
    .from(cliplists)
    .orderBy(desc(cliplists.updatedAt));

  // Attach item count to each list
  const result = await Promise.all(
    lists.map(async (list) => {
      const [{ value: itemCount }] = await db
        .select({ value: count() })
        .from(clipItems)
        .where(eq(clipItems.cliplistId, list.id));
      return { ...list, itemCount };
    }),
  );

  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, description } = body;

  if (!name || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const [result] = await db
    .insert(cliplists)
    .values({
      name: name.trim(),
      description: description?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return NextResponse.json(result, { status: 201 });
}
