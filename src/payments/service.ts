import type { KlikQrisClient } from './klikqris.js';

/**
 * Payments facade.
 *
 * The real integration lives in `kliqris.ts` + `DepositService`; this class only
 * exposes a safe, secret-free summary for the UI/admin panel and keeps the
 * legacy `/payments/*` stub endpoints honest (they still return 501 and point at
 * the working `/deposits` + `/withdrawals` endpoints).
 */
export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  readonly methods: Array<'qris' | 'bank_transfer' | 'card' | 'crypto'>;
}

export interface PaymentResult {
  status: 'not_available';
  message: string;
}

export class PaymentService {
  readonly providers: PaymentProvider[] = [
    { id: 'klikqris', label: 'QRIS via KlikQRIS', methods: ['qris'] },
    { id: 'manual_transfer', label: 'Transfer manual (review admin)', methods: ['bank_transfer'] },
    { id: 'bank_withdrawal', label: 'Penarikan bank/e-wallet (proses admin)', methods: ['bank_transfer'] },
  ];

  constructor(
    private readonly client: KlikQrisClient,
    private readonly flags: { depositsEnabled: boolean; withdrawalsEnabled: boolean },
  ) {}

  /** Safe provider status: never includes the API key or the full merchant id. */
  describe(): {
    configured: boolean;
    enabled: boolean;
    provider: 'klikqris';
    baseUrl: string;
    merchantIdMasked: string | null;
    callbackUrl: string | null;
    signatureHeader: string;
    webhookSecretSet: boolean;
    apiKeySet: boolean;
    depositsEnabled: boolean;
    withdrawalsEnabled: boolean;
    liveMoney: false;
  } {
    const safe = this.client.describe();
    return {
      configured: safe.configured,
      enabled: this.flags.depositsEnabled,
      provider: 'klikqris',
      baseUrl: safe.baseUrl,
      merchantIdMasked: safe.merchantIdMasked,
      callbackUrl: safe.callbackUrl,
      signatureHeader: safe.signatureHeader,
      webhookSecretSet: safe.webhookSecretSet,
      apiKeySet: safe.apiKeySet,
      depositsEnabled: this.flags.depositsEnabled,
      withdrawalsEnabled: this.flags.withdrawalsEnabled,
      liveMoney: false,
    };
  }

  listProviders(): Array<PaymentProvider & { available: boolean; reason: string }> {
    const configured = this.client.configured;
    return this.providers.map((provider) => ({
      ...provider,
      available: provider.id === 'klikqris' ? configured && this.flags.depositsEnabled : true,
      reason:
        provider.id === 'klikqris' && !configured
          ? 'Kredensial KlikQRIS belum diisi; transaksi otomatis tidak dapat dibuat.'
          : provider.id === 'klikqris'
            ? 'Transaksi dibuat melalui API KlikQRIS oleh backend.'
            : 'Diproses manual oleh admin finance dengan review bukti.',
    }));
  }

  /** Legacy endpoints: point callers at the working, auditable flows. */
  notAvailable(): PaymentResult {
    return {
      status: 'not_available',
      message:
        'Endpoint lama ini tidak dipakai lagi. Gunakan /api/v1/deposits (KlikQRIS/manual) dan /api/v1/withdrawals.',
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return this.client.testConnection();
  }
}
