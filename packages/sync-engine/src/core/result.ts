import { ConfigError, SyncError, UnexpectedError } from "./errors";

/** Check `error`, not `result === null`: `result` may itself be null. */
export type Result<T, E extends SyncError = SyncError> =
  | { result: T; error: null }
  | { result: null; error: E };

/** `E` must list every `SyncError` that `fn` throws. */
export const toResult = async <T, E extends SyncError>(
  fn: () => Promise<T>,
): Promise<Result<T, E | UnexpectedError>> => {
  try {
    const result = await fn();
    return { result, error: null };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    if (error instanceof SyncError) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- thrown errors are untyped
      return { result: null, error: error as E };
    }
    return { result: null, error: new UnexpectedError(error) };
  }
};
