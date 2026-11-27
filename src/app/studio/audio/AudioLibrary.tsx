"use client";

// Audio library: browse, filter, sort, preview and manage sound assets.
//
// Previews play in the Studio player through the AUTHORIZED
// /api/audio-assets/<id>/preview route — never a storage URL. Every rule
// (who sees what, who may archive) is server-side; this surface presents it.
//
// Metadata is shown exactly as stored. A field an asset does not carry reads
// "not set"; it is never hidden and never guessed. Energy and BPM can come
// from two stored places, and the row says which: the reviewed cue metadata
// (verified or suggested), or the asset's own `energy:` / `bpm:` tags.

import { useMemo, useRef, useState, useTransition } from "react";
import type { SafeAudioAssetDto } from "@/lib/services/audioAssetAccess";
import { parseAssetMetadata } from "@/lib/audio/assetMetadata";
import { archiveMyAudioAsset, restoreMyAudioAsset, uploadMyAudioAsset, type AssetMetaDto } from "./actions";
import { useStudioAudio } from "../StudioAudio";
import { Icon } from "../StudioIcons";

type Filter = "all" | "mine" | "system" | "archived" | "needs_rights" | "failed";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  mine: "My Library",
  system: "System Library",
  archived: "Archived",
  needs_rights: "Needs Rights Review",
  failed: "Failed",
};

const KINDS = ["theme_intro", "theme_outro", "bed", "stinger", "sfx", "highlight"];
const KIND_LABELS: Record<string, string> = {
  theme_intro: "Intro theme",
  theme_outro: "Outro theme",
  bed: "Music bed",
  stinger: "Stinger",
  sfx: "Reaction SFX",
  highlight: "Highlight",
};
const SFX_CATEGORIES = ["laugh", "crowd", "airhorn", "buzzer", "rimshot", "whoosh", "impact"];
const NEEDS_RIGHTS = ["pending", "rejected", "expired", "revoked"];

const DURATIONS = [
  { key: "lt5", label: "Under 5s", test: (ms: number) => ms < 5_000 },
  { key: "5to30", label: "5s to 30s", test: (ms: number) => ms >= 5_000 && ms < 30_000 },
  { key: "30to120", label: "30s to 2m", test: (ms: number) => ms >= 30_000 && ms < 120_000 },
  { key: "gt120", label: "Over 2m", test: (ms: number) => ms >= 120_000 },
];
const BPMS = [
  { key: "lt100", label: "Under 100", test: (n: number) => n < 100 },
  { key: "100to119", label: "100 to 119", test: (n: number) => n >= 100 && n < 120 },
  { key: "120to134", label: "120 to 134", test: (n: number) => n >= 120 && n < 135 },
  { key: "gte135", label: "135 and over", test: (n: number) => n >= 135 },
];
const SORTS = [
  { key: "type", label: "Type, then name" },
  { key: "name", label: "Name" },
  { key: "newest", label: "Newest first" },
  { key: "shortest", label: "Shortest first" },
  { key: "longest", label: "Longest first" },
  { key: "bpm", label: "BPM, slowest first" },
  { key: "used", label: "Most used by you" },
];
const NOT_SET = "__not_set";
// ponytail: the whole accessible library arrives in one read (as it did
// before) and is filtered in the browser; rows are revealed 40 at a time so
// the DOM stays small. Upgrade path if a library outgrows one read: move the
// filters into listAccessibleAudioAssets and page on the server.
const PAGE = 40;

function fmtDuration(ms: number | null): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  if (s < 1) return `${ms}ms`;
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const uniq = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));

