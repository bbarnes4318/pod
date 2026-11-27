"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./StudioIcons";
import { searchStudio, type SearchHit } from "./searchActions";

export type PaletteItem = {
  id: string;
  label: string;
  /** Group heading shown above the item. */
  group: string;
  href: string;
  icon: React.ReactNode;
  /** Extra words the filter matches on, never shown. */
  keywords?: string;
  /** Second line of context: the show an episode belongs to, a host's role. */
  sub?: string;
  /** Keyboard shortcut shown at the right, e.g. "G S". */
  hint?: string;
};

const HIT_ICON: Record<SearchHit["kind"], React.ReactNode> = {
  show: Icon.shows,
  episode: Icon.episodes,
  host: Icon.hosts,
  topic: Icon.desk,
};
const HIT_GROUP: Record<SearchHit["kind"], string> = {
  show: "Shows",
  episode: "Episodes",
  host: "Talent",
  topic: "Topics",
};

/**
 * Jump-to-anything. Pages and actions filter instantly; two or more letters
 * also search YOUR shows, episodes, hosts and topics on the server (scoped to
 * what you own, the same rule the list pages use). Opens on ⌘K / Ctrl+K anywhere in the Studio, or from the
 * search field in the sidebar. Arrow keys move, Enter goes, Escape closes.
 *
 * Built on the ARIA combobox + listbox pattern: focus stays in the input and
 * aria-activedescendant tells assistive tech which option is current, so a
 * screen-reader user hears every move without focus leaving the field.
 */
/** Mounted only while open, so every opening starts from a clean query. */
export default function CommandPalette({
  onClose,
  items,
}: {
  onClose: () => void;
  items: PaletteItem[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [hits, setHits] = useState<PaletteItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  // Debounced, and guarded against out-of-order replies: a slow answer to "ab"
  // must not overwrite the answer to "abc".
  useEffect(() => {
    const q = query.trim();
    // Below two letters nothing is asked; `results` ignores any earlier hits.
    if (q.length < 2) return;
    let stale = false;
    const timer = setTimeout(() => {
      setSearching(true);
      searchStudio(q)
        .then((found) => {
          if (stale) return;
          setHits(found.map((hit) => ({ id: `hit-${hit.kind}-${hit.id}`, group: HIT_GROUP[hit.kind], label: hit.label, sub: hit.sub, href: hit.href, icon: HIT_ICON[hit.kind] })));
          setSearchFailed(false);
        })
        .catch(() => {
          if (stale) return;
          setHits([]);
          setSearchFailed(true);
        })
        .finally(() => {
          if (!stale) setSearching(false);
        });
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const local = items.filter((item) =>
      `${item.label} ${item.group} ${item.keywords ?? ""}`.toLowerCase().includes(q)
    );
    // The server may return a show the local list already has.
    const seen = new Set(local.map((item) => item.href));
    return q.length < 2 ? local : [...local, ...hits.filter((hit) => !seen.has(hit.href))];
  }, [items, query, hits]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    router.push(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cmdkLayer" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdkPanel" role="dialog" aria-modal="true" aria-label="Search the Studio">
        <div className="cmdkSearch">
          <span className="cmdkSearchIcon">{Icon.search}</span>
          <input
            ref={inputRef}
            className="cmdkInput"
            placeholder="Search shows, episodes, talent, topics and actions"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-${results[active].id}` : undefined}
            aria-autocomplete="list"
          />
          <kbd className="cmdkKbd">Esc</kbd>
        </div>
        <div className="cmdkList" id="cmdk-list" role="listbox" ref={listRef} aria-label="Results">
          {results.length === 0 && (
            <div className="cmdkEmpty" role="status">
              {query.trim().length >= 2 && searching ? "Searching your studio…" : searchFailed ? "Search is unavailable right now. Pages and actions still work." : `Nothing matches “${query}”.`}
            </div>
          )}
          {results.map((item, index) => {
            const heading = index === 0 || results[index - 1].group !== item.group ? item.group : null;
            return (
              <React.Fragment key={item.id}>
                {heading && <div className="cmdkGroup" role="presentation">{heading}</div>}
                <div
                  id={`cmdk-${item.id}`}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  className="cmdkItem"
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(item)}
                >
                  <span className="cmdkItemIcon">{item.icon}</span>
                  <span className="cmdkItemLabel">
                    <span className="cmdkItemText">{item.label}</span>
                    {item.sub && <span className="cmdkItemSub">{item.sub}</span>}
                  </span>
                  {item.hint ? <kbd className="cmdkKbd cmdkItemHint">{item.hint}</kbd> : <span className="cmdkItemGo">{Icon.enter}</span>}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="cmdkFoot">
          <span><kbd className="cmdkKbd">↑</kbd><kbd className="cmdkKbd">↓</kbd> to move</span>
          <span><kbd className="cmdkKbd">Enter</kbd> to open</span>
          <span className="cmdkFootHint"><kbd className="cmdkKbd">G</kbd> then a letter jumps to a section</span>
        </div>
      </div>
    </div>
  );
}
