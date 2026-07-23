import { callAIWithUserKeys } from "./ai";

export interface KeyMoment {
  timestamp: number;
  title: string;
  description?: string;
  source: "chapter" | "storyboard" | "transcript" | "ai";
  thumbnailUrl?: string;
  confidence: number;
}

export interface StoryboardFrame {
  timestamp: number;
  imageUrl: string;
  index: number;
}

export async function extractYouTubeChapters(
  youtubeId: string,
): Promise<KeyMoment[]> {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${youtubeId}`,
    );
    const html = await res.text();

    const chapters: KeyMoment[] = [];

    // Try to extract chapters from ytInitialData
    const dataMatch = html.match(
      /var ytInitialData = ([\s\S]*?);<\/script>/,
    );
    if (dataMatch) {
      try {
        const data = JSON.parse(dataMatch[1]);
        const engagementPanels =
          data?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer
            ?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer
            ?.markersMap;

        if (engagementPanels) {
          for (const panel of engagementPanels) {
            if (
              panel?.key === "DESCRIPTION_CHAPTERS" ||
              panel?.key === "AUTO_CHAPTERS"
            ) {
              const markers =
                panel?.value?.chapters || panel?.value?.markers || [];
              for (const marker of markers) {
                const chapter =
                  marker.chapterRenderer || marker;
                if (chapter) {
                  const title =
                    chapter.title?.simpleText ||
                    chapter.title?.runs?.[0]?.text ||
                    "";
                  const startSeconds =
                    chapter.onTap?.watchEndpoint?.startTimeSeconds;
                  const timeMs =
                    chapter.timeRangeStartMillis != null
                      ? chapter.timeRangeStartMillis
                      : startSeconds != null
                        ? startSeconds * 1000
                        : null;
                  if (title && timeMs != null && !isNaN(timeMs)) {
                    chapters.push({
                      timestamp: timeMs / 1000,
                      title,
                      source: "chapter",
                      confidence: 1.0,
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn("Failed to parse ytInitialData chapters:", e);
      }
    }

    // Fallback: parse chapters from description
    if (chapters.length === 0) {
      // Use a character class that stops at an unescaped double quote
      const descMatch = html.match(
        /"shortDescription":"((?:[^"\\]|\\.)*)"/,
      );
      if (descMatch) {
        const desc = descMatch[1]
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
        // Only match timestamps at the start of a line (actual chapter markers)
        const chapterRegex =
          /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)/gm;
        let match;
        while ((match = chapterRegex.exec(desc)) !== null) {
          const timeParts = match[1].split(":").map(Number);
          let seconds = 0;
          if (timeParts.length === 3) {
            seconds =
              timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
          } else {
            seconds = timeParts[0] * 60 + timeParts[1];
          }
          chapters.push({
            timestamp: seconds,
            title: match[2].trim(),
            source: "chapter",
            confidence: 0.9,
          });
        }
      }
    }

    return chapters.sort((a, b) => a.timestamp - b.timestamp);
  } catch (e) {
    console.error("Failed to extract chapters:", e);
    return [];
  }
}

export async function extractStoryboards(
  youtubeId: string,
): Promise<StoryboardFrame[]> {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${youtubeId}`,
    );
    const html = await res.text();

    const storyboardSpecMatch = html.match(
      /"storyboards":\s*\{\s*"playerStoryboardSpecRenderer":\s*\{\s*"spec":\s*"([^"]+)"/,
    );

    if (!storyboardSpecMatch) return [];

    const spec = storyboardSpecMatch[1].replace(/\\u0026/g, "&");
    const parts = spec.split("|");

    if (parts.length < 2) return [];

    const baseUrl = parts[0];
    const storyboardParams = parts.slice(1);

    const frames: StoryboardFrame[] = [];

    // Use the highest quality storyboard (last set)
    const paramStr =
      storyboardParams[storyboardParams.length - 1] || storyboardParams[0];
    const params = new URLSearchParams(paramStr);

    const cols = parseInt(params.get("c") || "5");
    const rows = parseInt(params.get("r") || "5");
    const perSheet = cols * rows;
    const totalFrames = parseInt(params.get("n") || "100");

    // Try to get actual duration from multiple sources
    let duration = 600; // fallback default
    try {
      // Attempt 1: oEmbed
      const durationRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`,
      );
      if (durationRes.ok) {
        const oembedData = await durationRes.json();
        if (oembedData.duration && typeof oembedData.duration === "number") {
          duration = oembedData.duration;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch duration from oEmbed:", e);
    }

    // Attempt 2: if oEmbed didn't give us duration, scrape the video page
    if (duration === 600) {
      try {
        const pageRes = await fetch(`https://www.youtube.com/watch?v=${youtubeId}`);
        const html = await pageRes.text();
        const dataMatch = html.match(/var ytInitialData = ([\s\S]*?);<\/script>/);
        if (dataMatch) {
          const data = JSON.parse(dataMatch[1]);
          const lengthSeconds =
            data?.videoDetails?.lengthSeconds ||
            data?.playerOverlays?.playerOverlayRenderer?.lengthSeconds;
          if (lengthSeconds) {
            duration = parseInt(lengthSeconds);
          }
        }
      } catch (e) {
        console.warn("Failed to fetch duration from page scrape:", e);
      }
    }

    const frameInterval = duration / totalFrames;

    for (let i = 0; i < Math.min(totalFrames, 100); i++) {
      const sheetIndex = Math.floor(i / perSheet);

      const sheetUrl = baseUrl
        .replace("$L", sheetIndex.toString())
        .replace("$N", "M");

      frames.push({
        timestamp: i * frameInterval,
        imageUrl: sheetUrl,
        index: i,
      });
    }

    return frames;
  } catch (e) {
    console.error("Failed to extract storyboards:", e);
    return [];
  }
}

