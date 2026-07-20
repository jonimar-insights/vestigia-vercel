import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videos, scenes } from "@/lib/schema";
import { eq } from "drizzle-orm";
import {
  downloadVideo,
  detectScenes,
  extractSceneFrames,
  cleanupTempDir,
} from "@/lib/scenes";
import { tagMultipleScenes } from "@/lib/gemini";
import path from "path";
import {
  startSceneJob,
  updateSceneJob,
  isSceneJobRunning,
} from "@/lib/scene-jobs";
import { persistThumbnails, cleanupThumbnailsDir } from "@/lib/thumbnails";

export async function POST(
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

  if (isSceneJobRunning(videoId)) {
    return NextResponse.json({ message: "Scene detection already in progress" });
  }

  const existingScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.videoId, videoId));
  if (existingScenes.length > 0) {
    return NextResponse.json({
      message: "Scenes already detected",
      scenes: existingScenes.map((s) => ({
        ...s,
        aiTags: s.aiTags ? JSON.parse(s.aiTags) : [],
      })),
    });
  }

  const body = await _request.json().catch(() => ({}));
  const { threshold, minSceneDuration, maxScenes } = body as {
    threshold?: number;
    minSceneDuration?: number;
    maxScenes?: number;
  };

  startSceneJob(videoId);

  runSceneDetection(videoId, video.youtubeId, {
    threshold,
    minSceneDuration,
    maxScenes,
  }).catch((e) => {
    console.error("Background scene detection failed:", e);
    updateSceneJob(videoId, {
      status: "error",
      message: e instanceof Error ? e.message : "Unknown error",
      completedAt: new Date().toISOString(),
    });
  });

  return NextResponse.json({ message: "Scene detection started" });
}

async function runSceneDetection(
  videoId: number,
  youtubeId: string,
  options: {
    threshold?: number;
    minSceneDuration?: number;
    maxScenes?: number;
  } = {},
) {
  let videoPath: string | null = null;
  let tmpDir: string | null = null;

  try {
    updateSceneJob(videoId, {
      message: "Downloading video...",
      stage: "download",
    });
    videoPath = await downloadVideo(youtubeId, (msg) => {
      updateSceneJob(videoId, { message: msg });
    });
    tmpDir = path.dirname(videoPath);

    updateSceneJob(videoId, {
      message: "Detecting scene changes...",
      stage: "detect",
    });
    const rawScenes = await detectScenes(videoPath, {
      threshold: options.threshold ?? 0.3,
      minSceneDuration: options.minSceneDuration ?? 1.0,
      maxScenes: options.maxScenes ?? 50,
      onProgress: (msg) => updateSceneJob(videoId, { message: msg }),
    });

    if (rawScenes.length === 0) {
      updateSceneJob(videoId, {
        status: "done",
        message: "No scene changes detected",
        scenesFound: 0,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    updateSceneJob(videoId, {
      message: `Extracting frames from ${rawScenes.length} scenes...`,
      stage: "extract",
      totalScenes: rawScenes.length,
    });
    const thumbnailsDir = path.join(tmpDir, "thumbnails");
    const scenesWithThumbs = await extractSceneFrames(
      videoPath,
      rawScenes,
      thumbnailsDir,
      (msg) => updateSceneJob(videoId, { message: msg }),
    );

    updateSceneJob(videoId, {
      message: `AI tagging ${scenesWithThumbs.length} scenes...`,
      stage: "tag",
    });

    const imagesToTag = scenesWithThumbs
      .filter((s) => s.thumbnailPath)
      .map((s, i) => ({
        index: i,
        frames: [s.thumbnailPath!, s.middleFramePath].filter(
          Boolean,
        ) as string[],
        timestamp: s.timestamp,
        duration: s.duration ?? 0,
      }));

    const aiResults = await tagMultipleScenes(
      imagesToTag,
      (msg) => updateSceneJob(videoId, { message: msg }),
    );

    const persistedMap = persistThumbnails(videoId, thumbnailsDir);

    const savedScenes = [];
    for (let i = 0; i < scenesWithThumbs.length; i++) {
      const scene = scenesWithThumbs[i];
      const aiTag = aiResults.get(i);

      const thumbPath = scene.thumbnailPath
        ? (persistedMap.get(scene.thumbnailPath) ?? scene.thumbnailPath)
        : null;

      const [inserted] = await db
        .insert(scenes)
        .values({
          videoId,
          timestamp: scene.timestamp,
          thumbnailPath: thumbPath,
          aiDescription: aiTag?.description ?? null,
          aiTags: aiTag?.tags ? JSON.stringify(aiTag.tags) : null,
          aiConfidence: aiTag?.confidence ?? null,
        })
        .returning();

      savedScenes.push({
        ...inserted,
        aiTags: inserted.aiTags ? JSON.parse(inserted.aiTags) : [],
      });
    }

    updateSceneJob(videoId, {
      status: "done",
      message: `Detected ${savedScenes.length} scenes`,
      scenesFound: savedScenes.length,
      completedAt: new Date().toISOString(),
    });
  } finally {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
    }
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const videoId = parseInt(id);

  if (isNaN(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  const videoScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.videoId, videoId));

  return NextResponse.json(
    videoScenes.map((s) => ({
      ...s,
      aiTags: s.aiTags ? JSON.parse(s.aiTags) : [],
    })),
  );
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

  if (isSceneJobRunning(videoId)) {
    return NextResponse.json(
      { error: "Cannot delete scenes while detection is running" },
      { status: 409 },
    );
  }

  await db.delete(scenes).where(eq(scenes.videoId, videoId));
  cleanupThumbnailsDir(videoId);

  return NextResponse.json({ success: true });
}
