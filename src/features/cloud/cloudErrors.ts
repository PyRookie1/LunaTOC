/** Machine-readable cloud failures; display copy does not control retry policy. */
export type CloudErrorCode =
  'network' | 'timeout' | 'precondition' | 'rate-limit' | 'auth' | 'quota';
export class CloudOperationError extends Error {
  constructor(
    readonly code: CloudErrorCode,
    message: string,
  ) {
    super(message);
  }
}
