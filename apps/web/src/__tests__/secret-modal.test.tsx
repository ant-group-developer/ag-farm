import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SecretModal } from '../shared/components/SecretModal';

// jsdom does not implement clipboard; provide a simple mock
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

describe('SecretModal', () => {
  const baseProps = {
    open: true,
    title: 'Token node',
    label: 'Token',
    secret: 'super-secret-token-value',
    onClose: vi.fn(),
  };

  it('renders the secret value when open', () => {
    render(<SecretModal {...baseProps} />);
    expect(screen.getByText('super-secret-token-value')).toBeTruthy();
  });

  it('shows the title', () => {
    render(<SecretModal {...baseProps} />);
    expect(screen.getByText('Token node')).toBeTruthy();
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    render(<SecretModal {...baseProps} onClose={onClose} />);
    const closeBtn = screen.getByTestId('secret-modal-close');
    await userEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not render when open=false', () => {
    render(<SecretModal {...baseProps} open={false} />);
    // Modal content should not be in DOM
    expect(screen.queryByText('super-secret-token-value')).toBeNull();
  });
});