export async function extractTranscriptKeyMoments(
  youtubeId: string,
  preloadedSegments?: { start: number; duration: number; text: string }[],
): Promise<KeyMoment[]> {
  try {
    const segments = preloadedSegments ?? (() => {
      throw new Error("No segments provided and fetch not implemented here");
    })();

    const keyMoments: KeyMoment[] = [];

    // Find natural pauses (gaps between segments)
    for (let i = 1; i < segments.length; i++) {
      const prevEnd = segments[i - 1].start + segments[i - 1].duration;
      const gap = segments[i].start - prevEnd;

      if (gap > 3.0) {
        // Significant pause (3s+ indicates a genuine structural break)
        const precedingText = segments
          .slice(Math.max(0, i - 3), i)
          .map((s) => s.text)
          .join(" ");

        const title =
          precedingText.length > 60
            ? precedingText.slice(0, 60).trim() + "..."
            : precedingText.trim();

        if (title.length > 5) {
          keyMoments.push({
            timestamp: segments[i].start,
            title: `Pause: ${title}`,
            description: `Natural break after ${Math.round(gap)}s pause`,
            source: "transcript",
            confidence: 0.7,
          });
        }
      }
    }

    // Find sentence-starting phrases that indicate topic shifts
    const topicMarkers = [
      "now let",
      "moving on",
      "next up",
      "let's talk about",
      "so basically",
      "the key point",
      "important",
      "remember that",
      "in summary",
      "to recap",
      "first of all",
      "secondly",
      "finally",
      "on the other hand",
      "however",
      "but wait",
      "here's the thing",
      "the problem is",
      "the solution",
      "how does this work",
      "let me show you",
      "look at this",
      "pay attention",
      "this is crucial",
    ];

    for (let i = 0; i < segments.length; i++) {
      const text = segments[i].text.toLowerCase();
      for (const marker of topicMarkers) {
        if (text.startsWith(marker) || text.includes(`. ${marker}`)) {
          const nearbyText = segments
            .slice(i, Math.min(segments.length, i + 3))
            .map((s) => s.text)
            .join(" ");

          keyMoments.push({
            timestamp: segments[i].start,
            title:
              nearbyText.length > 60
                ? nearbyText.slice(0, 60).trim() + "..."
                : nearbyText.trim(),
            description: `Topic shift detected: "${marker}"`,
            source: "transcript",
            confidence: 0.6,
          });
          break;
        }
      }
    }

    // Deduplicate by timestamp (within 10s) and prioritize chapters
    const deduped: KeyMoment[] = [];
    keyMoments.sort((a, b) => a.timestamp - b.timestamp);
    for (const moment of keyMoments) {
      const tooClose = deduped.some(
        (d) => Math.abs(d.timestamp - moment.timestamp) < 10,
      );
      if (!tooClose) {
        deduped.push(moment);
      }
    }

    // Limit to reasonable number, spread evenly
    if (deduped.length > 30) {
      const step = deduped.length / 30;
      return deduped.filter((_, i) => i % Math.ceil(step) === 0).slice(0, 30);
    }
    return deduped;
  } catch (e) {
    console.error("Failed to extract transcript key moments:", e);
    return [];
  }
}

