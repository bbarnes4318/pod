// Minimal Epidemic Sound MCP client over the Streamable-HTTP transport.
//
// The ES catalog is exposed as an Apollo MCP server at
// https://www.epidemicsound.com/a/mcp-service/mcp, authenticated with a 30-day
// Bearer key (EPIDEMIC_SOUND_API_KEY). Tools are GraphQL-backed and return a
// single text content block whose text is the GraphQL JSON response.
//
// This client speaks just enough MCP to drive it from a plain Node process
// (server-side ingest): initialize -> notifications/initialized -> tools/call.
// It never logs the key. Read the key from env; NEVER hardcode or commit it.

const DEFAULT_ENDPOINT = "https://www.epidemicsound.com/a/mcp-service/mcp";

export interface EpidemicRecording {
  id: string;
  title: string;
  bpm: number;
  coverArtUrl?: string;
  audioFile?: { durationInMilliseconds?: number };
  credits?: Array<{ role: string; artist: { id: string; name: string; slug: string } }>;
  tags?: Array<{ displayName: string; dimension?: { name: string } }>;
}

export interface EpidemicSoundEffect {
  id: string;
  title: string;
  audioFile?: { durationInMilliseconds?: number };
  tags?: Array<{ displayName: string; slug?: string }>;
}

interface RpcResult {
  status: number;
  sessionId?: string;
  json: any;
  raw: string;
}

export class EpidemicMcpClient {
  private endpoint: string;
  private apiKey: string;
  private sessionId?: string;
  private idCounter = 0;

  constructor(opts?: { endpoint?: string; apiKey?: string }) {
    this.endpoint = opts?.endpoint || process.env.EPIDEMIC_SOUND_MCP_URL || DEFAULT_ENDPOINT;
    this.apiKey = opts?.apiKey || process.env.EPIDEMIC_SOUND_API_KEY || "";
    if (!this.apiKey) {
      throw new Error("EPIDEMIC_SOUND_API_KEY is not set (ingest-time env var; never hardcode it).");
    }
  }

