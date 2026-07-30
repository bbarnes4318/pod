"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button, primitiveStyles as styles } from "./StudioPrimitives";

function useOverlay(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    const activeElement = document.activeElement;
    // React Strict Mode mounts, cleans up, and mounts effects again in development.
    // Preserve the original trigger when the second effect sees focus already inside
    // the overlay instead of replacing it with the drawer's close button.
    if (!panel?.contains(activeElement)) {
      restoreRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? []).filter(node => !node.hasAttribute("disabled"));
    focusables()[0]?.focus();

    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", key);
      const restoreTarget = restoreRef.current;
      queueMicrotask(() => {
        // Skip the synthetic Strict Mode cleanup while the overlay is still open.
        // Restore focus only after the real close render has committed.
        if (!openRef.current && restoreTarget && document.contains(restoreTarget)) {
          restoreTarget.focus();
          if (restoreRef.current === restoreTarget) restoreRef.current = null;
        }
      });
    };
  }, [open]);

  return panelRef;
}

export function Dialog({ open, onClose, title, description, children, footer }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useOverlay(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return <div className={styles.dialogBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={ref} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} data-scroll-allow><header className={styles.dialogHead}><div><strong id={titleId}>{title}</strong>{description && <p className={styles.help}>{description}</p>}</div><Button iconOnly variant="ghost" onClick={onClose} aria-label="Close dialog">×</Button></header><div className={styles.dialogBody}>{children}</div>{footer && <footer className={styles.dialogFoot}>{footer}</footer>}</div></div>;
}

export function Drawer({ open, onClose, title, description, children, footer }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useOverlay(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return <div className={styles.drawerBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><aside ref={ref} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby={titleId} data-scroll-allow><header className={styles.dialogHead}><div><strong id={titleId}>{title}</strong>{description && <p className={styles.help}>{description}</p>}</div><Button iconOnly variant="ghost" onClick={onClose} aria-label="Close drawer">×</Button></header><div className={styles.dialogBody}>{children}</div>{footer && <footer className={styles.dialogFoot}>{footer}</footer>}</aside></div>;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = "Confirm", destructive = false }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; description: string; confirmLabel?: string; destructive?: boolean }) {
  return <Dialog open={open} onClose={onClose} title={title} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={destructive ? "destructive" : "primary"} onClick={onConfirm}>{confirmLabel}</Button></>}><p className={styles.description}>{description}</p></Dialog>;
}