export default function AudioLibrary(props: {
  initialAssets: SafeAudioAssetDto[];
  podcasts: Array<{ id: string; name: string }>;
  usage: Record<string, number>;
  meta: Record<string, AssetMetaDto>;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [energy, setEnergy] = useState("");
  const [genre, setGenre] = useState("");
  const [mood, setMood] = useState("");
  const [bpm, setBpm] = useState("");
  const [duration, setDuration] = useState("");
  const [source, setSource] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [sort, setSort] = useState("type");
  const [shown, setShown] = useState(PAGE);
  const [status, setStatus] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [uploadScope, setUploadScope] = useState<"owner_private" | "podcast_private">("owner_private");
  const [uploadKind, setUploadKind] = useState("stinger");
  const player = useStudioAudio();

  // One view-model per asset: the DTO plus its stored metadata, resolved once.
  const rows = useMemo(() => props.initialAssets.map((a) => {
    const cue = props.meta[a.id];
    const hasCue = !!cue && cue.state !== "unclassified";
    const tags = parseAssetMetadata({ name: a.name, kind: a.kind, category: a.category, tags: a.tags });
    const cueLabel = cue?.state === "verified" ? "verified" : "suggested";
    const energyValue = (hasCue && cue.energy) || tags.energyFamily || null;
    const bpmValue = (hasCue && cue.bpm) || tags.bpm || null;
    const fields = {
      energy: energyValue,
      energyFrom: energyValue ? (hasCue && cue.energy ? cueLabel : "tag") : null,
      bpm: bpmValue,
      bpmFrom: bpmValue ? (hasCue && cue.bpm ? cueLabel : "tag") : null,
      genre: (hasCue && cue.genre) || null,
      moods: hasCue ? cue.moods : [],
      source: cue?.source ?? null,
    };
    const missing = [
      !a.durationMs && "duration",
      !fields.energy && "energy",
      !fields.bpm && "BPM",
      !fields.genre && "genre",
      fields.moods.length === 0 && "mood",
    ].filter(Boolean) as string[];
    return { a, ...fields, cueState: cue?.state ?? "unclassified", cueLabel, missing, used: props.usage[a.id] ?? 0 };
  }), [props.initialAssets, props.meta, props.usage]);

  const inScope = useMemo(() => {
    switch (filter) {
      case "mine": return rows.filter(({ a }) => (a.scope === "owner_private" || a.scope === "podcast_private") && !a.isArchived);
      case "system": return rows.filter(({ a }) => a.scope === "shared_system" && !a.isArchived);
      case "archived": return rows.filter(({ a }) => a.isArchived);
      case "needs_rights": return rows.filter(({ a }) => NEEDS_RIGHTS.includes(a.rightsStatus) || a.legacyScopeReviewRequired);
      case "failed": return rows.filter(({ a }) => a.processingStatus === "failed");
      default: return rows.filter(({ a }) => !a.isArchived);
    }
  }, [rows, filter]);

  // Filter options are the values that actually occur in this library.
  const options = useMemo(() => ({
    energy: uniq(rows.map((r) => r.energy)),
    genre: uniq(rows.map((r) => r.genre)),
    mood: uniq(rows.flatMap((r) => r.moods)),
    source: uniq(rows.map((r) => r.source)),
  }), [rows]);

  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const { a } of inScope) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    return counts;
  }, [inScope]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pick = <T,>(value: T | null, wanted: string, match: (v: T) => boolean) =>
      !wanted || (wanted === NOT_SET ? value == null : value != null && match(value));
    const list = inScope.filter((r) =>
      (!kind || r.a.kind === kind) &&
      (!needle || [r.a.name, r.a.category ?? "", KIND_LABELS[r.a.kind] ?? r.a.kind, ...r.a.tags, ...r.moods, r.genre ?? ""].some((s) => s.toLowerCase().includes(needle))) &&
      pick(r.energy, energy, (v) => v === energy) &&
      pick(r.genre, genre, (v) => v === genre) &&
      (!mood || (mood === NOT_SET ? r.moods.length === 0 : r.moods.includes(mood))) &&
      pick(r.bpm, bpm, (v) => !!BPMS.find((b) => b.key === bpm)?.test(v)) &&
      pick(r.a.durationMs || null, duration, (v) => !!DURATIONS.find((d) => d.key === duration)?.test(v)) &&
      (!source || r.source === source) &&
      (!missingOnly || r.missing.length > 0)
    );
    const byName = (x: typeof list[number], y: typeof list[number]) => x.a.name.localeCompare(y.a.name);
    // Rows without the sorted value go last, whichever direction.
    const num = (get: (r: typeof list[number]) => number | null, dir: 1 | -1) => (x: typeof list[number], y: typeof list[number]) => {
      const a = get(x), b = get(y);
      if (a == null || b == null) return a == null ? (b == null ? byName(x, y) : 1) : -1;
      return (a - b) * dir || byName(x, y);
    };
    const sorters: Record<string, (x: typeof list[number], y: typeof list[number]) => number> = {
      type: (x, y) => KINDS.indexOf(x.a.kind) - KINDS.indexOf(y.a.kind) || byName(x, y),
      name: byName,
      newest: (x, y) => y.a.createdAt.localeCompare(x.a.createdAt),
      shortest: num((r) => r.a.durationMs || null, 1),
      longest: num((r) => r.a.durationMs || null, -1),
      bpm: num((r) => r.bpm, 1),
      used: (x, y) => y.used - x.used || byName(x, y),
    };
    return [...list].sort(sorters[sort] ?? sorters.type);
  }, [inScope, kind, q, energy, genre, mood, bpm, duration, source, missingOnly, sort]);

  const filtersOn = !!(kind || q || energy || genre || mood || bpm || duration || source || missingOnly);
  const clearFilters = () => {
    setKind(""); setQ(""); setEnergy(""); setGenre(""); setMood(""); setBpm(""); setDuration(""); setSource(""); setMissingOnly(false); setShown(PAGE);
  };
  // Any change to what is listed starts again from the first page of rows.
  const narrow = <T,>(set: (v: T) => void) => (v: T) => { set(v); setShown(PAGE); };

  const onUpload = (formData: FormData) => {
    setStatus("Uploading and validating…");
    startTransition(async () => {
      const res = await uploadMyAudioAsset(formData);
      if (res.success) {
        setStatus("Upload complete — the asset is ready.");
        formRef.current?.reset();
      } else {
        setStatus(res.error ?? "Upload failed.");
      }
    });
  };

  const select = (label: string, value: string, onChange: (v: string) => void, opts: { value: string; label: string }[], withNotSet = true) => (
    <label>
      {label}
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {withNotSet && <option value={NOT_SET}>Not set</option>}
      </select>
    </label>
  );

  const page = visible.slice(0, shown);

  return (
    <div data-testid="audio-library" className="mam">
      <div className="mamMain">
        {/* Screen-reader-visible processing/status line; also visible text. */}
        <p aria-live="polite" role="status" data-testid="library-status" className="alStatus">
          {pending ? "Working…" : status}
        </p>

        <nav aria-label="Library filters" className="alChipRow">
          {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => { setFilter(f); setShown(PAGE); }}
              aria-pressed={filter === f}
              data-testid={`filter-${f}`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
          <a href="#audio-upload" className="mamJump">Upload audio</a>
        </nav>

        <div className="mamTypes" role="group" aria-label="Asset type">
          <button type="button" aria-pressed={kind === ""} onClick={() => narrow(setKind)("")}>
            All types <span className="mamCount">{inScope.length}</span>
          </button>
          {KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => narrow(setKind)(k)}>
              {KIND_LABELS[k]} <span className="mamCount">{kindCounts[k] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="mamFilters" role="search" aria-label="Search and filter assets">
          <label className="mamSearch">
            Search
            <input className="input" type="search" value={q} onChange={(e) => narrow(setQ)(e.target.value)} placeholder="Name, tag, mood or genre" />
          </label>
          {select("Energy", energy, narrow(setEnergy), options.energy.map((v) => ({ value: v, label: v })))}
          {select("BPM", bpm, narrow(setBpm), BPMS.map((b) => ({ value: b.key, label: b.label })))}
          {select("Genre", genre, narrow(setGenre), options.genre.map((v) => ({ value: v, label: v })))}
          {select("Mood", mood, narrow(setMood), options.mood.map((v) => ({ value: v, label: v })))}
          {select("Duration", duration, narrow(setDuration), DURATIONS.map((d) => ({ value: d.key, label: d.label })))}
          {select("Source", source, narrow(setSource), options.source.map((v) => ({ value: v, label: v })), false)}
          <label>
            Sort by
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="mamCheck">
            <input type="checkbox" checked={missingOnly} onChange={(e) => narrow(setMissingOnly)(e.target.checked)} />
            Only assets missing metadata
          </label>
        </div>

        <p className="mamSummary">
          {visible.length.toLocaleString()} of {inScope.length.toLocaleString()} asset{inScope.length === 1 ? "" : "s"}
          {filtersOn && <> · <button type="button" className="mamLink" onClick={clearFilters}>Clear filters</button></>}
        </p>

        {/* A list, not a table: nothing scrolls sideways, every control is a
            native button in tab order, and each row restacks on a phone. */}
        <ul className="mamList" data-testid="asset-table" aria-label="Audio assets">
          {visible.length === 0 && (
            <li className="mamEmpty" data-testid="empty-state">
              {filtersOn ? "No asset matches these filters." : "Nothing here yet."}
            </li>
          )}
          {page.map(({ a, energy: e, energyFrom, bpm: b, bpmFrom, genre: g, moods, source: src, missing, used }) => {
            const trackId = `asset-${a.id}`;
            const playing = player.track?.id === trackId && player.playing;
            const needsRights = NEEDS_RIGHTS.includes(a.rightsStatus) || a.legacyScopeReviewRequired;
            const kindLabel = `${KIND_LABELS[a.kind] ?? a.kind}${a.category ? ` · ${a.category}` : ""}`;
            const dur = fmtDuration(a.durationMs);
            return (
              <li key={a.id} data-testid={`asset-${a.id}`} className="mamRow" data-archived={a.isArchived ? "true" : undefined}>
                <button
                  type="button"
                  className="playBtn mamPlay"
                  data-playing={playing ? "true" : "false"}
                  aria-pressed={playing}
                  aria-label={playing ? `Stop preview of ${a.name}` : `Preview ${a.name}`}
                  data-testid={`preview-${a.id}`}
                  disabled={a.processingStatus !== "ready"}
                  // The authorized preview route — never a storage URL.
                  onClick={() => player.toggle({ id: trackId, src: a.previewPath, title: a.name, subtitle: kindLabel })}
                >
                  {playing ? Icon.pause : Icon.play}
                </button>

                <div className="mamWhat">
                  <span className="mamName">{a.name}{a.isArchived ? " (archived)" : ""}</span>
                  <span className="mamSub">
                    {kindLabel} · {a.scopeLabel} · {dur || <em className="mamUnset">duration not set</em>}
                  </span>
                </div>

                <dl className="mamMeta">
                  <div><dt>Energy</dt><dd>{e ? <>{e} <span className="mamFrom">{energyFrom}</span></> : <em className="mamUnset">not set</em>}</dd></div>
                  <div><dt>BPM</dt><dd>{b ? <>{b} <span className="mamFrom">{bpmFrom}</span></> : <em className="mamUnset">not set</em>}</dd></div>
                  <div><dt>Genre</dt><dd>{g ?? <em className="mamUnset">not set</em>}</dd></div>
                  <div><dt>Mood</dt><dd>{moods.length ? moods.join(", ") : <em className="mamUnset">not set</em>}</dd></div>
                  <div><dt>Source</dt><dd>{src ?? <em className="mamUnset">not set</em>}</dd></div>
                  <div><dt>Licence</dt><dd>{a.licenseStatus}</dd></div>
                  <div>
                    <dt>Rights</dt>
                    <dd>{a.rightsStatus}{needsRights && <strong> — needs review</strong>}</dd>
                  </div>
                  <div><dt>Used by you</dt><dd>{used} time{used === 1 ? "" : "s"}</dd></div>
                  {a.processingStatus !== "ready" && <div><dt>Status</dt><dd>{a.processingStatus}</dd></div>}
                </dl>

                {(a.tags.length > 0 || missing.length > 0) && (
                  <div className="mamTags">
                    {a.tags.map((t) => <span key={t} className="mamTag">{t}</span>)}
                    {missing.length > 0 && <span className="mamMissing">Missing: {missing.join(", ")}</span>}
                  </div>
                )}

                <div className="mamActions">
                  {a.scope !== "shared_system" && !a.isArchived && (
                    <button type="button" disabled={pending} data-testid={`archive-${a.id}`}
                      onClick={() => startTransition(async () => { const r = await archiveMyAudioAsset(a.id); setStatus(r.success ? "Archived." : r.error ?? "Failed."); })}>
                      Archive
                    </button>
                  )}
                  {a.scope !== "shared_system" && a.isArchived && (
                    <button type="button" disabled={pending} data-testid={`restore-${a.id}`}
                      onClick={() => startTransition(async () => { const r = await restoreMyAudioAsset(a.id); setStatus(r.success ? "Restored." : r.error ?? "Failed."); })}>
                      Restore
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {visible.length > shown && (
          <button type="button" className="mamMore" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, visible.length - shown)} more ({(visible.length - shown).toLocaleString()} not shown)
          </button>
        )}
      </div>

      <section aria-label="Upload a new asset" className="alUpload mamUpload" id="audio-upload">
        <h2 className="mt-0">Upload audio</h2>
        <form ref={formRef} action={onUpload} data-testid="upload-form">
          <div className="alFieldGrid">
            <label>Name <input name="name" required maxLength={200} data-testid="upload-name" /></label>
            <label>Kind{" "}
              <select name="kind" value={uploadKind} onChange={(e) => setUploadKind(e.target.value)} data-testid="upload-kind">
                {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </label>
            {uploadKind === "sfx" && (
              <label>SFX category{" "}
                <select name="category" data-testid="upload-category">
                  {SFX_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            <label>Scope{" "}
              <select name="scope" value={uploadScope} onChange={(e) => setUploadScope(e.target.value as never)} data-testid="upload-scope">
                <option value="owner_private">My library (all my shows)</option>
                <option value="podcast_private">One show only</option>
              </select>
            </label>
            {uploadScope === "podcast_private" && (
              <label>Show{" "}
                <select name="podcastId" data-testid="upload-podcast">
                  {props.podcasts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            <label>License name <input name="licenseName" placeholder="e.g. Original recording" data-testid="upload-license" /></label>
            <label>License status{" "}
              <select name="licenseStatus" defaultValue="original">
                {["original", "licensed", "public_domain", "cc0"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>Tags (comma-separated) <input name="tags" /></label>
            <label>Audio file <input type="file" name="file" accept="audio/*" required data-testid="upload-file" /></label>
            <label>Rights document (PDF/PNG/JPEG, optional) <input type="file" name="rightsDocument" accept=".pdf,.png,.jpg,.jpeg" /></label>
          </div>
          <label className="alBlockField">
            <input type="checkbox" name="rightsConfirmed" value="true" data-testid="upload-rights" />{" "}
            I confirm I hold the rights to use this audio in podcast production.
          </label>
          <label className="alBlockField">Rights notes <input name="rightsNotes" className="u-full" /></label>
          <button type="submit" disabled={pending} data-testid="upload-submit">Upload</button>
        </form>
      </section>
    </div>
  );
}
