import type { Client } from '../../shared/types';

interface Props {
  clients: Client[];
  value: string;
  onChange: (clientId: string) => void;
  /** Compact styling for use inside a row of entry controls. */
  compact?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
}

/**
 * Client selector used on every surface that creates or edits an entry.
 *
 * Hidden entirely when there is only one client — a picker with a single option
 * is noise, and the single-client case is still the common one.
 */
export function ClientPicker({ clients, value, onChange, compact, disabled, ...rest }: Props) {
  if (clients.length <= 1) return null;

  const selected = clients.find((c) => c.id === value);
  return (
    <span className={compact ? 'client-picker compact' : 'client-picker'}>
      <span className="client-dot" style={{ background: selected?.colour ?? 'transparent' }} />
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={rest['aria-label'] ?? 'Client'}
      >
        {/* An entry pointing at a deleted or unknown client still renders. */}
        {selected ? null : <option value={value}>Unknown client</option>}
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </span>
  );
}

/** The colour a client's calendar blocks and dots use. */
export function clientColour(clients: Client[], clientId: string): string | undefined {
  return clients.find((c) => c.id === clientId)?.colour;
}

export function clientName(clients: Client[], clientId: string): string {
  return clients.find((c) => c.id === clientId)?.name ?? 'Unknown client';
}
