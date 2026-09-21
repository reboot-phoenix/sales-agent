/**
 * Bulk actions must be honest about partial success: the promise a rep relies on
 * is "tell me which leads you could not change, and why".
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { BulkActionBar, HeaderCheckbox, useBulkSelection } from '@/components/BulkActionBar';
import { QueryClient, QueryClientProvider } from 'react-query';

function Harness({ rows, onClaim }: { rows: { id: string; name: string }[]; onClaim: jest.Mock }) {
  const selection = useBulkSelection(rows);
  const queryClient = new QueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <HeaderCheckbox checked={selection.allSelected} onChange={selection.toggleAll} />
        {rows.map((row) => (
          <button key={row.id} type="button" onClick={() => selection.toggle(row.id)}>
            {row.name}
          </button>
        ))}
        <span data-testid="count">{selection.count}</span>
        {selection.count > 0 && (
          <BulkActionBar ids={selection.selected} handlers={{ claim: onClaim }} onDone={selection.clear} />
        )}
      </ToastProvider>
    </QueryClientProvider>
  );
}

const rows = [
  { id: 'c1', name: 'ABC College' },
  { id: 'c2', name: 'XYZ College' },
];

describe('bulk selection', () => {
  it('selects and clears every visible row', () => {
    render(<Harness rows={rows} onClaim={jest.fn()} />);
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    expect(screen.getByTestId('count')).toHaveTextContent('2');
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('passes exactly the selected ids to the action', async () => {
    const onClaim = jest.fn().mockResolvedValue({ requested: 1, succeeded: 1, skipped: [] });
    render(<Harness rows={rows} onClaim={onClaim} />);
    fireEvent.click(screen.getByText('ABC College'));
    fireEvent.click(screen.getByRole('button', { name: /claim/i }));
    await waitFor(() => expect(onClaim).toHaveBeenCalledWith(['c1']));
  });

  it('reports a failed row with its reason instead of a success message', async () => {
    const onClaim = jest.fn().mockResolvedValue({
      requested: 1, succeeded: 0,
      skipped: [{ id: 'c1', reason: 'already claimed by raj@x.com' }],
    });
    render(<Harness rows={rows} onClaim={onClaim} />);
    fireEvent.click(screen.getByText('ABC College'));
    fireEvent.click(screen.getByRole('button', { name: /claim/i }));
    expect(await screen.findByText(/already claimed by raj@x.com/)).toBeInTheDocument();
  });

  it('surfaces a hard failure as an error, not a silent no-op', async () => {
    const onClaim = jest.fn().mockRejectedValue(new Error('network down'));
    render(<Harness rows={rows} onClaim={onClaim} />);
    fireEvent.click(screen.getByText('ABC College'));
    fireEvent.click(screen.getByRole('button', { name: /claim/i }));
    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });
});
