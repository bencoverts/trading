/**
 * Staff roles and the permission matrix used by the admin API and the admin UI.
 * Roles live on `users.staff_role`; product users have none.
 */
export const STAFF_ROLES = ['super_admin', 'operator', 'finance', 'support', 'viewer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = [
  'dashboard.read',
  'markets.read',
  'markets.write',
  'markets.simulate',
  'trades.read',
  'trades.settle',
  'trades.export',
  'users.read',
  'users.support',
  'users.balance',
  'users.role',
  'finance.read',
  'finance.write',
  'settings.read',
  'settings.write',
  'content.read',
  'content.write',
  'system.read',
  'system.write',
  'audit.read',
  'payments.read',
  'payments.write',
  'deposits.read',
  'deposits.review',
  'withdrawals.read',
  'withdrawals.process',
  'currencies.write',
  'chat.read',
  'chat.write',
  'site.write',
  'flags.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<StaffRole, Permission[]> = {
  super_admin: ALL,
  operator: [
    'dashboard.read',
    'markets.read',
    'markets.write',
    'markets.simulate',
    'trades.read',
    'trades.settle',
    'trades.export',
    'users.read',
    'content.read',
    'content.write',
    'settings.read',
    'finance.read',
    'payments.read',
    'chat.read',
    'chat.write',
  ],
  finance: [
    'dashboard.read',
    'finance.read',
    'finance.write',
    'payments.read',
    'payments.write',
    'currencies.write',
    'deposits.read',
    'deposits.review',
    'withdrawals.read',
    'withdrawals.process',
    'users.read',
    'audit.read',
    'settings.read',
    'content.read',
    'chat.read',
  ],
  support: [
    'dashboard.read',
    'markets.read',
    'trades.read',
    'trades.export',
    'users.read',
    'users.support',
    'users.balance',
    'finance.read',
    'settings.read',
    'content.read',
    'audit.read',
    'payments.read',
    'deposits.read',
    'withdrawals.read',
    'chat.read',
    'chat.write',
  ],
  viewer: [
    'dashboard.read',
    'markets.read',
    'trades.read',
    'users.read',
    'finance.read',
    'settings.read',
    'content.read',
    'audit.read',
    'payments.read',
    'deposits.read',
    'withdrawals.read',
    'chat.read',
    'system.read',
  ],
};

/** Human-readable matrix for the admin UI. */
export const PERMISSION_MATRIX: Array<{ permission: Permission; roles: Record<StaffRole, boolean> }> = PERMISSIONS.map(
  (permission) => ({
    permission,
    roles: Object.fromEntries(STAFF_ROLES.map((role) => [role, ROLE_PERMISSIONS[role].includes(permission)])) as Record<
      StaffRole,
      boolean
    >,
  }),
);

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}

export function permissionsFor(role: StaffRole | null | undefined): Permission[] {
  return role ? (ROLE_PERMISSIONS[role] ?? []) : [];
}

export function can(role: StaffRole | null | undefined, permission: Permission): boolean {
  return Boolean(role && (ROLE_PERMISSIONS[role] ?? []).includes(permission));
}
