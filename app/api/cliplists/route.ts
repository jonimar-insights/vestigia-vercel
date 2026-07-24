import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { cliplists, clipItems } from "@/lib/schema";
import { eq, desc, count } from "drizzle-orm";
import { auth } from "@/auth";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getDb();
  const lists = await db
    .select()
    .from(cliplists)
    .where(eq(cliplists.userId, session.user.id as string))
    .orderBy(desc(cliplists.updatedAt));

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
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getDb();
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
      userId: session.user.id as string,
    })
    .returning();

  return NextResponse.json(result, { status: 201 });
}
