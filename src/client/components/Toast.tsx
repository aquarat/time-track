import { useEffect, useRef } from 'react';

interface Props {
  message: string;
  onDismiss: () => void;
}

const VISIBLE_MS = 2600;

/**
 * Transient confirmation, dismissed automatically.
 *
 * The dismiss timer is started once on mount and deliberately does not depend on
 * `onDismiss`. The tracker re-renders every second to drive the running clock, so
 * an effect keyed on the callback's identity would clear and restart the timer on
 * every tick and the toast would never go away. Callers re-show a toast by giving
 * the element a new `key`, which remounts it and restarts the timer honestly.
 */
export function Toast({ message, onDismiss }: Props) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    const id = window.setTimeout(() => dismiss.current(), VISIBLE_MS);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
