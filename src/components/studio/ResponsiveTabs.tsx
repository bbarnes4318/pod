"use client";

import { useRouter } from "next/navigation";
import styles from "./StudioPrimitives.module.css";

export function ResponsiveTabs({ items, current }: { items: Array<{ label: string; href: string; value: string }>; current: string }) {
  const router = useRouter();
  return <select className={`${styles.select} ${styles.responsiveSelect}`} value={current} aria-label="Section" onChange={event => { const item = items.find(candidate => candidate.value === event.target.value); if (item) router.push(item.href); }}>{items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>;
}
