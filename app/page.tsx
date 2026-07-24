"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";

// YouTube IFrame API types (local to this file)
interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  getPlayerState(): number;
  loadVideoById(videoId: string, startSeconds: number): void;
  cueVideoById(videoId: string, startSeconds: number): void;
}

interface Video {
  id: number;
  youtubeUrl: string;
  youtubeId: string;
  title: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  annotationCount?: number;
  sceneCount?: number;
  momentCount?: number;
  hasTranscript?: boolean;
}

interface PlaylistVideo {
  id: string;
  title: string;
  thumbnail: string;
  position: number;
}

interface SearchResult {
  type: "annotation" | "scene" | "key_moment";
  videoId: number;
  videoTitle: string | null;
  videoThumbnail: string | null;
  timestamp: number;
  endTimestamp: number | null;
  title: string;
  detail: string | null;
  tags?: string[];
}

interface Cliplist {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

interface ClipItem {
  id: number;
  cliplistId: number;
  type: string;
  videoId: number;
  timestamp: number;
  endTimestamp: number | null;
  title: string;
  detail: string | null;
  tags: string[];
  createdAt: string;
  videoTitle: string | null;
  videoThumbnail: string | null;
}

interface CliplistWithItems extends Cliplist {
  items: ClipItem[];
}

type Tab = "import" | "search" | "cliplists" | "settings";

function isPlaylistUrl(u: string) {
  return /[?&]list=/.test(u);
}

function formatTs(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query})`, "gi"));
  return (
    <>{
      parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-600">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )
    }</>
  );
}

// ── Video Playlist Player ──
function VideoPlaylistPlayer({ items, onClose }: { items: ClipItem[]; onClose: () => void }) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<YTPlayer | null>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const timeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const item = items[currentIdx];

  // Load the data for the current video(s) - we need youtubeId for each
  const [videoIds, setVideoIds] = useState<Map<number, string>>(new Map());

  // Track which video IDs we've already fetched to avoid repeated calls
  const fetchedIdsRef = useRef<Set<number>>(new Set());

  // Track the last videoId we loaded and prevent double-advance
  const lastVideoIdRef = useRef<string | null>(null);
  const advancedRef = useRef(false);

  // Load video youtubeIds (only for videos not already fetched)
  useEffect(() => {
    const uniqueIds = [...new Set(items.map((i) => i.videoId))];
    const missingIds = uniqueIds.filter((id) => !fetchedIdsRef.current.has(id));
    if (missingIds.length === 0) return;
    missingIds.forEach((id) => fetchedIdsRef.current.add(id));
    Promise.all(
      missingIds.map(async (vid) => {
        try {
          const res = await fetch(`/api/videos/${vid}`);
          if (res.ok) {
            const data = await res.json();
            return { videoId: vid, youtubeId: data.youtubeId };
          }
        } catch {}
        return null;
      })
    ).then((results) => {
      setVideoIds((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (r) next.set(r.videoId, r.youtubeId);
        }
        return next;
      });
    });
  }, [items]);  

  function clearTimeInterval() {
    if (timeIntervalRef.current) { clearInterval(timeIntervalRef.current); timeIntervalRef.current = null; }
  }

  // Playback effect - loads/seeks video when currentIdx changes
  useEffect(() => {
    if (!playerReady || !playerRef.current || !item) return;
    const ytId = videoIds.get(item.videoId);
    if (!ytId) return;

    // Same video - just seek
    if (lastVideoIdRef.current === ytId) {
      try {
        playerRef.current.seekTo(item.timestamp, true);
        playerRef.current.playVideo();
      } catch {}
      return;
    }

    // Different video
    advancedRef.current = false;
    clearTimeInterval();
    setCurrentTime(item.timestamp);

    let poll: ReturnType<typeof setInterval> | null = null;
    const load = () => {
      if (!playerRef.current) return;
      lastVideoIdRef.current = ytId;
      try { playerRef.current.loadVideoById(ytId, item.timestamp); } catch {}
    };

    try {
      const state = playerRef.current.getPlayerState();
      if (state === 3) {
        poll = setInterval(() => {
          try {
            if (!playerRef.current) { if (poll) clearInterval(poll); return; }
            if (playerRef.current.getPlayerState() !== 3) {
              if (poll) clearInterval(poll);
              load();
            }
          } catch { if (poll) clearInterval(poll); }
        }, 100);
      } else {
        load();
      }
    } catch {
      load();
    }

    return () => { if (poll) clearInterval(poll); };
  }, [currentIdx, playerReady, item?.videoId, item?.timestamp]); // eslint-disable-line

  // YouTube IFrame setup
  useEffect(() => {
    const container = playerContainerRef.current;
    if (!container || playerRef.current) return;
    const firstItem = items[0];
    const firstYtId = firstItem ? videoIds.get(firstItem.videoId) : undefined;
    if (!firstYtId) return;
    lastVideoIdRef.current = firstYtId;
    let destroyed = false;

    function createPlayer() {
      if (destroyed || playerRef.current || !container) return;
      try {
        playerRef.current = new window.YT.Player(container, {
          videoId: firstYtId,
          playerVars: { autoplay: 0, modestbranding: 1, rel: 0, controls: 1, enablejsapi: 1 },
          events: {
            onReady: () => {
              if (destroyed) return;
              setPlayerReady(true);
              if (firstItem && playerRef.current) {
                playerRef.current.seekTo(firstItem.timestamp, true);
              }
            },
            onStateChange: (e: { data: number }) => {
              if (destroyed) return;
              const state = e.data;
              const pl = state === 1;
              setPlaying(pl);
              if (pl) {
                if (timeIntervalRef.current) clearInterval(timeIntervalRef.current);
                timeIntervalRef.current = setInterval(() => {
                  try {
                    if (playerRef.current && playerRef.current.getPlayerState() === 1) {
                      setCurrentTime(playerRef.current.getCurrentTime());
                    }
                  } catch {}
                }, 250);
              } else {
                if (timeIntervalRef.current) { clearInterval(timeIntervalRef.current); timeIntervalRef.current = null; }
              }
              // Auto-advance when video ends naturally (state 0)
              if (state === 0) {
                if (advancedRef.current) {
                  advancedRef.current = false;
                } else {
                  setCurrentIdx((prev) => (prev < items.length - 1 ? prev + 1 : 0));
                }
              }
            },
          },
        });
      } catch (err) {
        console.error("[YT Player] createPlayer failed:", err);
      }
    }

    if (window.YT && window.YT.Player) {
      createPlayer();
      return () => { destroyed = true; clearTimeInterval(); };
    }

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    }
    const poll = setInterval(() => {
      if (!destroyed && window.YT && window.YT.Player) { clearInterval(poll); createPlayer(); }
    }, 100);

    return () => { destroyed = true; clearInterval(poll); clearTimeInterval(); };
  }, [videoIds]); // eslint-disable-line

  // Monitor endTime to advance to next item
  useEffect(() => {
    if (!playing || !item || !currentTime || !playerRef.current) return;
    try {
      if (playerRef.current.getPlayerState() !== 1) return;
    } catch { return; }
    const end = item.endTimestamp ?? (item.timestamp + 30);
    if (currentTime >= end) {
      advancedRef.current = true;
      if (currentIdx < items.length - 1) {
        setCurrentIdx((prev) => prev + 1); // eslint-disable-line react-hooks/set-state-in-effect
      } else {
        setCurrentIdx(0);  
      }
    }
  }, [currentTime, playing]); // eslint-disable-line

  function goTo(idx: number) {
    if (idx < 0 || idx >= items.length) return;
    setCurrentIdx(idx);
  }

  function togglePlay() {
    if (!playerRef.current) return;
    try {
      const state = playerRef.current.getPlayerState();
      if (state === 1) playerRef.current.pauseVideo();
      else playerRef.current.playVideo();
    } catch {}
  }

  if (items.length === 0) return null;

  const ytId = videoIds.get(item.videoId);

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col" onClick={onClose}>
      <div className="flex flex-1 min-h-0" onClick={(e) => e.stopPropagation()}>
        {/* Left: Player */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <button onClick={onClose} className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
              <span className="text-xs text-white/40 font-mono">
                {formatTs(currentTime)} / {item.endTimestamp ? formatTs(item.endTimestamp) : formatTs(item.timestamp + 30)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40">{currentIdx + 1}/{items.length}</span>
            </div>
          </div>

          {/* Video player */}
          <div className="aspect-video mx-auto w-full max-w-4xl bg-black">
            <div ref={playerContainerRef} className="w-full h-full" />
            {(!playerReady || !ytId) && (
              <div className="flex items-center justify-center h-full">
                <div className="flex items-center gap-2 text-white/40">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
                  <span className="text-xs">Loading player...</span>
                </div>
              </div>
            )}
          </div>

          {/* Item info + controls */}
          <div className="px-4 py-3 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span className="text-[10px] uppercase font-medium text-accent bg-accent/20 px-1.5 py-0.5 rounded inline-block mb-1">
                  {item.type.replace("_", " ")}
                </span>
                <h3 className="text-sm font-semibold text-white truncate">{item.title}</h3>
                {item.videoTitle && (
                  <p className="text-[10px] text-white/40 truncate">{item.videoTitle}</p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => goTo(currentIdx - 1)} disabled={currentIdx === 0}
                  className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-all" title="Previous">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </button>
                <button onClick={togglePlay}
                  className="p-3 rounded-full bg-accent text-white hover:bg-accent-hover active:scale-95 transition-all" title={playing ? "Pause" : "Play"}>
                  {playing ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
                  ) : (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  )}
                </button>
                <button onClick={() => goTo(currentIdx + 1)} disabled={currentIdx === items.length - 1}
                  className="p-2 rounded text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-all" title="Next">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Playlist */}
        <div className="w-72 border-l border-white/10 bg-black/40 hidden md:flex flex-col shrink-0">
          <div className="px-3 py-2 text-[10px] font-semibold text-white/40 uppercase tracking-wider border-b border-white/10 shrink-0">
            Playlist
          </div>
          <div className="flex-1 overflow-y-auto">
            {items.map((it, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`w-full text-left px-3 py-2 transition-colors flex items-center gap-2 ${
                  i === currentIdx ? "bg-accent/15 border-l-2 border-accent" : "hover:bg-white/5 border-l-2 border-transparent"
                }`}
              >
                <span className={`text-[10px] font-mono shrink-0 w-6 text-right ${
                  i === currentIdx ? "text-accent" : "text-white/30"
                }`}>
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className={`text-xs truncate ${i === currentIdx ? "text-white" : "text-white/60"}`}>{it.title}</p>
                  <p className="text-[9px] text-white/30 font-mono">{formatTs(it.timestamp)}{it.endTimestamp ? ` – ${formatTs(it.endTimestamp)}` : ""}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { data: session } = useSession();
  const [tab, setTab] = useState<Tab>("import");

  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [fetching, setFetching] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [playlistVideos, setPlaylistVideos] = useState<PlaylistVideo[]>([]);
  const [playlistSelected, setPlaylistSelected] = useState<Set<string>>(new Set());
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [playlistImporting, setPlaylistImporting] = useState(false);
  const [playlistImportProgress, setPlaylistImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());

  // ── Cliplist state ──
  const [cliplists, setCliplists] = useState<Cliplist[]>([]);
  const [cliplistsLoading, setCliplistsLoading] = useState(false);
  const [selectedCliplist, setSelectedCliplist] = useState<CliplistWithItems | null>(null);
  const [showCreateCliplist, setShowCreateCliplist] = useState(false);
  const [newCliplistName, setNewCliplistName] = useState("");
  const [newCliplistDesc, setNewCliplistDesc] = useState("");
  const [creatingCliplist, setCreatingCliplist] = useState(false);
  const [slideshowItems, setSlideshowItems] = useState<ClipItem[] | null>(null);

  // ── Settings state ──
  const [settings, setSettings] = useState<{ aiKeys: Record<string, string>; preferredProvider: string | null }>({ aiKeys: {}, preferredProvider: null });
  const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(new Set());
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; testing: boolean; error?: string }>>({});
  const settingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Folder state ──
  const [folderList, setFolderList] = useState<Array<{ id: number; name: string; videoCount: number; color?: string | null }>>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [folderVideos, setFolderVideos] = useState<Video[]>([]);
  const [folderVideosLoading, setFolderVideosLoading] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDropdown, setFolderDropdown] = useState<{ videoId: number; open: boolean }>({ videoId: -1, open: false });
  const [editingFolderId, setEditingFolderId] = useState<number | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<number>>(new Set());
  const [bulkFolderDropdown, setBulkFolderDropdown] = useState(false);

  // "Add to cliplist" dropdown per search result
  const [addToDropdown, setAddToDropdown] = useState<{ index: number; open: boolean }>({ index: -1, open: false });
  const addToRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const openIdx = addToDropdown.index;
      if (openIdx >= 0) {
        const ref = addToRefs.current.get(openIdx);
        if (ref && !ref.contains(e.target as Node)) {
          setAddToDropdown({ index: -1, open: false });
        }
      }
      // Close folder dropdown on outside click
      if (folderDropdown.open) {
        const target = e.target as HTMLElement;
        if (!target.closest("[data-folder-dropdown]")) {
          setFolderDropdown({ videoId: -1, open: false });
        }
      }
      // Close bulk folder dropdown on outside click
      if (bulkFolderDropdown) {
        const target = e.target as HTMLElement;
        if (!target.closest("[data-folder-dropdown]")) {
          setBulkFolderDropdown(false);
        }
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [addToDropdown.index, folderDropdown.open, bulkFolderDropdown]);

  const loadVideos = useCallback(async () => {
    try {
      const res = await fetch("/api/videos");
      if (res.ok) setVideos(await res.json());
    } finally {
      setFetching(false);
    }
  }, []);

  // ── Load folders ──
  const loadFolders = useCallback(async () => {
    try {
      const res = await fetch("/api/folders");
      if (res.ok) setFolderList(await res.json());
    } catch {}
  }, []);

  const loadFolderVideos = useCallback(async (folderId: number) => {
    setFolderVideosLoading(true);
    try {
      const res = await fetch(`/api/folders/${folderId}`);
      if (res.ok) {
        const data = await res.json();
        setFolderVideos(data.videos ?? []);
      }
    } finally {
      setFolderVideosLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVideos();  
    loadFolders(); // eslint-disable-line react-hooks/set-state-in-effect
  }, [loadVideos, loadFolders]);

  useEffect(() => {
    if (selectedFolderId !== null) {
      loadFolderVideos(selectedFolderId); // eslint-disable-line react-hooks/set-state-in-effect
    } else {
      setFolderVideos([]);  
    }
  }, [selectedFolderId, loadFolderVideos]);

  // ── Load cliplists ──
  const loadCliplists = useCallback(async () => {
    setCliplistsLoading(true);
    try {
      const res = await fetch("/api/cliplists");
      if (res.ok) setCliplists(await res.json());
    } finally {
      setCliplistsLoading(false);
    }
  }, []);

  // ── Load settings ──
  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        const keys = data.aiKeys ?? {};
        // API returns masked keys — extract which providers have keys configured
        const configured = new Set<string>();
        for (const [provider, masked] of Object.entries(keys)) {
          if (masked && masked !== "****" && typeof masked === "string" && masked.length > 0) {
            configured.add(provider);
          }
        }
        setConfiguredProviders(configured);
        // Don't populate inputs with masked keys — start empty
        setSettings({ aiKeys: {}, preferredProvider: data.preferredProvider ?? null });
      }
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const saveSettings = useCallback(async (newSettings: { aiKeys: Record<string, string>; preferredProvider: string | null }) => {
    setSettingsSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSettings),
      });
      if (res.ok) {
        const data = await res.json();
        const keys = data.aiKeys ?? {};
        const configured = new Set<string>();
        for (const [provider, masked] of Object.entries(keys)) {
          if (masked && masked !== "****" && typeof masked === "string" && masked.length > 0) {
            configured.add(provider);
          }
        }
        setConfiguredProviders(configured);
        setSettings({ aiKeys: {}, preferredProvider: data.preferredProvider ?? null });
      }
    } finally {
      setSettingsSaving(false);
    }
  }, []);

  const testProvider = useCallback(async (provider: string) => {
    setTestResults(prev => ({ ...prev, [provider]: { success: false, testing: true } }));
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [provider]: { success: data.success, testing: false, error: data.error } }));
      // If test failed, remove from configuredProviders (key is broken)
      if (!data.success) {
        setConfiguredProviders(prev => { const next = new Set(prev); next.delete(provider); return next; });
      }
    } catch {
      setTestResults(prev => ({ ...prev, [provider]: { success: false, testing: false, error: "Network error" } }));
    }
  }, []);

  // Load cliplists when switching to the cliplists tab
  const switchToTab = useCallback((newTab: Tab) => {
    setTab(newTab);
    if (newTab === "cliplists") loadCliplists();
    if (newTab === "settings") loadSettings();
  }, [loadCliplists, loadSettings]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setError(null);

    if (isPlaylistUrl(url.trim())) {
      await fetchPlaylist(url.trim());
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add video");
      }
      setUrl("");
      await loadVideos();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this video and all its annotations?")) return;
    await fetch(`/api/videos/${id}`, { method: "DELETE" });
    await loadVideos();
  }

  // ── Folder management ──
  async function createFolder() {
    if (!newFolderName.trim()) return;
    setCreatingFolder(true);
    try {
      await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newFolderName.trim() }),
      });
      setNewFolderName("");
      setShowCreateFolder(false);
      await loadFolders();
    } finally {
      setCreatingFolder(false);
    }
  }

  async function renameFolder(folderId: number) {
    if (!editingFolderName.trim()) return;
    await fetch(`/api/folders/${folderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editingFolderName.trim() }),
    });
    setEditingFolderId(null);
    await loadFolders();
  }

  async function deleteFolder(folderId: number) {
    if (!confirm("Delete this folder? Videos will not be deleted.")) return;
    await fetch(`/api/folders/${folderId}`, { method: "DELETE" });
    if (selectedFolderId === folderId) setSelectedFolderId(null);
    await loadFolders();
  }

  async function addVideoToFolder(folderId: number, videoId: number) {
    await fetch(`/api/folders/${folderId}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
    await loadFolders();
    if (selectedFolderId === folderId) await loadFolderVideos(folderId);
    setFolderDropdown({ videoId: -1, open: false });
  }

  async function removeVideoFromFolder(folderId: number, videoId: number) {
    await fetch(`/api/folders/${folderId}/videos`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
    await loadFolders();
    if (selectedFolderId === folderId) await loadFolderVideos(folderId);
    setFolderDropdown({ videoId: -1, open: false });
  }

  async function bulkAddToFolder(folderId: number) {
    const ids = Array.from(selectedVideoIds);
    for (const videoId of ids) {
      await fetch(`/api/folders/${folderId}/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });
    }
    setSelectedVideoIds(new Set());
    setBulkFolderDropdown(false);
    await loadFolders();
    if (selectedFolderId === folderId) await loadFolderVideos(folderId);
  }

  function toggleVideoSelection(videoId: number) {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  const currentVideoList = selectedFolderId !== null ? folderVideos : videos;
  const allSelected = currentVideoList.length > 0 && currentVideoList.every((v) => selectedVideoIds.has(v.id));

  async function fetchPlaylist(playlistUrl: string) {
    setPlaylistLoading(true);
    setPlaylistError(null);
    setPlaylistVideos([]);
    setPlaylistSelected(new Set());
    try {
      const [playlistRes, videosRes] = await Promise.all([
        fetch("/api/playlists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: playlistUrl }),
        }),
        fetch("/api/videos"),
      ]);
      if (!playlistRes.ok) {
        const data = await playlistRes.json();
        throw new Error(data.error || "Failed to fetch playlist");
      }
      const data = await playlistRes.json();
      const vids: PlaylistVideo[] = data.videos;

      const existing = videosRes.ok ? ((await videosRes.json()) as Video[]) : [];
      const existSet = new Set(existing.map((v) => v.youtubeId));
      setImportedIds(existSet);

      const newOnly = vids.filter((v) => !existSet.has(v.id));
      setPlaylistVideos(vids);
      setPlaylistSelected(new Set(newOnly.map((v) => v.id)));
    } catch (err) {
      setPlaylistError(err instanceof Error ? err.message : "Failed to fetch playlist");
    } finally {
      setPlaylistLoading(false);
    }
  }

  function togglePlaylistVideo(id: string) {
    setPlaylistSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const importable = playlistVideos.filter((v) => !importedIds.has(v.id));
    if (playlistSelected.size === importable.length) {
      setPlaylistSelected(new Set());
    } else {
      setPlaylistSelected(new Set(importable.map((v) => v.id)));
    }
  }

  function cancelPlaylist() {
    setPlaylistVideos([]);
    setPlaylistSelected(new Set());
    setPlaylistError(null);
    setImportedIds(new Set());
    setPlaylistImportProgress(null);
    setUrl("");
  }

  async function importSelectedVideos() {
    const toImport = playlistVideos.filter((v) => playlistSelected.has(v.id) && !importedIds.has(v.id));
    if (!toImport.length) return;
    setPlaylistImporting(true);
    setPlaylistImportProgress({ done: 0, total: toImport.length });
    try {
      const newImported = new Set(importedIds);
      for (let i = 0; i < toImport.length; i++) {
        const v = toImport[i];
        const res = await fetch("/api/videos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${v.id}` }),
        });
        if (res.ok) newImported.add(v.id);
        setPlaylistImportProgress({ done: i + 1, total: toImport.length });
      }
      setImportedIds(newImported);
      setPlaylistSelected(new Set());
      await loadVideos();
    } finally {
      setPlaylistImporting(false);
      setPlaylistImportProgress(null);
    }
  }

  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  function handleSearch(q: string) {
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (q.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.results);
        }
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  // ── Cliplist actions ──
  async function handleCreateCliplist(e: React.FormEvent) {
    e.preventDefault();
    if (!newCliplistName.trim()) return;
    setCreatingCliplist(true);
    try {
      const res = await fetch("/api/cliplists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCliplistName.trim(), description: newCliplistDesc.trim() || null }),
      });
      if (res.ok) {
        setNewCliplistName("");
        setNewCliplistDesc("");
        setShowCreateCliplist(false);
        await loadCliplists();
      }
    } finally {
      setCreatingCliplist(false);
    }
  }

  async function addToCliplist(cliplistId: number, result: SearchResult) {
    try {
      await fetch(`/api/cliplists/${cliplistId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: result.type,
          videoId: result.videoId,
          timestamp: result.timestamp,
          endTimestamp: result.endTimestamp,
          title: result.title,
          detail: result.detail,
          tags: result.tags,
        }),
      });
      setAddToDropdown({ index: -1, open: false });
      // Refresh cliplists if on that tab
      if (tab === "cliplists") loadCliplists();
    } catch {}
  }

  async function openCliplist(id: number) {
    try {
      const res = await fetch(`/api/cliplists/${id}`);
      if (res.ok) setSelectedCliplist(await res.json());
    } catch {}
  }

  async function deleteCliplist(id: number) {
    if (!confirm("Delete this cliplist and all its items?")) return;
    await fetch(`/api/cliplists/${id}`, { method: "DELETE" });
    if (selectedCliplist?.id === id) setSelectedCliplist(null);
    await loadCliplists();
  }

  async function removeClipItem(cliplistId: number, itemId: number) {
    await fetch(`/api/cliplists/${cliplistId}/items`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId }),
    });
    if (selectedCliplist?.id === cliplistId) {
      setSelectedCliplist((prev) => {
        if (!prev) return prev;
        return { ...prev, items: prev.items.filter((i) => i.id !== itemId) };
      });
    }
    await loadCliplists();
  }

  const playlistActive = playlistVideos.length > 0 || playlistLoading;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border px-6 py-4 shrink-0">
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">MARGINALIA: Vestigia</h1>
            <p className="text-sm text-muted">Import, annotate, and search video content</p>
          </div>
          {session?.user && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted">{session.user.name}</span>
              <button
                onClick={() => signOut({ callbackUrl: "/signin" })}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-5xl w-full px-6 pt-6">
        <nav className="flex gap-1 border-b border-border">
          {([
            { key: "import", label: "Import", icon: "+" },
            { key: "search", label: "Search", icon: "\u2315" },
            { key: "cliplists", label: "Cliplists", icon: "\ud83d\udccb" },
            { key: "settings", label: "Settings", icon: "\u2699\ufe0f" },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => switchToTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              <span className="mr-1.5">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="mx-auto max-w-5xl w-full px-6 py-6 flex-1 flex gap-6">
        {/* ── SIDEBAR: Folders ── */}
        <aside className="w-52 shrink-0">
          <div className="sticky top-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Folders</h2>
              <button
                onClick={() => setShowCreateFolder(true)}
                className="text-muted hover:text-accent transition-colors"
                title="New folder"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>

            <div className="space-y-0.5">
              {/* All Videos */}
              <button
                onClick={() => setSelectedFolderId(null)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  selectedFolderId === null
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-muted hover:text-foreground hover:bg-surface"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span>All Videos</span>
                  <span className="text-[10px] text-muted/60">{videos.length}</span>
                </div>
              </button>

              {/* Folder list */}
              {folderList.map((folder) => (
                <div key={folder.id} className="group">
                  {editingFolderId === folder.id ? (
                    <form
                      onSubmit={(e) => { e.preventDefault(); renameFolder(folder.id); }}
                      className="flex items-center gap-1"
                    >
                      <input
                        autoFocus
                        value={editingFolderName}
                        onChange={(e) => setEditingFolderName(e.target.value)}
                        onBlur={() => renameFolder(folder.id)}
                        className="flex-1 rounded px-2 py-1 text-sm bg-background border border-accent outline-none"
                      />
                    </form>
                  ) : (
                    <button
                      onClick={() => setSelectedFolderId(folder.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                        selectedFolderId === folder.id
                          ? "bg-accent/10 text-accent font-medium"
                          : "text-muted hover:text-foreground hover:bg-surface"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate">{folder.name}</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-muted/60">{folder.videoCount}</span>
                          <div className="hidden group-hover:flex items-center gap-0.5">
                            <span
                              onClick={(e) => { e.stopPropagation(); setEditingFolderId(folder.id); setEditingFolderName(folder.name); }}
                              className="text-muted hover:text-foreground cursor-pointer p-0.5"
                              title="Rename"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                            </span>
                            <span
                              onClick={(e) => { e.stopPropagation(); deleteFolder(folder.id); }}
                              className="text-muted hover:text-danger cursor-pointer p-0.5"
                              title="Delete"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </span>
                          </div>
                        </div>
                      </div>
                    </button>
                  )}
                </div>
              ))}

              {/* Create folder form */}
              {showCreateFolder && (
                <form
                  onSubmit={(e) => { e.preventDefault(); createFolder(); }}
                  className="flex items-center gap-1 mt-1"
                >
                  <input
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder="Folder name"
                    className="flex-1 rounded px-2 py-1 text-sm bg-background border border-border focus:border-accent outline-none"
                  />
                  <button
                    type="submit"
                    disabled={creatingFolder || !newFolderName.trim()}
                    className="text-accent disabled:opacity-30"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCreateFolder(false); setNewFolderName(""); }}
                    className="text-muted hover:text-foreground"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </form>
              )}
            </div>
          </div>
        </aside>

        {/* ── MAIN CONTENT ── */}
        <main className="flex-1 min-w-0">
        {/* ── IMPORT TAB ── */}
        {tab === "import" && (
          <div>
            <form onSubmit={handleSubmit} className="mb-6">
              <div className="flex gap-3">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste a YouTube URL or playlist link..."
                  className="flex-1 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  disabled={loading || playlistLoading}
                />
                <button
                  type="submit"
                  disabled={loading || playlistLoading || !url.trim()}
                  className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Adding..." : playlistLoading ? "Loading..." : "Import"}
                </button>
              </div>
              {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            </form>

            {/* ── INLINE PLAYLIST ── */}
            {playlistActive && (
              <div className="mb-6 rounded-lg border border-border bg-surface">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <h3 className="text-sm font-medium">
                    {playlistLoading
                      ? "Loading playlist..."
                      : importedIds.size > 0
                        ? `${playlistVideos.length} videos — ${importedIds.size} already imported, ${playlistVideos.length - importedIds.size} new`
                        : `${playlistVideos.length} videos in playlist`}
                  </h3>
                  <button onClick={cancelPlaylist} className="text-xs text-muted hover:text-foreground transition-colors">
                    Cancel
                  </button>
                </div>

                {playlistError && <p className="px-4 py-2 text-xs text-danger">{playlistError}</p>}

                {!playlistLoading && playlistVideos.length > 0 && (
                  <>
                    <div className="flex items-center justify-between px-4 py-2 border-b border-border/50">
                      <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
                        <input
                          type="checkbox"
                          checked={playlistSelected.size === playlistVideos.filter((v) => !importedIds.has(v.id)).length && playlistVideos.some((v) => !importedIds.has(v.id))}
                          onChange={toggleSelectAll}
                          className="rounded border-border accent-accent"
                        />
                        {playlistSelected.size}/{playlistVideos.filter((v) => !importedIds.has(v.id)).length} new selected
                      </label>
                      <button
                        onClick={importSelectedVideos}
                        disabled={playlistImporting || playlistSelected.size === 0}
                        className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {playlistImportProgress
                          ? `Importing ${playlistImportProgress.done}/${playlistImportProgress.total}...`
                          : playlistImporting
                            ? "Importing..."
                            : `Import ${playlistSelected.size} video${playlistSelected.size !== 1 ? "s" : ""}`}
                      </button>
                    </div>

                    <div className="max-h-96 overflow-y-auto divide-y divide-border/50">
                      {playlistVideos.map((v) => {
                        const alreadyImported = importedIds.has(v.id);
                        return (
                          <label
                            key={v.id}
                            className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${
                              alreadyImported
                                ? "opacity-50 cursor-default"
                                : playlistSelected.has(v.id)
                                  ? "bg-accent/5 cursor-pointer"
                                  : "hover:bg-surface-hover/50 cursor-pointer"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={playlistSelected.has(v.id)}
                              disabled={alreadyImported}
                              onChange={() => togglePlaylistVideo(v.id)}
                              className="rounded border-border accent-accent shrink-0"
                            />
                            <div className="relative w-24 h-14 shrink-0">
                              <Image
                                src={v.thumbnail}
                                alt={v.title}
                                fill
                                className="object-cover rounded"
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="text-xs text-foreground line-clamp-2">{v.title}</span>
                              {alreadyImported && (
                                <span className="inline-block mt-0.5 px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded">
                                  Imported
                                </span>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {fetching ? (
              <p className="text-center text-muted py-12">Loading videos...</p>
            ) : selectedFolderId !== null ? (
              folderVideosLoading ? (
                <p className="text-center text-muted py-12">Loading folder...</p>
              ) : folderVideos.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-16 text-center">
                  <p className="text-muted">No videos in this folder yet.</p>
                  <p className="text-xs text-muted/60 mt-1">Click the folder icon on a video card to add it.</p>
                </div>
              ) : (
                <>
                  {/* Select all bar */}
                  <div className="flex items-center justify-between mb-4">
                    <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => {
                          if (allSelected) setSelectedVideoIds(new Set());
                          else setSelectedVideoIds(new Set(currentVideoList.map((v) => v.id)));
                        }}
                        className="rounded border-border accent-accent"
                      />
                      {selectedVideoIds.size > 0
                        ? `${selectedVideoIds.size} selected`
                        : `Select all (${currentVideoList.length})`}
                    </label>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {folderVideos.map((video) => (
                    <Link
                      key={video.id}
                      href={`/video/${video.id}`}
                      className="group rounded-lg border border-border bg-surface hover:border-accent/50 transition-colors overflow-hidden"
                    >
                      {video.thumbnailUrl && (
                        <div className="aspect-video w-full overflow-hidden bg-muted relative">
                          <Image src={video.thumbnailUrl} alt={video.title ?? "Video"} fill className="object-cover group-hover:scale-105 transition-transform duration-300" />
                          <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleVideoSelection(video.id); }}
                            className="absolute top-2 left-2 w-5 h-5 rounded border border-white/40 bg-black/30 backdrop-blur-sm flex items-center justify-center transition-colors hover:bg-black/50"
                          >
                            {selectedVideoIds.has(video.id) && (
                              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                        </div>
                      )}
                      <div className="p-3 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="text-sm font-medium line-clamp-2">{video.title ?? "Untitled"}</h3>
                          <div className="flex items-center gap-2 mt-1">
                            {(video.momentCount ?? 0) > 0 && (
                              <span className="shrink-0 text-[9px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded flex items-center gap-0.5" title={`${video.momentCount} key moment${video.momentCount !== 1 ? "s" : ""}`}>
                                <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
                                {video.momentCount}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-0.5">
                          {/* Remove from folder */}
                          {selectedFolderId !== null && (
                            <button
                              onClick={(e) => { e.preventDefault(); removeVideoFromFolder(selectedFolderId, video.id); }}
                              className="text-muted hover:text-accent transition-colors p-1 rounded"
                              title="Remove from folder"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                              </svg>
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.preventDefault(); handleDelete(video.id); }}
                            className="text-muted hover:text-danger transition-colors p-1 rounded"
                            title="Delete"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
                </>
              )
            ) : videos.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-16 text-center">
                <p className="text-muted">No videos yet. Paste a YouTube URL above to get started.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        if (allSelected) setSelectedVideoIds(new Set());
                        else setSelectedVideoIds(new Set(currentVideoList.map((v) => v.id)));
                      }}
                      className="rounded border-border accent-accent"
                    />
                    {selectedVideoIds.size > 0
                      ? `${selectedVideoIds.size} selected`
                      : `Select all (${currentVideoList.length})`}
                  </label>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {videos.map((video) => (
                  <Link
                    key={video.id}
                    href={`/video/${video.id}`}
                    className="group rounded-lg border border-border bg-surface hover:border-accent/50 transition-colors overflow-hidden"
                  >
                    {video.thumbnailUrl && (
                      <div className="aspect-video w-full overflow-hidden bg-muted relative">
                        <Image
                          src={video.thumbnailUrl}
                          alt={video.title ?? "Video"}
                          fill
                          className="object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleVideoSelection(video.id); }}
                          className="absolute top-2 left-2 w-5 h-5 rounded border border-white/40 bg-black/30 backdrop-blur-sm flex items-center justify-center transition-colors hover:bg-black/50"
                        >
                          {selectedVideoIds.has(video.id) && (
                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      </div>
                    )}
                    <div className="p-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium line-clamp-2">{video.title ?? "Untitled"}</h3>
                        <div className="flex items-center gap-2 mt-1">
                          {(video.momentCount ?? 0) > 0 && (
                            <span className="shrink-0 text-[9px] font-medium text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded flex items-center gap-0.5" title={`${video.momentCount} key moment${video.momentCount !== 1 ? "s" : ""}`}>
                              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
                              {video.momentCount}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5">
                        {/* Folder button */}
                        {folderList.length > 0 && (
                          <div className="relative" data-folder-dropdown>
                            <button
                              onClick={(e) => { e.preventDefault(); setFolderDropdown({ videoId: video.id, open: folderDropdown.videoId === video.id ? !folderDropdown.open : true }); }}
                              className="text-muted hover:text-accent transition-colors p-1 rounded"
                              title="Add to folder"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                              </svg>
                            </button>
                            {folderDropdown.open && folderDropdown.videoId === video.id && (
                              <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-border bg-surface shadow-xl z-50 py-1">
                                <div className="px-3 py-1.5 text-[10px] text-muted/60 font-medium uppercase tracking-wider">Add to folder</div>
                                {folderList.map((folder) => (
                                  <button
                                    key={folder.id}
                                    onClick={(e) => { e.preventDefault(); addVideoToFolder(folder.id, video.id); }}
                                    className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-accent/10 transition-colors"
                                  >
                                    {folder.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        <button
                          onClick={(e) => { e.preventDefault(); handleDelete(video.id); }}
                          className="text-muted hover:text-danger transition-colors p-1 rounded"
                          title="Delete"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </Link>
                ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── BULK ACTION BAR ── */}
        {selectedVideoIds.size > 0 && (tab === "import" || tab === "cliplists") && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-xl border border-border bg-surface shadow-2xl px-5 py-3 flex items-center gap-4">
            <span className="text-sm font-medium">{selectedVideoIds.size} video{selectedVideoIds.size !== 1 ? "s" : ""} selected</span>
            <div className="relative" data-folder-dropdown>
              <button
                onClick={() => setBulkFolderDropdown(!bulkFolderDropdown)}
                className="text-sm px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors"
              >
                Add to folder
              </button>
              {bulkFolderDropdown && (
                <div className="absolute bottom-full mb-2 left-0 w-48 rounded-lg border border-border bg-surface shadow-xl z-50 py-1">
                  <div className="px-3 py-1.5 text-[10px] text-muted/60 font-medium uppercase tracking-wider">Select folder</div>
                  {folderList.map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() => bulkAddToFolder(folder.id)}
                      className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-accent/10 transition-colors"
                    >
                      {folder.name}
                    </button>
                  ))}
                  {folderList.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted">No folders yet</div>
                  )}
                </div>
              )}
            </div>
            <button
              onClick={() => setSelectedVideoIds(new Set())}
              className="text-sm text-muted hover:text-foreground transition-colors"
            >
              Deselect all
            </button>
          </div>
        )}

        {/* ── SEARCH TAB ── */}
        {tab === "search" && (
          <div>
            <div className="relative mb-6">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search annotations, scenes, key moments..."
                autoFocus
                className="w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {searching && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                </div>
              )}
            </div>

            {searchQuery.length >= 2 && !searching && searchResults.length === 0 && (
              <p className="text-sm text-muted text-center py-8">No results found</p>
            )}

            {searchResults.length > 0 && (
              <div className="space-y-2">
                {searchResults.map((r, i) => (
                  <div key={i} className="group relative flex items-center gap-4 p-3 rounded-lg border border-border bg-surface hover:border-accent/50 transition-colors">
                    <Link
                      href={`/video/${r.videoId}#t=${Math.floor(r.timestamp)}`}
                      className="flex items-center gap-4 flex-1 min-w-0"
                    >
                      {r.videoThumbnail && (
                        <div className="relative shrink-0 w-28 h-16">
                          <Image src={r.videoThumbnail} alt="" fill className="object-cover rounded" />
                          <span className="absolute bottom-1 right-1 text-[10px] bg-black/75 text-white px-1 py-0.5 rounded">
                            {formatTs(r.timestamp)}
                          </span>
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                            {r.type.replace("_", " ")}
                          </span>
                          <span className="text-sm font-medium truncate">{highlight(r.title, searchQuery)}</span>
                        </div>
                        {r.detail && (
                          <p className="text-xs text-muted mt-0.5 line-clamp-1">{highlight(r.detail, searchQuery)}</p>
                        )}
                        {r.tags && r.tags.length > 0 && (
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {r.tags.slice(0, 4).map((tag) => (
                              <span key={tag} className="text-[10px] bg-surface-hover rounded px-1.5 py-0.5">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-muted shrink-0 truncate max-w-[160px]">
                        {r.videoTitle}
                      </p>
                    </Link>

                    {/* Add to cliplist button */}
                    <div ref={(el) => { if (el) addToRefs.current.set(i, el); else addToRefs.current.delete(i); }} className="relative shrink-0">
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // Load cliplists if not loaded
                          if (cliplists.length === 0) {
                            fetch("/api/cliplists").then((res) => res.ok && res.json()).then((data) => setCliplists(data));
                          }
                          setAddToDropdown({ index: i, open: addToDropdown.index === i ? !addToDropdown.open : true });
                        }}
                        className="p-1.5 rounded text-muted hover:text-accent hover:bg-accent/10 transition-all opacity-0 group-hover:opacity-100"
                        title="Add to cliplist"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                        </svg>
                      </button>

                      {addToDropdown.open && addToDropdown.index === i && (
                        <div className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-border bg-surface shadow-xl z-50 py-1 max-h-60 overflow-y-auto">
                          <div className="px-3 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider">
                            Add to cliplist
                          </div>
                          {cliplists.length === 0 ? (
                            <div className="px-3 py-2 text-[10px] text-muted">No cliplists yet</div>
                          ) : (
                            cliplists.map((cl) => (
                              <button
                                key={cl.id}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  addToCliplist(cl.id, r);
                                }}
                                className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-hover transition-colors flex items-center justify-between"
                              >
                                <span className="truncate">{cl.name}</span>
                                <span className="text-[9px] text-muted shrink-0 ml-2">{cl.itemCount}</span>
                              </button>
                            ))
                          )}
                          <div className="border-t border-border/50 mt-1 pt-1">
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setShowCreateCliplist(true);
                                setAddToDropdown({ index: -1, open: false });
                              }}
                              className="w-full text-left px-3 py-1.5 text-xs text-accent hover:bg-accent/10 transition-colors"
                            >
                              + New cliplist
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── CLIPLISTS TAB ── */}
        {tab === "cliplists" && (
          <div>
            {/* Header + Create button */}
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-sm font-semibold text-muted uppercase tracking-wider">
                {cliplistsLoading ? "Loading..." : `${cliplists.length} cliplist${cliplists.length !== 1 ? "s" : ""}`}
              </h2>
              <button
                onClick={() => setShowCreateCliplist(true)}
                className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-all flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                New Cliplist
              </button>
            </div>

            {/* Create cliplist form */}
            {showCreateCliplist && (
              <div className="mb-6 rounded-xl border border-accent/30 bg-surface p-4 shadow-sm">
                <form onSubmit={handleCreateCliplist}>
                  <input
                    type="text"
                    value={newCliplistName}
                    onChange={(e) => setNewCliplistName(e.target.value)}
                    placeholder="Cliplist name"
                    autoFocus
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:ring-1 focus:ring-accent/20 outline-none mb-2"
                  />
                  <input
                    type="text"
                    value={newCliplistDesc}
                    onChange={(e) => setNewCliplistDesc(e.target.value)}
                    placeholder="Description (optional)"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:ring-1 focus:ring-accent/20 outline-none mb-3"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={creatingCliplist || !newCliplistName.trim()}
                      className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-all"
                    >
                      {creatingCliplist ? "Creating..." : "Create"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowCreateCliplist(false); setNewCliplistName(""); setNewCliplistDesc(""); }}
                      className="rounded-lg border border-border px-4 py-1.5 text-xs text-muted hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}

            {cliplistsLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              </div>
            ) : cliplists.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-16 text-center">
                <p className="text-muted text-sm">No cliplists yet.</p>
                <p className="text-xs text-muted/60 mt-1">Create one to start saving search results.</p>
              </div>
            ) : selectedCliplist ? (
              /* ── Single cliplist view ── */
              <div>
                <button
                  onClick={() => setSelectedCliplist(null)}
                  className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-colors mb-4"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  Back to all cliplists
                </button>

                <div className="rounded-xl border border-border bg-surface overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <div>
                      <h3 className="text-sm font-semibold">{selectedCliplist.name}</h3>
                      {selectedCliplist.description && (
                        <p className="text-[10px] text-muted mt-0.5">{selectedCliplist.description}</p>
                      )}
                      <p className="text-[10px] text-muted/50 mt-0.5">{selectedCliplist.items.length} item{selectedCliplist.items.length !== 1 ? "s" : ""}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedCliplist.items.length > 0 && (
                        <button
                          onClick={() => setSlideshowItems(selectedCliplist.items)}
                          className="rounded-lg bg-accent px-3 py-1.5 text-[10px] font-medium text-white hover:bg-accent-hover active:scale-95 transition-all flex items-center gap-1.5"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          Play
                        </button>
                      )}
                      <button
                        onClick={() => deleteCliplist(selectedCliplist.id)}
                        className="text-xs text-danger/60 hover:text-danger transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {selectedCliplist.items.length === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-muted">No items in this cliplist</div>
                  ) : (
                    <div className="divide-y divide-border/50 max-h-[60vh] overflow-y-auto">
                      {selectedCliplist.items.map((item) => (
                        <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover/50 transition-colors group/item">
                          {item.videoThumbnail && (
                            <div className="relative shrink-0 w-20 h-12">
                              <Image src={item.videoThumbnail} alt="" fill className="object-cover rounded" />
                              <span className="absolute bottom-0.5 right-0.5 text-[8px] bg-black/75 text-white px-0.5 rounded">
                                {formatTs(item.timestamp)}
                              </span>
                            </div>
                          )}
                          <Link
                            href={`/video/${item.videoId}#t=${Math.floor(item.timestamp)}`}
                            className="min-w-0 flex-1"
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] uppercase font-medium text-accent bg-accent/10 px-1 py-0.5 rounded shrink-0">
                                {item.type.replace("_", " ")}
                              </span>
                              <span className="text-xs font-medium truncate">{item.title}</span>
                            </div>
                            {item.detail && (
                              <p className="text-[10px] text-muted mt-0.5 line-clamp-1">{item.detail}</p>
                            )}
                            {item.videoTitle && (
                              <p className="text-[9px] text-muted/50 mt-0.5 truncate">{item.videoTitle}</p>
                            )}
                          </Link>
                          <button
                            onClick={() => removeClipItem(selectedCliplist.id, item.id)}
                            className="p-1 rounded text-muted/40 hover:text-danger hover:bg-danger/10 transition-all opacity-0 group-hover/item:opacity-100"
                            title="Remove from cliplist"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* ── Cliplist grid ── */
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {cliplists.map((cl) => (
                  <button
                    key={cl.id}
                    onClick={() => openCliplist(cl.id)}
                    className="group rounded-xl border border-border bg-surface hover:border-accent/50 hover:bg-surface-hover/30 transition-all text-left p-4"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold truncate group-hover:text-accent transition-colors">{cl.name}</h3>
                        {cl.description && (
                          <p className="text-[10px] text-muted mt-0.5 line-clamp-2">{cl.description}</p>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-muted/50 shrink-0 mt-0.5">{cl.itemCount}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-3 text-[9px] text-muted/40">
                      <span>{new Date(cl.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── SETTINGS TAB ── */}
        {tab === "settings" && (
          <div>
            {!session ? (
              <div className="rounded-lg border border-dashed border-border py-16 text-center">
                <p className="text-muted text-sm">Sign in to manage your API keys.</p>
                <a href="/signin" className="text-xs text-accent hover:text-accent-hover mt-2 inline-block transition-colors">
                  Sign in with Google
                </a>
              </div>
            ) : settingsLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              </div>
            ) : (
              <div className="space-y-6">
                {/* Header */}
                <div>
                  <h2 className="text-sm font-semibold text-muted uppercase tracking-wider">AI Providers</h2>
                  <p className="text-xs text-muted/60 mt-1">
                    Add your own API keys to use your own quota. Keys are stored encrypted and never shared.
                  </p>
                </div>

                {/* Provider cards */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    { id: "groq", name: "Groq", model: "Llama 3.3 70B", color: "bg-purple-500", keyPrefix: "gsk_", free: true },
                    { id: "mistral", name: "Mistral", model: "Mistral Small 4", color: "bg-orange-400", keyPrefix: "jUX", free: true },
                    { id: "openrouter", name: "OpenRouter", model: "Nemotron Ultra", color: "bg-cyan-500", keyPrefix: "sk-or-", free: true },
                    { id: "gemini", name: "Google Gemini", model: "Gemini 2.5 Flash", color: "bg-blue-500", keyPrefix: "AIza", free: true },
                    { id: "cerebras", name: "Cerebras", model: "Gemma 4 31B", color: "bg-pink-500", keyPrefix: "csk-", free: true },
                    { id: "github", name: "GitHub Models", model: "GPT-4o", color: "bg-gray-500", keyPrefix: "ghp_", free: true },
                    { id: "anthropic", name: "Anthropic", model: "Claude Sonnet 4", color: "bg-orange-600", keyPrefix: "sk-ant-" },
                    { id: "openai", name: "OpenAI", model: "GPT-4.1", color: "bg-emerald-500", keyPrefix: "sk-" },
                  ].map((p) => {
                    const isConfigured = configuredProviders.has(p.id);
                    const isPreferred = settings.preferredProvider === p.id;
                    const test = testResults[p.id];
                    const inputValue = settings.aiKeys[p.id] ?? "";

                    return (
                      <div
                        key={p.id}
                        className={`rounded-xl border bg-surface p-4 transition-all ${
                          isPreferred ? "border-accent/50 ring-1 ring-accent/20" : "border-border"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <div className={`w-3 h-3 rounded-full ${p.color}`} />
                            <div>
                              <div className="flex items-center gap-1.5">
                                <h3 className="text-sm font-semibold">{p.name}</h3>
                                {p.free && (
                                  <span className="text-[9px] font-medium text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">Free</span>
                                )}
                              </div>
                              <p className="text-[10px] text-muted/60">{p.model}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {isConfigured && (
                              <button
                                onClick={() => {
                                  const newKeys = { ...settings.aiKeys };
                                  delete newKeys[p.id];
                                  const newSettings = { ...settings, aiKeys: newKeys };
                                  setSettings(newSettings);
                                  setConfiguredProviders(prev => { const next = new Set(prev); next.delete(p.id); return next; });
                                  saveSettings(newSettings);
                                }}
                                className="text-[10px] text-danger/60 hover:text-danger transition-colors"
                                title="Remove key"
                              >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            )}
                            <button
                              onClick={() => {
                                saveSettings({
                                  ...settings,
                                  preferredProvider: isPreferred ? null : p.id,
                                });
                              }}
                              className={`p-1 rounded transition-colors ${
                                isPreferred
                                  ? "text-accent bg-accent/10"
                                  : "text-muted/40 hover:text-accent hover:bg-accent/5"
                              }`}
                              title={isPreferred ? "Preferred (click to unset)" : "Set as preferred"}
                            >
                              <svg className="w-3.5 h-3.5" fill={isPreferred ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                              </svg>
                            </button>
                          </div>
                        </div>

                        {/* API Key input */}
                        <div className="space-y-2">
                          <div className="relative">
                            <input
                              type="password"
                              value={inputValue}
                              onChange={(e) => {
                                const newKeys = { ...settings.aiKeys, [p.id]: e.target.value };
                                const newSettings = { ...settings, aiKeys: newKeys };
                                setSettings(newSettings);
                                // Debounced save
                                if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
                                settingsSaveTimerRef.current = setTimeout(() => {
                                  // If input is empty, remove the key
                                  if (!e.target.value.trim()) {
                                    const cleaned = { ...newSettings.aiKeys };
                                    delete cleaned[p.id];
                                    const cleanedSettings = { ...newSettings, aiKeys: cleaned };
                                    setSettings(cleanedSettings);
                                    setConfiguredProviders(prev => { const next = new Set(prev); next.delete(p.id); return next; });
                                    saveSettings(cleanedSettings);
                                  } else {
                                    saveSettings(newSettings);
                                  }
                                }, 800);
                              }}
                              placeholder={isConfigured ? "Key saved — enter new key to replace" : `Enter ${p.name} API key (${p.keyPrefix}...)`}
                              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono focus:border-accent focus:ring-1 focus:ring-accent/20 outline-none transition-all"
                            />
                          </div>

                          {/* Test button + result */}
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => testProvider(p.id)}
                              disabled={!isConfigured || test?.testing}
                              className="rounded-lg border border-border px-2.5 py-1 text-[10px] font-medium text-muted hover:text-foreground hover:border-accent/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                              {test?.testing ? "Testing..." : "Test"}
                            </button>
                            {test && !test.testing && (
                              <span className={`text-[10px] font-medium ${test.success ? "text-emerald-500" : "text-danger"}`}>
                                {test.success ? "Connected" : "Failed"}
                              </span>
                            )}
                            {isConfigured && !test && (
                              <span className="text-[10px] text-emerald-500/60 font-medium">Configured</span>
                            )}
                          </div>
                          {/* Warning banner when test fails */}
                          {test && !test.testing && !test.success && (
                            <div className="mt-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2">
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-[10px] text-danger/80 leading-relaxed">
                                  {test.error?.slice(0, 80) ?? "Connection failed"} &mdash; this key won&#39;t be used for AI calls.
                                </p>
                                <button
                                  onClick={() => {
                                    const newKeys = { ...settings.aiKeys };
                                    delete newKeys[p.id];
                                    const newSettings = { ...settings, aiKeys: newKeys };
                                    setSettings(newSettings);
                                    setConfiguredProviders(prev => { const next = new Set(prev); next.delete(p.id); return next; });
                                    setTestResults(prev => { const next = { ...prev }; delete next[p.id]; return next; });
                                    saveSettings(newSettings);
                                  }}
                                  className="shrink-0 text-[10px] text-danger/60 hover:text-danger font-medium transition-colors"
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Status bar */}
                <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-muted">
                      {configuredProviders.size} provider{configuredProviders.size !== 1 ? "s" : ""} configured
                    </span>
                    {settings.preferredProvider && (
                      <span className="text-[10px] text-accent font-medium">
                        Preferred: {settings.preferredProvider}
                      </span>
                    )}
                    {settingsSaving && (
                      <span className="text-[10px] text-muted/50 animate-pulse">Saving...</span>
                    )}
                  </div>
                  {configuredProviders.size > 0 && (
                    <button
                      onClick={() => {
                        if (confirm("Remove all API keys?")) {
                          setConfiguredProviders(new Set());
                          saveSettings({ aiKeys: {}, preferredProvider: null });
                        }
                      }}
                      className="text-[10px] text-danger/60 hover:text-danger transition-colors"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
      </div>

      {/* ── Video Playlist overlay ── */}
      {slideshowItems && (
        <VideoPlaylistPlayer items={slideshowItems} onClose={() => setSlideshowItems(null)} />
      )}
    </div>
  );
}
