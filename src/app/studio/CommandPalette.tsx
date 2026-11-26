"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./StudioIcons";

export type PaletteItem = {
  id: string;
  label: string;
  /** Group heading shown above the item. */
  group: string;
  href: string;
  icon: React.ReactNode;
  /** Extra words the filter matches on, never shown. */
  keywords?: string;
};

/**
 * Jump-to-anything. Opens on ⌘K / Ctrl+K anywhere in the Studio, or from the
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

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.label} ${item.group} ${item.keywords ?? ""}`.toLowerCase().includes(q)
    );
  }, [items, query]);

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
            placeholder="Search pages and actions…"
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
          {results.length === 0 && <div className="cmdkEmpty">No pages or actions match “{query}”.</div>}
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
                  <span className="cmdkItemLabel">{item.label}</span>
                  <span className="cmdkItemGo">{Icon.enter}</span>
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="cmdkFoot">
          <span><kbd className="cmdkKbd">↑</kbd><kbd className="cmdkKbd">↓</kbd> to move</span>
          <span><kbd className="cmdkKbd">Enter</kbd> to open</span>
        </div>
      </div>
    </div>
  );
}
