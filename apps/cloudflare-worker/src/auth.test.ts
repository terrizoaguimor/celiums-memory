import { describe, expect, it } from 'vitest';
import { resolveTenant } from './auth';

const env = {
  MYCELIUM_API_KEYS: 'key-a:tenant-a:user-a:subject-a:owner,key-b:tenant-b:user-b:subject-b:reader',
};

describe('resolveTenant', () => {
  it('resolves the tenant bound to a valid bearer key', () => {
    const request = new Request('https://memory.example/mcp', {
      headers: {
        Authorization: 'Bearer key-a',
        'x-celiums-tenant-id': 'tenant-a',
      },
    });

    expect(resolveTenant(request, env)).toBe('tenant-a');
  });

  it('rejects a tenant header that does not match the key record', () => {
    const request = new Request('https://memory.example/mcp', {
      headers: {
        Authorization: 'Bearer key-a',
        'x-celiums-tenant-id': 'tenant-b',
      },
    });

    expect(resolveTenant(request, env)).toBeNull();
  });

  it('rejects malformed key records instead of partially parsing them', () => {
    const request = new Request('https://memory.example/mcp', {
      headers: {
        Authorization: 'Bearer key-a',
        'x-celiums-tenant-id': 'tenant-a',
      },
    });

    expect(resolveTenant(request, { MYCELIUM_API_KEYS: 'key-a:tenant-a' })).toBeNull();
  });

  it('rejects requests without both authentication headers', () => {
    const request = new Request('https://memory.example/mcp', {
      headers: { Authorization: 'Bearer key-a' },
    });

    expect(resolveTenant(request, env)).toBeNull();
  });
});
