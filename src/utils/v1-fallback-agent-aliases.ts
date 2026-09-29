const V1_FALLBACK_AGENT_PREFIX = 'slim-internal-fallback';

export type V1FallbackModelEntry = { id: string; variant?: string };

function aliasBase(agentName: string, index: number): string {
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${V1_FALLBACK_AGENT_PREFIX}-${safeName}-${index}`;
}

function isMatchingGeneratedAlias(
  value: unknown,
  agentName: string,
  model: string,
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    entry.name === agentName &&
    entry.model === model &&
    entry.mode === 'subagent' &&
    entry.hidden === true
  );
}

function availableAlias(
  base: string,
  configAgent: Record<string, unknown>,
  agentName: string,
  model: string,
): string {
  let alias = base;
  let suffix = 2;
  while (
    alias in configAgent &&
    !isMatchingGeneratedAlias(configAgent[alias], agentName, model)
  ) {
    alias = `${base}-${suffix}`;
    suffix += 1;
  }
  return alias;
}

/**
 * OpenCode v1 cannot select a task model per call. Install hidden aliases for
 * secondary chain entries without replacing configured agents or another
 * generated alias whose source name normalizes to the same key.
 */
export function installV1FallbackAgentAliases(
  configAgent: Record<string, unknown>,
  modelArrays: Record<string, V1FallbackModelEntry[]>,
): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const [agentName, chain] of Object.entries(modelArrays)) {
    const canonical = configAgent[agentName];
    if (
      canonical === null ||
      typeof canonical !== 'object' ||
      Array.isArray(canonical)
    ) {
      continue;
    }
    for (let index = 1; index < chain.length; index += 1) {
      const entry = chain[index];
      const alias = availableAlias(
        aliasBase(agentName, index),
        configAgent,
        agentName,
        entry.id,
      );
      const aliasConfig: Record<string, unknown> = {
        ...(canonical as Record<string, unknown>),
        name: agentName,
        mode: 'subagent',
        hidden: true,
        model: entry.id,
      };
      if (entry.variant) aliasConfig.variant = entry.variant;
      else delete aliasConfig.variant;
      configAgent[alias] = aliasConfig;
      aliases.set(`${agentName}\0${entry.id}`, alias);
    }
  }

  return aliases;
}