  private async rpc(body: unknown): Promise<RpcResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const res = await fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id") || undefined;
    const raw = await res.text();
    let json: any = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      // SSE frames: take the last `data:` line's JSON payload.
      const dataLines = raw.split("\n").filter((l) => l.startsWith("data:"));
      if (dataLines.length) {
        try { json = JSON.parse(dataLines[dataLines.length - 1].slice(5).trim()); } catch { /* */ }
      }
    } else {
      try { json = JSON.parse(raw); } catch { /* */ }
    }
    return { status: res.status, sessionId: sid, json, raw };
  }

  async init(): Promise<void> {
    const init = await this.rpc({
      jsonrpc: "2.0",
      id: ++this.idCounter,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pod-epidemic-ingest", version: "1.0.0" },
      },
    });
    if (init.status !== 200) {
      throw new Error(`ES MCP initialize failed: HTTP ${init.status} ${init.raw.slice(0, 200)}`);
    }
    this.sessionId = init.sessionId;
    // Best-effort initialized notification (some servers require it).
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  /** Call a tool and return the parsed GraphQL JSON from its text content. */
  async callTool<T = any>(name: string, args: unknown): Promise<T> {
    const r = await this.rpc({
      jsonrpc: "2.0",
      id: ++this.idCounter,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (r.json?.error) {
      throw new Error(`ES MCP ${name} error: ${JSON.stringify(r.json.error).slice(0, 300)}`);
    }
    const text = r.json?.result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`ES MCP ${name}: no text content (HTTP ${r.status}) ${r.raw.slice(0, 200)}`);
    }
    let parsed: any;
    try { parsed = JSON.parse(text); } catch {
      throw new Error(`ES MCP ${name}: content was not JSON: ${text.slice(0, 200)}`);
    }
    if (parsed?.errors) {
      throw new Error(`ES MCP ${name} GraphQL errors: ${JSON.stringify(parsed.errors).slice(0, 300)}`);
    }
    return parsed?.data as T;
  }

  async searchRecordings(input: {
    term: string;
    first?: number;
    vocals?: boolean;
    bpm?: { min?: number; max?: number };
    duration?: { min?: number; max?: number };
    moodSlugs?: string[];
    sortBy?: "RELEVANCE" | "POPULARITY" | "DATE" | "DURATION" | "TITLE" | "BPM";
  }): Promise<EpidemicRecording[]> {
    const filter: any = {};
    if (input.vocals !== undefined) filter.vocals = input.vocals;
    if (input.bpm) filter.bpm = input.bpm;
    if (input.duration) filter.duration = input.duration;
    if (input.moodSlugs?.length) filter.moodSlugs = { matchType: "ANY", values: input.moodSlugs };
    const args: any = { query: { term: input.term }, first: input.first ?? 10 };
    if (Object.keys(filter).length) args.filter = filter;
    if (input.sortBy) args.sort = { by: input.sortBy, order: "DESCENDING" };
    const data = await this.callTool<{ recordings: { nodes: Array<{ recording: EpidemicRecording }> } }>(
      "SearchRecordings",
      args
    );
    return (data?.recordings?.nodes || []).map((n) => n.recording);
  }

  async searchSoundEffects(input: {
    term: string;
    first?: number;
    duration?: { min?: number; max?: number };
    sortBy?: "RELEVANCE" | "POPULARITY" | "DATE" | "DURATION" | "TITLE";
  }): Promise<EpidemicSoundEffect[]> {
    const args: any = { query: { term: input.term }, first: input.first ?? 10 };
    if (input.duration) args.filter = { duration: input.duration };
    if (input.sortBy) args.sort = { by: input.sortBy, order: "DESCENDING" };
    const data = await this.callTool<{ soundEffects: { nodes: Array<{ soundEffect: EpidemicSoundEffect }> } }>(
      "SearchSoundEffects",
      args
    );
    return (data?.soundEffects?.nodes || []).map((n) => n.soundEffect);
  }

  /** Resolve a fresh (short-lived) WAV download URL for a recording. */
  async recordingWavUrl(id: string, stemType: "FULL" | "BASS" | "DRUMS" | "INSTRUMENTS" = "FULL"): Promise<string> {
    const data = await this.callTool<any>("DownloadRecording", {
      id,
      options: { fileType: "WAV", stemType },
    });
    const url = data?.recordingDownload?.assetUrl;
    if (!url) throw new Error(`DownloadRecording ${id}: no assetUrl (${JSON.stringify(data).slice(0, 200)})`);
    return url;
  }

  /** Resolve a fresh (short-lived) WAV download URL for a sound effect. */
  async soundEffectWavUrl(id: string): Promise<string> {
    const data = await this.callTool<any>("DownloadSoundEffect", {
      id,
      options: { fileType: "WAV" },
    });
    const url = data?.soundEffectDownload?.assetUrl;
    if (!url) throw new Error(`DownloadSoundEffect ${id}: no assetUrl (${JSON.stringify(data).slice(0, 200)})`);
    return url;
  }
}

/** Pull mood displayNames out of a recording's tag list. */
export function recordingMoods(rec: EpidemicRecording): string[] {
  return (rec.tags || [])
    .filter((t) => t.dimension?.name === "mood")
    .map((t) => t.displayName);
}

/** All tag displayNames (any dimension) for a recording. */
export function recordingTagNames(rec: EpidemicRecording): string[] {
  return (rec.tags || []).map((t) => t.displayName);
}

/** Primary (first MAIN_ARTIST, else first) artist name for a recording. */
export function recordingArtist(rec: EpidemicRecording): string {
  const credits = rec.credits || [];
  const main = credits.find((c) => c.role === "MAIN_ARTIST") || credits[0];
  return main?.artist?.name || "Epidemic Sound";
}
