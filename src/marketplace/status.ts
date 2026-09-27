import type { MarketplaceLivePackage } from '../agents/registry.js';
import { resolveEffectiveAgentOverrides } from '../config/effective-agent-overrides.js';
import {
  findPluginConfigPaths,
  loadPluginConfig,
  loadPluginConfigFromPath,
  mergePluginConfigs,
} from '../config/loader.js';
import {
  PresetResolutionError,
  resolvePresetDefinition,
} from '../config/presets.js';
import { discoverProjectLocalSkillNames } from '../config/project-skills.js';
import { marketplaceConfigFingerprint } from './config-identity.js';
import type { MarketplaceStore } from './store.js';

export interface MarketplaceRuntimeStatus {
  readonly desiredPackageIds: readonly string[];
  readonly verifications: readonly {
    readonly id: string;
    readonly version?: string;
    readonly valid: boolean;
    readonly expectedDigest?: string;
    readonly actualDigest?: string;
    readonly message: string;
  }[];
  readonly liveAvailable: boolean;
  readonly livePackages: readonly MarketplaceLivePackage[] | null;
  readonly reloadRequired: boolean | null;
  readonly lockfileError?: string;
  readonly operationalError?: string;
}

export interface MarketplaceReloadRequest extends MarketplaceRuntimeStatus {
  readonly accepted: false;
  readonly reloadRequired: boolean | null;
  readonly message: string;
}

function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function readDesiredMarketplacePackageIds(
  directory: string,
  presetOverride?: string,
): readonly string[] {
  const paths = findPluginConfigPaths(directory);
  const userConfig = paths.userConfigPath
    ? (loadPluginConfigFromPath(paths.userConfigPath, { silent: true }) ?? {})
    : {};
  const projectConfig = paths.projectConfigPath
    ? loadPluginConfigFromPath(paths.projectConfigPath, { silent: true })
    : null;
  const config = projectConfig
    ? mergePluginConfigs(userConfig, projectConfig)
    : userConfig;
  const presetName =
    presetOverride ?? process.env.OH_MY_OPENCODE_SLIM_PRESET ?? config.preset;
  if (!presetName) return [];
  const presets = config.presets ?? {};
  if (!presets[presetName]) return [];
  try {
    return [
      ...(resolvePresetDefinition(presetName, presets).marketplace?.agents ??
        []),
    ].sort(textOrder);
  } catch (error) {
    if (error instanceof PresetResolutionError) return [];
    throw error;
  }
}

/** Read desired config and package verification without changing marketplace state. */
export function readMarketplaceRuntimeStatus(input: {
  readonly directory: string;
  readonly store: Pick<MarketplaceStore, 'inspectAll'>;
  readonly livePackages?: readonly MarketplaceLivePackage[];
}): MarketplaceRuntimeStatus {
  const desiredPackageIds = readDesiredMarketplacePackageIds(input.directory);
  const freshConfig = loadPluginConfig(input.directory, { silent: true });
  const effectiveAgentOverrides = resolveEffectiveAgentOverrides(
    freshConfig.agents ?? {},
    () => discoverProjectLocalSkillNames(input.directory),
  );
  const inspection = input.store.inspectAll();
  const wanted = new Set(desiredPackageIds);
  const observedVerifications = new Map(
    inspection.verifications
      .filter(({ id }) => wanted.has(id))
      .map((verification) => [verification.id, verification]),
  );
  const verifications = desiredPackageIds.map(
    (id) =>
      observedVerifications.get(id) ?? {
        id,
        valid: false,
        message: inspection.lockfileError ?? `${id} is not installed`,
      },
  );
  const liveAvailable = input.livePackages !== undefined;
  const livePackages = input.livePackages
    ? [...input.livePackages].sort((left, right) =>
        textOrder(left.id, right.id),
      )
    : null;
  const diskPackages = new Map(
    inspection.packages
      .filter(({ manifest }) => wanted.has(manifest.id))
      .map((stored) => [stored.manifest.id, stored]),
  );
  const freshFingerprints = new Map(
    [...diskPackages].map(([id, stored]) => [
      id,
      marketplaceConfigFingerprint({
        id,
        runtimeName: stored.manifest.agentName,
        version: stored.manifest.version,
        digest: stored.digest,
        agentOverride: effectiveAgentOverrides[stored.manifest.agentName],
      }),
    ]),
  );
  const verificationById = new Map(
    verifications.map((item) => [item.id, item]),
  );
  const liveById = new Map((livePackages ?? []).map((item) => [item.id, item]));
  const reloadRequired: boolean | null = !liveAvailable
    ? null
    : desiredPackageIds.length !== (livePackages?.length ?? 0) ||
      desiredPackageIds.some((id) => {
        const live = liveById.get(id);
        const current = diskPackages.get(id);
        const verification = verificationById.get(id);
        return (
          !live ||
          !current ||
          !verification?.valid ||
          live.version !== current.manifest.version ||
          live.digest !== current.digest ||
          live.configFingerprint !== freshFingerprints.get(id)
        );
      });

  return {
    desiredPackageIds,
    verifications,
    liveAvailable,
    livePackages,
    reloadRequired,
    ...(inspection.lockfileError
      ? { lockfileError: inspection.lockfileError }
      : {}),
    ...(inspection.operationalError
      ? { operationalError: inspection.operationalError }
      : {}),
  };
}

/** Report the host action required; this deliberately never attempts a reload. */
export function requestMarketplaceReload(input: {
  readonly directory: string;
  readonly store: Pick<MarketplaceStore, 'inspectAll'>;
  readonly livePackages?: readonly MarketplaceLivePackage[];
}): MarketplaceReloadRequest {
  const status = readMarketplaceRuntimeStatus(input);
  return {
    ...status,
    accepted: false,
    message: status.liveAvailable
      ? status.reloadRequired
        ? 'A host reload is required to apply the desired marketplace state. Restart or reload OpenCode from the host; no reload was performed.'
        : status.reloadRequired === false
          ? 'The live marketplace snapshot already matches the desired state. No reload was performed.'
          : 'Whether a host reload is required is unknown. Restart or reload OpenCode from the host to apply the desired state; no reload was performed.'
      : 'The live marketplace snapshot is unavailable in this standalone context. Restart or reload OpenCode from the host to apply the desired state; no reload was performed.',
  };
}
