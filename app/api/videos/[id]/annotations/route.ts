import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { annotations } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const videoAnnotations = await db
    .select()
    .from(annotations)
    .where(eq(annotations.videoId, videoId));

  return NextResponse.json(
    videoAnnotations.map((a) => ({
      ...a,
      tags: a.tags ? JSON.parse(a.tags) : [],
    })),
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const body = await request.json();
  const { timestampStart, timestampEnd, label, tags, note } = body as {
    timestampStart: number;
    timestampEnd: number;
    label: string;
    tags?: string[];
    note?: string;
  };

  if (timestampStart == null || timestampEnd == null || !label) {
    return NextResponse.json(
      { error: "timestampStart, timestampEnd, and label are required" },
      { status: 400 },
    );
  }

  const [annotation] = await db
    .insert(annotations)
    .values({
      videoId,
      timestampStart,
      timestampEnd,
      label,
      tags: tags ? JSON.stringify(tags) : null,
      note: note ?? null,
      createdBy: session?.user?.name ?? "anonymous",
    })
    .returning();

  return NextResponse.json(
    {
      ...annotation,
      tags: annotation.tags ? JSON.parse(annotation.tags) : [],
    },
    { status: 201 },
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const body = await request.json();
  const { annotationId, timestampStart, timestampEnd, label, tags, note } =
    body as {
      annotationId: number;
      timestampStart?: number;
      timestampEnd?: number;
      label?: string;
      tags?: string[];
      note?: string;
    };

  if (!annotationId) {
    return NextResponse.json(
      { error: "annotationId is required" },
      { status: 400 },
    );
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if (timestampStart != null) updates.timestampStart = timestampStart;
  if (timestampEnd != null) updates.timestampEnd = timestampEnd;
  if (label != null) updates.label = label;
  if (tags != null) updates.tags = JSON.stringify(tags);
  if (note !== undefined) updates.note = note;

  const [updated] = await db
    .update(annotations)
    .set(updates)
    .where(eq(annotations.id, annotationId))
    .returning();

  if (!updated) {
    return NextResponse.json(
      { error: "Annotation not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ...updated,
    tags: updated.tags ? JSON.parse(updated.tags) : [],
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const { annotationId } = (await request.json()) as { annotationId: number };

  if (!annotationId) {
    return NextResponse.json(
      { error: "annotationId is required" },
      { status: 400 },
    );
  }

  await db.delete(annotations).where(eq(annotations.id, annotationId));

  return NextResponse.json({ success: true });
}
