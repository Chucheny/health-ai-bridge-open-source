import { ApiError } from './protocol.mts';

// Never return pg message/detail/SQL: those may contain private values or secrets.
export function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}
export function canSplitQuery(error: unknown): boolean {
  return ['57014', '53200', '53400'].includes(sqlState(error) ?? '');
}
export function queryFailure(error: unknown) {
  const state = sqlState(error);
  const code = error instanceof ApiError ? error.code :
    state === '57014' ? 'query_timeout' :
    ['53200', '53400'].includes(state ?? '') ? 'query_resource_limit' :
    state === '42501' ? 'database_permission_denied' :
    state?.startsWith('08') || ['53300','57P01','57P02','57P03'].includes(state ?? '') ? 'database_unavailable' :
    state?.startsWith('22') ? 'query_data_error' : 'query_internal_error';
  return { code, ...(state ? { sqlState: state } : {}),
    retryable: canSplitQuery(error) || code === 'database_unavailable',
    partialResultsReturned: false };
}
