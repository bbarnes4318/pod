"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button, primitiveStyles as styles } from "./StudioPrimitives";

function useOverlay(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Remember focus while the overlay is closed. React can auto-focus a field
  // inside the drawer before the open effect runs, so reading activeElement only
  // after mount can lose the button that actually opened the overlay.
  useEffect(() => {
    const rememberOutsideFocus = (event: FocusEvent) => {
      if (panelRef.current?.isConnected) return;
      const target = event.target;
      if (target instanceof HTMLElement) restoreRef.current = target;
    };
    document.addEventListener("focusin", rememberOutsideFocus, true);
    return () => document.removeEventListener("focusin", rememberOutsideFocus, true);
  }, []);

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
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
        // React Strict Mode's synthetic cleanup leaves the panel connected. A
        // real close removes it before this microtask runs.
        if (!panel?.isConnected && restoreTarget && document.contains(restoreTarget)) {
          restoreTarget.focus();
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
