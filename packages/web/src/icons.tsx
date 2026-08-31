import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children?: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

export function FossilMark({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth="1.4" />
    <path d="M37.5 24c0 7.5-6 13.5-13.5 13.5S10.5 31.5 10.5 24 16.5 10.5 24 10.5 35 16 35 23.2c0 6.1-4.9 11-11 11s-11-4.9-11-11 4.9-11 11-11 8.6 4 8.6 8.8c0 4.8-3.9 8.6-8.6 8.6s-8.6-3.8-8.6-8.6 3.8-8.6 8.6-8.6 6.1 3.2 6.1 6.6-2.7 6.1-6.1 6.1-6.1-2.7-6.1-6.1 2.7-6.1 6.1-6.1 4.1 2 4.1 4.2-1.8 4.1-4.1 4.1-4.1-1.8-4.1-4.1" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="24" cy="21" r="1.5" fill="currentColor" stroke="none" />
  </svg>;
}

export const PlusIcon = (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
export const PanelIcon = (props: IconProps) => <Icon {...props}><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9 4v16" /></Icon>;
export const MenuIcon = (props: IconProps) => <Icon {...props}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>;
export const SettingsIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.5 1a8 8 0 0 0-2-1.2L14 3h-4l-.4 2.6a8 8 0 0 0-2 1.2l-2.5-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.5-1a8 8 0 0 0 2 1.2L10 21h4l.4-2.6a8 8 0 0 0 2-1.2l2.5 1 2-3.5-2-1.5c0-.4.1-.8.1-1.2Z" /></Icon>;
export const ChevronIcon = (props: IconProps) => <Icon {...props}><path d="m8 10 4 4 4-4" /></Icon>;
export const SendIcon = (props: IconProps) => <Icon {...props}><path d="m4 4 17 8-17 8 3-8-3-8Z" /><path d="M7 12h14" /></Icon>;
export const CloseIcon = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18" /></Icon>;
export const FolderIcon = (props: IconProps) => <Icon {...props}><path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.5Z" /></Icon>;
export const PermissionIcon = (props: IconProps) => <Icon {...props}><path d="M5 4.5h10l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 19V6a1.5 1.5 0 0 1 1-1.5Z" /><path d="M14.5 4.5V9H19M8 13.2l2.1 2.1 4.4-4.6" /></Icon>;
export const CheckIcon = (props: IconProps) => <Icon {...props}><path d="m5 12 4.2 4.2L19 6.8" /></Icon>;
