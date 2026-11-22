"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBusinessPodcast } from "../../businessActions";
import { GEOGRAPHIC_SCOPES, INDUSTRIES, PODCAST_GOALS, TARGET_AUDIENCES } from "@/lib/business/profileSchema";

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={on ? "chip chipAccent bizToggle" : "chip bizToggle"} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

export default function BusinessSetupForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    showName: "",
    businessName: "",
    websiteUrl: "",
    description: "",
    industry: "",
    subIndustries: "",
    targetAudiences: [] as string[],
    primaryGoal: PODCAST_GOALS[0] as string,
    geographicMarkets: [] as string[],
    language: "en",
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const flip = (k: "targetAudiences" | "geographicMarkets", v: string) =>
    set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await createBusinessPodcast({
        ...f,
        showName: f.showName || `${f.businessName} Podcast`,
        websiteUrl: f.websiteUrl.trim() || null,
        description: f.description.trim() || null,
        subIndustries: splitList(f.subIndustries),
      });
      if (!res.success) return setError(res.error);
      router.push(`/studio/shows/${res.podcastId}`);
    });
  };

  return (
    <form onSubmit={submit} className="studioCard bizForm" data-testid="business-setup-form">
      <div>
        <h2 className="m-0">Your business</h2>
        <p className="bizLead">
          The essentials. Next we read your website and show you what we learned — you confirm or correct every item before research uses it.
        </p>
      </div>

      <div className="bizGrid2">
        <label>
          <span className="fieldLabel">Business name *</span>
          <input className="input" required maxLength={160} value={f.businessName} onChange={(e) => set("businessName", e.target.value)} />
        </label>
        <label>
          <span className="fieldLabel">Website</span>
          <input className="input" type="url" placeholder="https://" value={f.websiteUrl} onChange={(e) => set("websiteUrl", e.target.value)} />
        </label>
      </div>

      <label>
        <span className="fieldLabel">What does your business do, and who are your customers?</span>
        <textarea
          className="textarea"
          maxLength={4000}
          placeholder="Required if you don't have a website. Specifics help: what you sell, to whom, and what makes you different."
          value={f.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </label>

      <div className="bizGrid2">
        <label>
          <span className="fieldLabel">Industry *</span>
          <input className="input" list="biz-industries" required maxLength={120} value={f.industry} onChange={(e) => set("industry", e.target.value)} placeholder="Pick or type your own" />
          <datalist id="biz-industries">{INDUSTRIES.map((i) => <option key={i} value={i} />)}</datalist>
        </label>
        <label>
          <span className="fieldLabel">Specialties / sub-industries</span>
          <input className="input" value={f.subIndustries} onChange={(e) => set("subIndustries", e.target.value)} placeholder="e.g. Final expense, Independent agency distribution" />
        </label>
      </div>

      <fieldset className="bizFieldset">
        <legend className="fieldLabel">Who should this podcast serve? *</legend>
        <div className="bizChips">
          {TARGET_AUDIENCES.map((a) => <Toggle key={a} label={a} on={f.targetAudiences.includes(a)} onClick={() => flip("targetAudiences", a)} />)}
        </div>
      </fieldset>

      <div className="bizGrid2">
        <label>
          <span className="fieldLabel">Primary goal *</span>
          <select className="select" value={f.primaryGoal} onChange={(e) => set("primaryGoal", e.target.value)}>
            {PODCAST_GOALS.map((g) => <option key={g}>{g}</option>)}
          </select>
        </label>
        <label>
          <span className="fieldLabel">Show name</span>
          <input className="input" maxLength={80} value={f.showName} onChange={(e) => set("showName", e.target.value)} placeholder={f.businessName ? `${f.businessName} Podcast` : "Defaults to your business name"} />
        </label>
      </div>

      <fieldset className="bizFieldset">
        <legend className="fieldLabel">Market</legend>
        <div className="bizChips">
          {GEOGRAPHIC_SCOPES.map((g) => <Toggle key={g} label={g} on={f.geographicMarkets.includes(g)} onClick={() => flip("geographicMarkets", g)} />)}
        </div>
      </fieldset>

      {error && <p role="alert" className="gateResult gate-err bizFlush">{error}</p>}

      <div>
        <button className="btnPrimary" disabled={pending || !f.businessName || !f.industry || f.targetAudiences.length === 0}>
          {pending ? "Creating…" : "Create business podcast"}
        </button>
      </div>
    </form>
  );
}
