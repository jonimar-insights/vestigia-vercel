import { pgTable, serial, text, integer, real } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  role: text("role").notNull().default("member"), // admin | member
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const videos = pgTable("videos", {
  id: serial("id").primaryKey(),
  youtubeUrl: text("youtube_url").notNull(),
  youtubeId: text("youtube_id").notNull().unique(),
  title: text("title"),
  thumbnailUrl: text("thumbnail_url"),
  durationSeconds: integer("duration_seconds"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  createdBy: text("created_by").notNull().default("anonymous"),
});

export const transcripts = pgTable("transcripts", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  segments: text("segments").notNull(), // JSON array of {start, duration, text}
  language: text("language").notNull().default("en"),
  source: text("source").notNull().default("auto-caption"), // auto-caption | whisper
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const annotations = pgTable("annotations", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  timestampStart: real("timestamp_start").notNull(),
  timestampEnd: real("timestamp_end").notNull(),
  label: text("label").notNull(),
  tags: text("tags"), // JSON array of strings
  note: text("note"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  createdBy: text("created_by").notNull().default("anonymous"),
});

export const scenes = pgTable("scenes", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  timestamp: real("timestamp").notNull(),
  thumbnailPath: text("thumbnail_path"),
  aiDescription: text("ai_description"),
  aiTags: text("ai_tags"), // JSON array of strings
  aiConfidence: real("ai_confidence"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const cliplists = pgTable("cliplists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  createdBy: text("created_by").notNull().default("anonymous"),
});

export const clipItems = pgTable("clip_items", {
  id: serial("id").primaryKey(),
  cliplistId: integer("cliplist_id")
    .notNull()
    .references(() => cliplists.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // annotation | scene | key_moment
  videoId: integer("video_id").notNull(),
  timestamp: real("timestamp").notNull(),
  endTimestamp: real("end_timestamp"),
  title: text("title").notNull(),
  detail: text("detail"),
  tags: text("tags"), // JSON array of strings
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  settings: text("settings").notNull().default("{}"), // JSON: { aiKeys: Record<string,string>, preferredProvider?: string }
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const keyMoments = pgTable("key_moments", {
  id: serial("id").primaryKey(),
  videoId: integer("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  timestamp: real("timestamp").notNull(),
  endTimestamp: real("end_timestamp"),
  title: text("title").notNull(),
  description: text("description"),
  source: text("source").notNull(), // chapter | storyboard | transcript | ai
  thumbnailUrl: text("thumbnail_url"),
  confidence: real("confidence").notNull().default(0.5),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const folders = pgTable("folders", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").default("bg-accent"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const folderVideos = pgTable("folder_videos", {
  id: serial("id").primaryKey(),
  folderId: integer("folder_id")
    .notNull()
    .references(() => folders.id, { onDelete: "cascade" }),
  videoId: integer("video_id")
    .notNull()
    .references(() => videos.id, { onDelete: "cascade" }),
  addedAt: text("added_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
