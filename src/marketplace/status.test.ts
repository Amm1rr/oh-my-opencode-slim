import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marketplaceConfigFingerprint } from './config-identity.js';
import {
  readMarketplaceRuntimeStatus,
  requestMarketplaceReload,
} from './status.js';
import type { MarketplaceStoreInspection } from './store.js';

function setup(config: object, inspection: MarketplaceStoreInspection) {
  const directory = mkdtempSync(join(tmpdir(), 'marketplace-status-'));
  const configDirectory = join(directory, '.opencode');
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, 'oh-my-opencode-slim.json'),
    JSON.stringify(config),
  );
  let reads = 0;
  return {
    directory,
    writeConfig(next: object) {
      writeFileSync(
        join(configDirectory, 'oh-my-opencode-slim.json'),
        JSON.stringify(next),
      );
    },
    store: {
      inspectAll() {
        reads += 1;
        return inspection;
      },
    },
    readCount: () => reads,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const packageA = {
  manifest: {
    id: 'team/example',
    version: '1.0.0',
    agentName: 'example',
  },
  digest: 'digest-a',
  path: '/packages/a',
  source: { kind: 'in-memory' as const, label: 'test' },
};

describe('marketplace runtime status', () => {
  test('distinguishes fresh desired/current package state from frozen live state', () => {
    const fixture = setup(
      {
        preset: 'active',
        agents: {
          example: {
            prompt: 'generation A prompt',
            model: 'provider/model-a',
            permission: { read: 'ask' },
            displayName: 'Example A',
          },
        },
        presets: {
          active: { marketplace: { agents: ['team/example'] } },
        },
      },
      {
        packages: [packageA as never],
        verifications: [
          {
            id: 'team/example',
            version: '1.0.0',
            valid: true,
            expectedDigest: 'digest-a',
            actualDigest: 'digest-a',
            message: 'verified',
          },
        ],
      },
    );
    try {
      const liveA = Object.freeze([
        Object.freeze({
          id: 'team/example',
          runtimeName: 'example',
          version: '1.0.0',
          digest: 'digest-a',
          configFingerprint: marketplaceConfigFingerprint({
            id: 'team/example',
            runtimeName: 'example',
            version: '1.0.0',
            digest: 'digest-a',
            agentOverride: {
              prompt: 'generation A prompt',
              model: 'provider/model-a',
              permission: { read: 'ask' },
              displayName: 'Example A',
            },
          }),
        }),
      ]);
      const statusA = readMarketplaceRuntimeStatus({
        directory: fixture.directory,
        store: fixture.store,
        livePackages: liveA,
      });
      expect(statusA.reloadRequired).toBe(false);

      fixture.writeConfig({
        preset: 'active',
        agents: {
          example: {
            prompt: 'generation B prompt',
            model: 'provider/model-b',
            permission: { read: 'deny' },
            displayName: 'Example B',
          },
        },
        presets: {
          active: { marketplace: { agents: ['team/example'] } },
        },
      });
      const changedInspection: MarketplaceStoreInspection = {
        packages: [
          {
            ...packageA,
            manifest: {
              id: 'team/example',
              version: '2.0.0',
              agentName: 'example',
            },
            digest: 'digest-b',
          } as never,
        ],
        verifications: [
          {
            id: 'team/example',
            version: '2.0.0',
            valid: true,
            expectedDigest: 'digest-b',
            actualDigest: 'digest-b',
            message: 'verified',
          },
        ],
      };
      const statusChanged = readMarketplaceRuntimeStatus({
        directory: fixture.directory,
        store: { inspectAll: () => changedInspection },
        livePackages: liveA,
      });
      expect(statusChanged.reloadRequired).toBe(true);
      expect(statusChanged.livePackages).toEqual(liveA);

      const liveB = [
        {
          ...liveA[0],
          version: '2.0.0',
          digest: 'digest-b',
          configFingerprint: marketplaceConfigFingerprint({
            id: 'team/example',
            runtimeName: 'example',
            version: '2.0.0',
            digest: 'digest-b',
            agentOverride: {
              prompt: 'generation B prompt',
              model: 'provider/model-b',
              permission: { read: 'deny' },
              displayName: 'Example B',
            },
          }),
        },
      ];
      expect(
        readMarketplaceRuntimeStatus({
          directory: fixture.directory,
          store: { inspectAll: () => changedInspection },
          livePackages: liveB,
        }).reloadRequired,
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('allows unavailable live state and requestReload performs no mutations', () => {
    const fixture = setup(
      {
        preset: 'active',
        presets: {
          base: { marketplace: { agents: ['team/base'] } },
          active: {
            extends: 'base',
            marketplace: { agents_add: ['team/extra'] },
          },
        },
      },
      { packages: [], verifications: [] },
    );
    try {
      const standalone = readMarketplaceRuntimeStatus({
        directory: fixture.directory,
        store: fixture.store,
      });
      expect(standalone.liveAvailable).toBe(false);
      expect(standalone.reloadRequired).toBeNull();
      expect(standalone.desiredPackageIds).toEqual(['team/base', 'team/extra']);

      const before = fixture.readCount();
      const response = requestMarketplaceReload({
        directory: fixture.directory,
        store: fixture.store,
      });
      expect(fixture.readCount()).toBe(before + 1);
      expect(response.accepted).toBe(false);
      expect(response.message).toContain('Restart or reload OpenCode');
      expect(response.liveAvailable).toBe(false);
      expect(response.reloadRequired).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});
