"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button, primitiveStyles as styles } from "./StudioPrimitives";

type FocusReturnDescriptor = {
  tagName: string;
  id: string;
  ariaLabel: string;
  text: string;
};

function describeFocusTarget(target: HTMLElement): FocusReturnDescriptor {
  return {
    tagName: target.tagName.toLowerCase(),
    id: target.id,
    ariaLabel: target.getAttribute("aria-label") ?? "",
    text: (target.textContent ?? "").replace(/\s+/g, " ").trim(),
  };
}

function resolveFocusTarget(target: HTMLElement | null, descriptor: FocusReturnDescriptor | null): HTMLElement | null {
  if (target && document.contains(target)) return target;
  if (!descriptor) return null;
  if (descriptor.id) {
    const byId = document.getElementById(descriptor.id);
    if (byId) return byId;
  }
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(descriptor.tagName));
  return candidates.find((candidate) => {
    const ariaLabel = candidate.getAttribute("aria-label") ?? "";
    const text = (candidate.textContent ?? "").replace(/\s+/g, " ").trim();
    return ariaLabel === descriptor.ariaLabel && text === descriptor.text;
  }) ?? null;
}

function useOverlay(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const restoreDescriptorRef = useRef<FocusReturnDescriptor | null>(null);
  const triggerCapturedRef = useRef(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Capture the opener during the native capture phase, before React's onClick
  // changes state and before an auto-focused drawer control can steal the record.
  useEffect(() => {
    const rememberTarget = (target: HTMLElement) => {
      restoreRef.current = target;
      restoreDescriptorRef.current = describeFocusTarget(target);
      triggerCapturedRef.current = true;
    };
    const rememberPointerTrigger = (event: Event) => {
      if (panelRef.current?.isConnected) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      rememberTarget(target.closest<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? target);
    };
    const rememberKeyboardTrigger = (event: KeyboardEvent) => {
      if (panelRef.current?.isConnected || !["Enter", " "].includes(event.key)) return;
      const target = document.activeElement;
      if (target instanceof HTMLElement) rememberTarget(target);
    };
    const rememberOutsideFocus = (event: FocusEvent) => {
      if (panelRef.current?.isConnected || triggerCapturedRef.current) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        restoreRef.current = target;
        restoreDescriptorRef.current = describeFocusTarget(target);
      }
    };

    document.addEventListener("pointerdown", rememberPointerTrigger, true);
    document.addEventListener("click", rememberPointerTrigger, true);
    document.addEventListener("keydown", rememberKeyboardTrigger, true);
    document.addEventListener("focusin", rememberOutsideFocus, true);
    return () => {
      document.removeEventListener("pointerdown", rememberPointerTrigger, true);
      document.removeEventListener("click", rememberPointerTrigger, true);
      document.removeEventListener("keydown", rememberKeyboardTrigger, true);
      document.removeEventListener("focusin", rememberOutsideFocus, true);
    };
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
      const restoreDescriptor = restoreDescriptorRef.current;
      queueMicrotask(() => {
        // React Strict Mode's synthetic cleanup leaves the panel connected. A
        // real close removes it before this microtask runs. The opener may have
        // been reconciled to a new DOM node, so resolve its current equivalent.
        if (!panel?.isConnected) {
          resolveFocusTarget(restoreTarget, restoreDescriptor)?.focus();
          triggerCapturedRef.current = false;
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
