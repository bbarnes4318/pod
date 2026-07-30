import Link from "next/link";
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";
import styles from "./StudioPrimitives.module.css";
import { ResponsiveTabs } from "./ResponsiveTabs";

export function AppPage({ children, className = "" }: { children: ReactNode; className?: string }) { return <div className={`${styles.page} ${className}`.trim()}>{children}</div>; }
export function Breadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) { return <nav className={styles.breadcrumbs} aria-label="Breadcrumb">{items.map((item, index) => <span key={`${item.label}-${index}`}>{index > 0 && <span aria-hidden="true">/ </span>}{item.href ? <Link href={item.href}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}</span>)}</nav>; }
export function PageHeader({ title, description, actions, detail = false, breadcrumbs }: { title: string; description?: string; actions?: ReactNode; detail?: boolean; breadcrumbs?: Array<{ label: string; href?: string }> }) { return <header className={styles.pageHeader}><div className={styles.pageHeaderCopy}>{breadcrumbs && <Breadcrumbs items={breadcrumbs} />}<h1 className={`${styles.title} ${detail ? styles.detailTitle : ""}`}>{title}</h1>{description && <p className={styles.description}>{description}</p>}</div>{actions && <PageActions>{actions}</PageActions>}</header>; }
export function PageActions({ children }: { children: ReactNode }) { return <div className={styles.actions}>{children}</div>; }
export function SectionHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) { return <div className={styles.sectionHeader}><div><h2 className={styles.sectionTitle}>{title}</h2>{description && <p className={styles.sectionDescription}>{description}</p>}</div>{actions && <div className={styles.actions}>{actions}</div>}</div>; }
export function Section({ children }: { children: ReactNode }) { return <section className={styles.section}>{children}</section>; }
export function Toolbar({ children }: { children: ReactNode }) { return <div className={styles.toolbar}>{children}</div>; }
export function ToolbarGroup({ children }: { children: ReactNode }) { return <div className={styles.toolbarGroup}>{children}</div>; }

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "link";
type ButtonSize = "default" | "prominent" | "compact";
function buttonClass(variant: ButtonVariant, size: ButtonSize, iconOnly = false, className = "") { return [styles.button, styles[variant], size !== "default" ? styles[size] : "", iconOnly ? styles.iconButton : "", className].filter(Boolean).join(" "); }
export function Button({ variant = "secondary", size = "default", iconOnly = false, className = "", ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize; iconOnly?: boolean }) { return <button {...props} className={buttonClass(variant, size, iconOnly, className)} />; }
export function ButtonLink({ href, variant = "secondary", size = "default", iconOnly = false, className = "", children, ...props }: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize; iconOnly?: boolean }) { return <Link {...props} href={href} className={buttonClass(variant, size, iconOnly, className)}>{children}</Link>; }
export function IconButton(props: ComponentProps<"button">) { return <Button {...props} iconOnly />; }
type LabelableChildProps = { "aria-label"?: string };
export function Field({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor?: string; children: ReactNode }) {
  const control = !htmlFor && isValidElement<LabelableChildProps>(children) && !children.props["aria-label"]
    ? cloneElement(children, { "aria-label": label })
    : children;
  return <div className={styles.field}><label className={styles.label} htmlFor={htmlFor}>{label}</label>{control}{help && <p className={styles.help}>{help}</p>}</div>;
}
export function Input({ className = "", ...props }: ComponentProps<"input">) { return <input {...props} className={`${styles.input} ${className}`.trim()} />; }
export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) { return <textarea {...props} className={`${styles.textarea} ${className}`.trim()} data-scroll-allow />; }
export function Select({ className = "", ...props }: ComponentProps<"select">) { return <select {...props} className={`${styles.select} ${className}`.trim()} />; }
export function SearchInput(props: ComponentProps<"input">) { return <div className={styles.searchWrap}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><Input type="search" {...props} /></div>; }
export function Checkbox({ label, ...props }: ComponentProps<"input"> & { label: ReactNode }) { return <label className={styles.check}><input type="checkbox" {...props} /> <span>{label}</span></label>; }
export function SegmentedControl({ options, value, name }: { options: Array<{ value: string; label: string; href?: string }>; value: string; name?: string }) { return <div className={styles.segmented} role="group" aria-label={name}>{options.map(option => option.href ? <Link key={option.value} href={option.href} className={styles.segment} aria-pressed={value === option.value}>{option.label}</Link> : <button key={option.value} type="submit" name={name} value={option.value} className={styles.segment} aria-pressed={value === option.value}>{option.label}</button>)}</div>; }

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "live";
export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) { return <span className={`${styles.badge} ${tone !== "neutral" ? styles[tone] : ""}`}>{children}</span>; }
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) { return <div className={`${styles.card} ${className}`.trim()}>{children}</div>; }
export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) { return <div className={styles.metric}><span className={styles.metricLabel}>{label}</span><strong className={styles.metricValue}>{value}</strong>{hint && <span className={styles.metricHint}>{hint}</span>}</div>; }
export function MetricGrid({ children }: { children: ReactNode }) { return <div className={styles.metricGrid}>{children}</div>; }
export function DataTable({ children, label }: { children: ReactNode; label: string }) { return <div className={styles.tableWrap} data-scroll-allow><table className={styles.table} aria-label={label}>{children}</table></div>; }
export function RowTitle({ title, subtitle }: { title: string; subtitle?: string | null }) { return <span><span className={styles.rowTitle} title={title}>{title}</span>{subtitle && <span className={styles.rowSub}>{subtitle}</span>}</span>; }
export function TableRowActions({ children }: { children: ReactNode }) { return <div className={styles.rowActions}>{children}</div>; }
export function MobileList({ children }: { children: ReactNode }) { return <div className={styles.mobileList}>{children}</div>; }
export function NumericCell({ children }: { children: ReactNode }) { return <td className={styles.numeric}>{children}</td>; }
export function Pagination({ page, pageSize, total, basePath, query = {} }: { page: number; pageSize: number; total: number; basePath: string; query?: Record<string, string | undefined> }) { const pages = Math.max(1, Math.ceil(total / pageSize)); const href = (next: number) => { const params = new URLSearchParams(); Object.entries(query).forEach(([key, value]) => { if (value) params.set(key, value); }); params.set("page", String(next)); return `${basePath}?${params.toString()}`; }; const start = total === 0 ? 0 : (page - 1) * pageSize + 1; const end = Math.min(total, page * pageSize); return <nav className={styles.pagination} aria-label="Pagination"><span>{start}–{end} of {total}</span><div className={styles.paginationActions}>{page > 1 ? <ButtonLink href={href(page - 1)} size="compact">Previous</ButtonLink> : <Button size="compact" disabled>Previous</Button>}<span>Page {page} of {pages}</span>{page < pages ? <ButtonLink href={href(page + 1)} size="compact">Next</ButtonLink> : <Button size="compact" disabled>Next</Button>}</div></nav>; }
export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <div className={styles.empty}><strong className={styles.emptyTitle}>{title}</strong><p className={styles.emptyText}>{description}</p>{action}</div>; }
export function ErrorState({ title = "Something went wrong", description, action }: { title?: string; description: string; action?: ReactNode }) { return <div className={styles.error} role="alert"><strong className={styles.errorTitle}>{title}</strong><p className={styles.errorText}>{description}</p>{action}</div>; }
export function ProgressBar({ value, label }: { value: number; label: string }) { const safe = Math.max(0, Math.min(100, value)); return <div className={styles.progress} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={safe}><div className={styles.progressFill} style={{ width: `${safe}%` }} /></div>; }
export function ScoreDisplay({ value, max = 100 }: { value: number; max?: number }) { return <span className={styles.score}>{Math.round(value)}<small>/{max}</small></span>; }
export function Skeleton({ width = "100%", height = 16 }: { width?: string | number; height?: number }) { return <span className={styles.skeleton} aria-hidden="true" style={{ width, height, display: "block" }} />; }
export function Tabs({ items, current }: { items: Array<{ label: string; href: string; value: string }>; current: string }) { return <><nav className={styles.tabs} aria-label="Sections">{items.map(item => <Link key={item.value} href={item.href} className={styles.tab} aria-current={item.value === current ? "page" : undefined}>{item.label}</Link>)}</nav><ResponsiveTabs items={items} current={current} /></>; }
export function AudioPlayer({ src, title }: { src: string; title: string }) { return <div className={styles.audio}><span aria-hidden="true">▶</span><audio controls preload="metadata" src={src} aria-label={`Play ${title}`} /><span className={styles.rowSub}>{title}</span></div>; }
export const primitiveStyles = styles;
