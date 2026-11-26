import { AsyncLocalStorage } from "node:async_hooks";

/** Abort signal of the tool the user can stop from Editar. */
export const toolAbort = new AsyncLocalStorage<AbortSignal>();