/**
 * Fetch video metadata with fallback chain:
 *   1. YouTube Data API v3 (requires YOUTUBE_API_KEY env var)
 *   2. YouTube oEmbed endpoint (no key needed, limited data)
 *   3. Scrape video page directly
 */
async function fetchVideoMetadata(
  youtubeId: string,
): Promise<{
  title: string;
  description: string;
  duration: number;
  channelTitle: string;
  category: string;
  tags: string[];
  viewCount: number;
} | null> {
  // Attempt 1: YouTube Data API v3
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${youtubeId}&key=${apiKey}`,
      );
      const data = await res.json();
      const item = data.items?.[0];
      if (item) {
        const durationStr = item.contentDetails?.duration || "PT0S";
        const durationMatch = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        const hours = parseInt(durationMatch?.[1] || "0");
        const minutes = parseInt(durationMatch?.[2] || "0");
        const seconds = parseInt(durationMatch?.[3] || "0");
        const duration = hours * 3600 + minutes * 60 + seconds;

        return {
          title: item.snippet?.title || "",
          description: item.snippet?.description || "",
          duration,
          channelTitle: item.snippet?.channelTitle || "",
          category: item.snippet?.categoryId || "",
          tags: item.snippet?.tags || [],
          viewCount: parseInt(item.statistics?.viewCount || "0"),
        };
      }
    } catch (e) {
      console.warn("YouTube Data API failed, trying fallback:", e);
    }
  }

  // Attempt 2: oEmbed (no key needed)
  try {
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`,
    );
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      return {
        title: oembed.title || "",
        description: oembed.author_name || "",
        duration: 600,
        channelTitle: oembed.author_name || "",
        category: "",
        tags: [],
        viewCount: 0,
      };
    }
  } catch (e) {
    console.warn("oEmbed fallback failed, trying page scrape:", e);
  }

  // Attempt 3: scrape video page for title and description
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${youtubeId}`);
    const html = await pageRes.text();

    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(" - YouTube", "").trim() : "";

    const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    const description = descMatch
      ? descMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      : "";

    // Try to extract duration from ytInitialData
    let duration = 600;
    const dataMatch = html.match(/var ytInitialData = ([\s\S]*?);<\/script>/);
    if (dataMatch) {
      try {
        const data = JSON.parse(dataMatch[1]);
        const lengthSeconds = data?.videoDetails?.lengthSeconds;
        if (lengthSeconds) {
          duration = parseInt(lengthSeconds);
        }
      } catch (e) {
        console.warn("Failed to parse ytInitialData duration:", e);
      }
    }

    return {
      title,
      description,
      duration,
      channelTitle: "",
      category: "",
      tags: [],
      viewCount: 0,
    };
  } catch (e) {
    console.error("All metadata fetch methods failed:", e);
    return null;
  }
}

function parseDescriptionChapters(
  description: string,
): { timestamp: number; title: string }[] {
  const chapters: { timestamp: number; title: string }[] = [];
  const lines = description.split("\n");

  for (const line of lines) {
    const match = line.match(
      /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)/,
    );
    if (match) {
      const timeParts = match[1].split(":").map(Number);
      let ts = 0;
      if (timeParts.length === 3) {
        ts = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
      } else {
        ts = timeParts[0] * 60 + timeParts[1];
      }
      chapters.push({ timestamp: ts, title: match[2].trim() });
    }
  }

  return chapters;
}

const CATEGORY_MAP: Record<string, string> = {
  "1": "Film & Animation",
  "2": "Autos & Vehicles",
  "10": "Music",
  "15": "Pets & Animals",
  "17": "Sports",
  "18": "Short Movies",
  "19": "Travel & Events",
  "20": "Gaming",
  "21": "Videoblogging",
  "22": "People & Blogs",
  "23": "Comedy",
  "24": "Entertainment",
  "25": "News & Politics",
  "26": "Howto & Style",
  "27": "Education",
  "28": "Science & Technology",
  "29": "Nonprofits & Activism",
};

export async function extractAIKeyMoments(
  youtubeId: string,
  transcriptSegments?: { start: number; duration: number; text: string }[],
  userKeys?: Record<string, string>,
  preferred?: string | null,
): Promise<KeyMoment[]> {
  const meta = await fetchVideoMetadata(youtubeId);
  if (!meta) return [];

  const descPreview = meta.description.length > 3000
    ? meta.description.slice(0, 3000) + "..."
    : meta.description;

  const descriptionChapters = parseDescriptionChapters(meta.description);
  const hasDescriptionChapters = descriptionChapters.length >= 2;

  const categoryName = CATEGORY_MAP[meta.category] || (meta.category ? "Unknown" : "Unknown");
  const tagStr = meta.tags.length > 0
    ? meta.tags.slice(0, 15).join(", ")
    : "none";

  const durationMin = Math.floor(meta.duration / 60);
  const durationSec = meta.duration % 60;
  let chapterSection = "";
  if (hasDescriptionChapters) {
    chapterSection = `
