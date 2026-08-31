import type { ReactNode } from "react";
import { CloseIcon } from "./icons.js";

export function Dialog({ title, onClose, children, className = "" }: {
  title: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
}) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="dialog-header"><h2>{title}</h2><button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><CloseIcon /></button></header>
      {children}
    </section>
  </div>;
}
