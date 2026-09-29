import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDesiredMarketplacePackageIds,
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
  test('empty preset environment value falls back to the configured preset', () => {
    const previousPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
    const fixture = setup(
      {
        preset: 'configured',
        presets: {
          configured: { marketplace: { agents: ['team/configured'] } },
        },
      },
      { packages: [], verifications: [] },
    );
    try {
      process.env.OH_MY_OPENCODE_SLIM_PRESET = '';
      expect(readDesiredMarketplacePackageIds(fixture.directory)).toEqual([
        'team/configured',
      ]);
    } finally {
      if (previousPreset === undefined) {
        delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
      } else {
        process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPreset;
      }
      fixture.cleanup();
    }
  });

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
          configFingerprint: 'generation-a',
        }),
      ]);
      const statusA = readMarketplaceRuntimeStatus({
        directory: fixture.directory,
        store: fixture.store,
        livePackages: liveA,
        desiredPackages: liveA,
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
        desiredPackages: [
          {
            ...liveA[0],
            version: '2.0.0',
            digest: 'digest-b',
            configFingerprint: 'generation-b',
          },
        ],
      });
      expect(statusChanged.reloadRequired).toBe(true);
      expect(statusChanged.livePackages).toEqual(liveA);

      const liveB = [
        {
          ...liveA[0],
          version: '2.0.0',
          digest: 'digest-b',
          configFingerprint: 'generation-b',
        },
      ];
      expect(
        readMarketplaceRuntimeStatus({
          directory: fixture.directory,
          store: { inspectAll: () => changedInspection },
          livePackages: liveB,
          desiredPackages: liveB,
        }).reloadRequired,
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('incomplete inventory makes reload status unknown and avoids restart advice', () => {
    const fixture = setup(
      {
        preset: 'active',
        presets: {
          active: { marketplace: { agents: ['team/example'] } },
        },
      },
      {
        packages: [],
        verifications: [],
        operationalError: 'Marketplace package inspection stopped early',
      },
    );
    try {
      const live = [
        {
          id: 'team/example',
          runtimeName: 'example',
          version: '1.0.0',
          digest: 'digest-a',
          configFingerprint: 'fingerprint-a',
        },
      ];
      const response = requestMarketplaceReload({
        directory: fixture.directory,
        store: fixture.store,
        livePackages: live,
        desiredPackages: live,
      });
      expect(response.reloadRequired).toBeNull();
      expect(response.diagnostics).toContain(
        'Marketplace package inspection stopped early',
      );
      expect(response.message).toContain('status is incomplete');
      expect(response.message).not.toContain('Restart or reload OpenCode');
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    [
      'missing selected package',
      { packages: [], verifications: [] },
      'team/example: team/example is not installed',
    ],
    [
      'verification-failed selected package',
      {
        packages: [packageA],
        verifications: [
          {
            id: 'team/example',
            version: '1.0.0',
            valid: false,
            expectedDigest: 'digest-expected',
            actualDigest: 'digest-a',
            message: 'package digest verification failed',
          },
        ],
      },
      'team/example: package digest verification failed',
    ],
  ] as const)(
    '%s blocks definite reload advice until package repair',
    (_name, inspection, diagnostic) => {
      const fixture = setup(
        {
          preset: 'active',
          presets: {
            active: { marketplace: { agents: ['team/example'] } },
          },
        },
        inspection as MarketplaceStoreInspection,
      );
      try {
        const response = requestMarketplaceReload({
          directory: fixture.directory,
          store: fixture.store,
          livePackages: [],
          desiredPackages: [],
        });
        expect(response.reloadRequired).toBeNull();
        expect(response.verifications[0]?.valid).toBe(false);
        expect(response.diagnostics).toContain(diagnostic);
        expect(response.message).toContain('Resolve the reported');
        expect(response.message).toContain('repair them');
        expect(response.message).not.toContain('Restart or reload OpenCode');
      } finally {
        fixture.cleanup();
      }
    },
  );

  test('requires reload when only a marketplace fallback-chain fingerprint changes', () => {
    const fixture = setup(
      {
        preset: 'active',
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
      const live = [
        {
          id: 'team/example',
          runtimeName: 'example',
          version: '1.0.0',
          digest: 'digest-a',
          configFingerprint: 'primary-plus-fallback-a',
        },
      ];
      const desired = [
        {
          ...live[0],
          configFingerprint: 'primary-plus-fallback-b',
        },
      ];
      expect(
        readMarketplaceRuntimeStatus({
          directory: fixture.directory,
          store: fixture.store,
          livePackages: live,
          desiredPackages: desired,
        }).reloadRequired,
      ).toBe(true);
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
      expect(response.reloadRequired).toBeNull();
      expect(response.diagnostics).toContain(
        'team/base: team/base is not installed',
      );
      expect(response.message).toContain('Resolve the reported');
      expect(response.liveAvailable).toBe(false);
      expect(response.reloadRequired).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});
