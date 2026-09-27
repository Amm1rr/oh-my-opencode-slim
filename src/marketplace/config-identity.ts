import { createHash } from 'node:crypto';

const EFFECTIVE_AGENT_FIELDS = [
  'description',
  'displayName',
  'hidden',
  'inheritModelFrom',
  'mcps',
  'model',
  'options',
  'permission',
  'prompt',
  'skills',
  'temperature',
  'tools',
  'variant',
  'color',
] as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

/** Hash only agent override fields consumed by marketplace registry assembly. */
export function marketplaceConfigFingerprint(input: {
  readonly id: string;
  readonly runtimeName: string;
  readonly version: string;
  readonly digest: string;
  readonly agentOverride: unknown;
}): string {
  const source =
    input.agentOverride && typeof input.agentOverride === 'object'
      ? (input.agentOverride as Record<string, unknown>)
      : {};
  const effectiveOverride = Object.fromEntries(
    EFFECTIVE_AGENT_FIELDS.filter((field) => field in source).map((field) => [
      field,
      source[field],
    ]),
  );
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          id: input.id,
          runtimeName: input.runtimeName,
          version: input.version,
          digest: input.digest,
          agentOverride: effectiveOverride,
        }),
      ),
    )
    .digest('hex');
}
