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
    uninstallGlobal: (target: string, acknowledge: boolean) => {
      calls.push(['uninstall', target, acknowledge]);
      return { uninstalled: true };
    },
    enable: (target: string, scope: string) =>
      calls.push(['enable', target, scope]),
    disable: (target: string, scope: string) =>
      calls.push(['disable', target, scope]),
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
      'uninstall',
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

  test('does not treat orchestrator as canonical when a specialist owns that visible name', async () => {
    const identities = resolveFinalizedOrchestratorIdentities({
      agentNames: ['orchestrator', 'fixer'],
      identities: { orchestrator: 'Lead', fixer: 'orchestrator' },
    });
    expect(identities).toEqual(new Set(['Lead']));

    const tools = createMarketplaceTools({
      service: fixture().service,
      getOrchestratorIdentities: () => identities,
    });
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      inspect.execute(
        { action: 'list' } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('only to the orchestrator');
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'list' } as never,
          { agent: 'Lead' } as never,
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
      ['enable', 'author/name', 'project'],
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

  test('requires acknowledgement before global uninstall', async () => {
    const { calls, service } = fixture();
    const tools = createMarketplaceTools({ service });
    const manage = tools.marketplace_manage as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };

    await expect(
      manage.execute(
        { action: 'uninstall', target: 'author/package' } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('acknowledge_other_projects: true');
    expect(calls).toEqual([]);

    await manage.execute(
      {
        action: 'uninstall',
        target: 'author/package',
        acknowledge_other_projects: true,
      } as never,
      { agent: 'orchestrator' } as never,
    );
    expect(calls).toEqual([['uninstall', 'author/package', true]]);
  });

  test('routes activation scope and rejects scope for unrelated actions', async () => {
    const { calls, service } = fixture();
    const tools = createMarketplaceTools({ service });
    const manage = tools.marketplace_manage as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };

    await manage.execute(
      { action: 'disable', target: 'author/package', scope: 'user' } as never,
      { agent: 'orchestrator' } as never,
    );
    expect(calls).toEqual([['disable', 'author/package', 'user']]);
    await expect(
      manage.execute(
        { action: 'install', target: 'author/package', scope: 'user' } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('scope is only supported by enable and disable');
    expect(calls).toHaveLength(1);
  });
});
