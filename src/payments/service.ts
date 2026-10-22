/**
 * Payments module - intentionally a stub.
 *
 * Real money is out of scope for this build: there is no deposit, withdrawal,
 * QRIS, bank transfer or payment-gateway integration. The interfaces below are
 * the seams where those features will be implemented later, so adding them does
 * not require restructuring the app.
 */
export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  readonly methods: Array<'qris' | 'bank_transfer' | 'card' | 'crypto'>;
  isAvailable(): boolean;
}

export interface DepositRequest {
  userId: string;
  currency: string;
  amountMinor: number;
  method: string;
}

export interface PaymentResult {
  status: 'not_available';
  message: string;
}

/** Placeholder implementation: every real-money operation is unavailable. */
export class PaymentService {
  readonly providers: PaymentProvider[] = [
    {
      id: 'qris',
      label: 'QRIS (not available)',
      methods: ['qris'],
      isAvailable: () => false,
    },
    {
      id: 'bank_transfer',
      label: 'Bank transfer (not available)',
      methods: ['bank_transfer'],
      isAvailable: () => false,
    },
    {
      id: 'withdraw',
      label: 'Withdrawal (not available)',
      methods: ['bank_transfer', 'crypto'],
      isAvailable: () => false,
    },
  ];

  listProviders(): Array<Omit<PaymentProvider, 'isAvailable'> & { available: boolean; reason: string }> {
    return this.providers.map((p) => ({
      id: p.id,
      label: p.label,
      methods: p.methods,
      available: p.isAvailable(),
      reason: 'Live accounts and real-money payments are not implemented in this simulation-only build.',
    }));
  }

  /** Both deposit and withdraw deliberately return the same "not available" result. */
  notAvailable(): PaymentResult {
    return {
      status: 'not_available',
      message:
        'belum tersedia - real-money deposits and withdrawals are not implemented. Only the instant DEMO top-up (/api/v1/wallet/topup) exists in this build.',
    };
  }
}
