'use client';

import type { MouseEvent, ReactNode } from 'react';

// Collapsible sidebar section. The action button lives inside the <summary>,
// so it must not toggle the panel when clicked.
export default function SidePanel({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
}) {
  const handleAction = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onAction?.();
  };
  return (
    <details className="panel side" open>
      <summary>
        <h2>
          {title}
          {action && (
            <span className="actions">
              <button onClick={handleAction}>{action}</button>
            </span>
          )}
        </h2>
      </summary>
      {children}
    </details>
  );
}
