const API_KEY_PARTS = 5;
const TENANT_HEADER = 'x-celiums-tenant-id';

export interface TenantAuthEnvironment {
  MYCELIUM_API_KEYS?: string;
}

export function resolveTenant(
  request: Request,
  env: TenantAuthEnvironment,
): string | null {
  const supplied = request.headers.get(TENANT_HEADER);
  if (!supplied || !env.MYCELIUM_API_KEYS) return null;

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return null;

  const token = authorization.slice('Bearer '.length);
  const record = env.MYCELIUM_API_KEYS.split(',')
    .map((entry) => entry.trim().split(':'))
    .find(
      (parts) =>
        parts.length === API_KEY_PARTS &&
        parts[0] === token &&
        parts[1] === supplied,
    );

  return record ? supplied : null;
}