Description chapters (use as reference, but expand each into more specific sub-moments):
${descriptionChapters.map((c) => `  [${c.timestamp}s] ${c.title}`).join("\n")}
`;
  }

  // Include transcript excerpts so the AI can pinpoint real topic breaks
  let transcriptSection = "";
  if (transcriptSegments && transcriptSegments.length > 0) {
    // Sample ~30 evenly-spaced segments to stay within token limits
    const sample = transcriptSegments.length <= 30
      ? transcriptSegments
      : transcriptSegments.filter((_, i) => i % Math.ceil(transcriptSegments.length / 30) === 0);
    transcriptSection = `
TRANSCRIPT EXCERPTS (sampled evenly across the video):
${sample.map((s) => `  [${Math.floor(s.start)}s] ${s.text}`).join("\n")}
`;
  }

  const prompt = `You are an expert video analyst. Your task is to identify the key moments in this YouTube video.

VIDEO METADATA:
- Title: "${meta.title}"
- Channel: "${meta.channelTitle}"
- Category: ${categoryName}
- Tags: ${tagStr}
- Duration: ${durationMin}m ${durationSec}s (${meta.duration} seconds)
- Views: ${meta.viewCount.toLocaleString()}
${chapterSection}
VIDEO DESCRIPTION:
${descPreview}
${transcriptSection}
INSTRUCTIONS:
1. Analyze the title, channel, category, tags, description, and transcript to understand the video's content.
${hasDescriptionChapters ? "2. Use the description chapters as a starting point, then expand each into more specific sub-moments with precise timestamps." : "2. Infer the video's structure from the title, description, and transcript. Educational videos typically follow: intro → topic 1 → topic 2 → ... → conclusion."}
3. For each moment, provide:
   - timestamp: start time in SECONDS (must be between 0 and ${meta.duration})
   - title: concise descriptive title (max 60 chars, start with a verb or noun, be specific)
   - description: 1-2 sentences explaining what happens or is discussed
   - confidence: 0.0-1.0 (higher = more certain this is a real distinct moment)
4. Spread moments across the full duration. Don't cluster them all in the first half.
5. For educational content: identify concept introductions, worked examples, key derivations, important results, and demonstrations.
6. For entertainment: identify plot points, climax moments, transitions, and highlights.
7. Use the transcript excerpts to precisely timestamp moments where topic shifts actually occur.

Return ONLY a JSON array. No other text. Example format:
[{"timestamp":0,"title":"Introduction","description":"Opening remarks","confidence":0.8}]`;

  try {
    const result = await callAIWithUserKeys({
      messages: [
        {
          role: "system",
          content: "You are a precise video content analyst. Always return valid JSON arrays. Never include markdown code fences or explanatory text outside the JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      maxTokens: 3000,
    }, userKeys, preferred);

    const text = result.text;

    // Strip markdown code fences if present (some models return ```json ... ```)
    const stripped = text.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g, "$1").trim();

    const jsonMatch = stripped.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    let parsed: Array<{
      timestamp: number;
      title: string;
      description?: string;
      confidence?: number;
    }>;

    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      const fixed = jsonMatch[0]
        .replace(/,\s*]/g, "]")
        .replace(/,\s*}/g, "}");
      parsed = JSON.parse(fixed);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) return [];

    const deduped = parsed
      .map((item) => ({
        timestamp: Math.min(Math.max(0, Number(item.timestamp) || 0), meta.duration),
        title: String(item.title || "").slice(0, 60).trim(),
        description: String(item.description || "").trim(),
        source: "ai" as const,
        confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0.5)),
      }))
      .filter((item) => item.title.length > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    const final: typeof deduped = [];
    for (const moment of deduped) {
      const tooClose = final.some(
        (f) => Math.abs(f.timestamp - moment.timestamp) < 5,
      );
      if (!tooClose) {
        final.push(moment);
      }
    }

    return final;
  } catch (e) {
    console.error("Failed to extract AI key moments:", e);
    return [];
  }
}