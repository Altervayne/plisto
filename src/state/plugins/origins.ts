/** Whether a declared network origin is a developer loopback address (the only `http` form). */
export const isDevOrigin = (origin: string): boolean => origin.startsWith("http://");
