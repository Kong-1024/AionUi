/**
 * Shared type definitions for the ACP core protocol layer.
 *
 * These types are business-agnostic and derived from acpx (OpenClaw).
 * AionUi-specific types should NOT be added here.
 */

// ---------------------------------------------------------------------------
// Output error codes
// ---------------------------------------------------------------------------

export type OutputErrorCode =
  | 'RUNTIME'
  | 'TIMEOUT'
  | 'NO_SESSION'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_PROMPT_UNAVAILABLE'
  | 'USAGE';

/** Runtime array for validating unknown values against OutputErrorCode. */
export const OUTPUT_ERROR_CODES: readonly OutputErrorCode[] = [
  'RUNTIME',
  'TIMEOUT',
  'NO_SESSION',
  'PERMISSION_DENIED',
  'PERMISSION_PROMPT_UNAVAILABLE',
  'USAGE',
] as const;

// ---------------------------------------------------------------------------
// Output error origin
// ---------------------------------------------------------------------------

export type OutputErrorOrigin = 'client' | 'agent' | 'transport';

/** Runtime array for validating unknown values against OutputErrorOrigin. */
export const OUTPUT_ERROR_ORIGINS: readonly OutputErrorOrigin[] = ['client', 'agent', 'transport'] as const;

// ---------------------------------------------------------------------------
// ACP error payload
// ---------------------------------------------------------------------------

/** Structured ACP error extracted from JSON-RPC error responses. */
export type OutputErrorAcpPayload = {
  code: number;
  message: string;
  data?: unknown;
};

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE: 2,
  TIMEOUT: 3,
  NO_SESSION: 4,
  PERMISSION_DENIED: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

// ---------------------------------------------------------------------------
// Error classifier (extension point)
// ---------------------------------------------------------------------------

/**
 * A function that inspects an error and returns an OutputErrorCode if it
 * recognises the error, or undefined to defer to the next classifier.
 *
 * Used by `normalizeOutputError` and `isRetryablePromptError` to let
 * consumers (e.g. AionUi) plug in their own error-class mappings without
 * modifying the core module.
 */
export type ErrorClassifier = (error: unknown) => OutputErrorCode | undefined;
