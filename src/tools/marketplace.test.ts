import { describe, expect, test } from 'bun:test';
import {
  createMarketplaceTools,
  resolveFinalizedOrchestratorIdentities,
} from './marketplace';

function fixture() {
  const calls: unknown[][] = [];
  const service = {
    projectDir: '/workspace',
    list: () => [{ id: 'x' }],
    show: (id: string) => ({ id }),
    verify: (id?: string) => [{ id, valid: true }],
    status: () => ({
      liveAvailable: false,
      livePackages: null,
      reloadRequired: null,
    }),
    requestReload: () => ({ accepted: false, reloadRequired: null }),
    installRemote: async (target: string) => {
      calls.push(['install', target]);
      return {};
    },
    importFile: (path: string) => {
      calls.push(['import', path]);
      return {};
    },
    updateRemote: async (target: string) => {
      calls.push(['update', target]);
      return {};
    },
    updateFile: (path: string) => {
      calls.push(['update_file', path]);
      return {};
    },
    remove: (target: string) => calls.push(['remove', target]),
    enable: (target: string) => calls.push(['enable', target]),
    disable: (target: string) => calls.push(['disable', target]),
  };
  return { calls, service: service as never };
}

describe('marketplace tools', () => {
  test('exposes fixed action enum schemas and orchestrator alias guard', async () => {
    const { service } = fixture();
    const tools = createMarketplaceTools({
      service,
      orchestratorIdentities: new Set(['workflow-lead']),
      cwd: '/project',
    });
    expect(Object.values(tools.marketplace_inspect.args.action.enum)).toEqual([
      'list',
      'show',
      'verify',
      'status',
      'request_reload',
    ]);
    expect(Object.values(tools.marketplace_manage.args.action.enum)).toEqual([
      'install',
      'import',
      'update',
      'update_file',
      'remove',
      'enable',
      'disable',
    ]);
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      inspect.execute({ action: 'list' } as never, { agent: 'fixer' } as never),
    ).rejects.toThrow('only to the orchestrator');
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'list' } as never,
          { agent: 'workflow-lead' } as never,
        ),
      ),
    ).toEqual([{ id: 'x' }]);
  });

  test('uses live finalized identity and rejects calls before registry readiness', async () => {
    let finalized = false;
    const tools = createMarketplaceTools({
      service: fixture().service,
      getOrchestratorIdentities: () => {
        if (!finalized) throw new Error('not ready');
        return new Set(['orchestrator', 'host-lead']);
      },
    });
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      inspect.execute(
        { action: 'list' } as never,
        { agent: 'host-lead' } as never,
      ),
    ).rejects.toThrow('until the agent registry is finalized');
    finalized = true;
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'list' } as never,
          { agent: 'host-lead' } as never,
        ),
      ),
    ).toEqual([{ id: 'x' }]);
  });

  test('rejects a shared orchestrator/fixer display alias but keeps canonical access', async () => {
    const identities = resolveFinalizedOrchestratorIdentities({
      agentNames: ['orchestrator', 'fixer'],
      identities: { orchestrator: 'Lead', fixer: 'Lead' },
    });
    expect(identities).toEqual(new Set(['orchestrator']));

    const tools = createMarketplaceTools({
      service: fixture().service,
      getOrchestratorIdentities: () => identities,
    });
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      inspect.execute({ action: 'list' } as never, { agent: 'Lead' } as never),
    ).rejects.toThrow('only to the orchestrator');
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'list' } as never,
          { agent: 'orchestrator' } as never,
        ),
      ),
    ).toEqual([{ id: 'x' }]);
  });

  test('management adapters resolve files against cwd and never claim reload', async () => {
    const { calls, service } = fixture();
    const tools = createMarketplaceTools({ service, cwd: '/project' });
    const manage = tools.marketplace_manage as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await manage.execute(
      { action: 'import', target: 'bundle.json' } as never,
      { agent: 'orchestrator' } as never,
    );
    await manage.execute(
      { action: 'enable', target: 'author/name' } as never,
      { agent: 'orchestrator' } as never,
    );
    expect(calls).toEqual([
      ['import', '/project/bundle.json'],
      ['enable', 'author/name'],
    ]);
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'request_reload' } as never,
          { agent: 'orchestrator' } as never,
        ),
      ),
    ).toMatchObject({ accepted: false, reloadRequired: null });
  });

  test('rejects blank targets at execution even if a caller bypasses schema parsing', async () => {
    const tools = createMarketplaceTools({ service: fixture().service });
    const manage = tools.marketplace_manage as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      manage.execute(
        { action: 'enable', target: '   ' } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('nonblank');
  });
});
