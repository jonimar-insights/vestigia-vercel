/**
 * Local script to extract transcripts for videos that failed on Vercel.
 * Run: npx tsx scripts/extract-transcripts.ts
 *
 * Requires DATABASE_URL in .env
 */

import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { videos, transcripts } from "../lib/schema";
import { eq } from "drizzle-orm";
import { fetchTranscriptWithFallback } from "../lib/transcript";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const db = drizzle(sql);

  const allVideos = await db.select().from(videos);
  const existingTranscripts = await db.select().from(transcripts);
  const importedIds = new Set(existingTranscripts.map((t) => t.videoId));

  const missing = allVideos.filter((v) => !importedIds.has(v.id));
  console.log(`\n${allVideos.length} videos total, ${existingTranscripts.length} have transcripts, ${missing.length} missing\n`);

  let success = 0;
  let failed = 0;

  for (const v of missing) {
    process.stdout.write(`[${v.id}] ${v.title ?? v.youtubeId} ... `);
    try {
      const transcript = await fetchTranscriptWithFallback(v.youtubeId);
      if (transcript && transcript.segments.length > 0) {
        await db.insert(transcripts).values({
          videoId: v.id,
          segments: JSON.stringify(transcript.segments),
          language: transcript.language,
          source: transcript.source,
        });
        console.log(`OK (${transcript.segments.length} segments, ${transcript.source})`);
        success++;
      } else {
        console.log("NO TRANSCRIPT AVAILABLE");
        failed++;
      }
    } catch (e: unknown) {
      console.log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone. ${success} extracted, ${failed} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
