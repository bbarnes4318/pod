"use client";

import { useEffect, useMemo, useState } from "react";

export interface WorkspaceTab { key: string; label: string; hint: string; node: React.ReactNode }

export default function EpisodeWorkspace({ tabs }: { tabs: WorkspaceTab[] }) {
  const keys = useMemo(() => tabs.map(tab => tab.key), [tabs]);
  const [active, setActive] = useState(tabs[0]?.key ?? "");

  useEffect(() => {
    const applyHash = () => {
      const key = window.location.hash.replace(/^#/, "");
      if (key && keys.includes(key)) setActive(key);
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [keys]);

  const choose = (key: string) => {
    setActive(key);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${key}`);
  };

  if (tabs.length === 0) return null;
  return <div className="epWorkspace">
    <div className="epTabs" role="tablist" aria-label="Episode tools">{tabs.map(tab => { const selected = tab.key === active; return <button key={tab.key} type="button" role="tab" id={`eptab-${tab.key}`} aria-selected={selected} aria-controls={`eppanel-${tab.key}`} tabIndex={selected ? 0 : -1} className={`epTab${selected ? " active" : ""}`} onClick={() => choose(tab.key)}><span className="epTabLabel">{tab.label}</span><span className="epTabHint">{tab.hint}</span></button>; })}</div>
    <label className="epTabsMobile"><span className="srOnly">Episode workspace</span><select value={active} onChange={event => choose(event.target.value)}>{tabs.map(tab => <option key={tab.key} value={tab.key}>{tab.label} — {tab.hint}</option>)}</select></label>
    {tabs.map(tab => <div key={tab.key} role="tabpanel" id={`eppanel-${tab.key}`} aria-labelledby={`eptab-${tab.key}`} hidden={tab.key !== active} className="epTabPanel">{tab.node}</div>)}
  </div>;
}
