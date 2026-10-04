import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgents } from '../agents';
import { discoverProjectLocalSkillNames } from './project-skills';
import { RuntimeConfig } from './runtime';
import { PluginConfigSchema } from './schema';

const tempDirs: string[] = [];

function makeProject(): string {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'omo-local-skills-'),
  );
  tempDirs.push(projectDir);
  return projectDir;
}

function writeSkill(
  projectDir: string,
  relativeDir: string,
  name: string,
): void {
  const skillDir = path.join(projectDir, '.opencode', 'skills', relativeDir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} project skill\n---\n\n# ${name}\n`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    RuntimeConfig.reset(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverProjectLocalSkillNames', () => {
  test('includes ancestor skills above Git boundaries without siblings or duplicates', () => {
    const workspace = makeProject();
    const repository = path.join(workspace, 'repository');
    const worktree = path.join(repository, '.slim', 'worktrees', 'feature');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ignored-fixture');
    writeSkill(workspace, 'shared', 'shared');
    writeSkill(repository, 'repository', 'repository');
    writeSkill(worktree, 'shared', 'shared');
    writeSkill(worktree, 'local', 'local');
    writeSkill(path.join(workspace, 'sibling'), 'sibling', 'sibling');

    expect(discoverProjectLocalSkillNames(worktree)).toEqual([
      'local',
      'repository',
      'shared',
    ]);
  });

  test('skips symlinked ancestor roots without discarding valid local skills', () => {
    const workspace = makeProject();
    const external = makeProject();
    const worktree = path.join(workspace, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    writeSkill(external, 'external', 'external');
    fs.mkdirSync(path.join(workspace, '.opencode'), { recursive: true });
    fs.symlinkSync(
      path.join(external, '.opencode', 'skills'),
      path.join(workspace, '.opencode', 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeSkill(worktree, 'local', 'local');
    expect(discoverProjectLocalSkillNames(worktree)).toEqual(['local']);
  });

  test('does not follow symlinked skill entries in ancestor roots', () => {
    const workspace = makeProject();
    const external = makeProject();
    const worktree = path.join(workspace, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    writeSkill(workspace, 'shared', 'shared');
    writeSkill(external, 'external', 'external');
    fs.symlinkSync(
      path.join(external, '.opencode', 'skills', 'external'),
      path.join(workspace, '.opencode', 'skills', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(discoverProjectLocalSkillNames(worktree)).toEqual(['shared']);
  });

  test('discovers nested skills by frontmatter name and ignores invalid files', () => {
    const projectDir = makeProject();
    writeSkill(
      projectDir,
      'folder-name-does-not-matter',
      'project-architecture',
    );
    writeSkill(projectDir, 'nested/testing', 'project-testing');
    const invalidDir = path.join(projectDir, '.opencode', 'skills', 'invalid');
    fs.mkdirSync(invalidDir, { recursive: true });
    fs.writeFileSync(
      path.join(invalidDir, 'SKILL.md'),
      '# missing frontmatter name',
    );

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual([
      'project-architecture',
      'project-testing',
    ]);
  });

  test('returns an empty list when the project has no local skills directory', () => {
    expect(discoverProjectLocalSkillNames(makeProject())).toEqual([]);
  });

  test('does not follow a project skills root that resolves outside the project', () => {
    const projectDir = makeProject();
    const externalDir = makeProject();
    const externalSkillsRoot = path.join(externalDir, 'shared-skills');
    const externalSkillDir = path.join(externalSkillsRoot, 'external-skill');
    fs.mkdirSync(externalSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(externalSkillDir, 'SKILL.md'),
      '---\nname: external-skill\ndescription: external\n---\n',
    );

    const opencodeDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.symlinkSync(
      externalSkillsRoot,
      path.join(opencodeDir, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(discoverProjectLocalSkillNames(projectDir)).toEqual([]);
  });
});

describe('skills_include_local', () => {
  test('grants ancestor skills in worktrees while skills_remove still wins', () => {
    const workspace = makeProject();
    const worktree = path.join(workspace, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    writeSkill(workspace, 'shared', 'shared');
    writeSkill(workspace, 'excluded', 'excluded');
    writeSkill(worktree, 'local', 'local');
    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills_include_local: true,
          skills_remove: ['excluded'],
        },
      },
    });
    const runtime = RuntimeConfig.createDetached(worktree, config);
    const oracle = createAgents(runtime, { projectDirectory: worktree }).find(
      (agent) => agent.name === 'oracle',
    );
    const permissions = oracle?.config.permission?.skill as
      | Record<string, string>
      | undefined;
    expect(permissions?.shared).toBe('allow');
    expect(permissions?.local).toBe('allow');
    expect(permissions?.excluded).not.toBe('allow');
  });

  test('adds all project .opencode/skills entries to an agent effective skills', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-architecture', 'project-architecture');
    writeSkill(projectDir, 'nested/project-testing', 'project-testing');

    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills: ['codemap'],
          skills_include_local: true,
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const runtime = RuntimeConfig.get(projectDir);
    const oracle = createAgents(runtime, { projectDirectory: projectDir }).find(
      (agent) => agent.name === 'oracle',
    );
    const skillPermissions = oracle?.config.permission?.skill as
      | Record<string, string>
      | undefined;

    expect(skillPermissions?.codemap).toBe('allow');
    expect(skillPermissions?.['project-architecture']).toBe('allow');
    expect(skillPermissions?.['project-testing']).toBe('allow');
  });

  test('skills_remove still wins over an automatically included local skill', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-architecture', 'project-architecture');
    writeSkill(projectDir, 'project-testing', 'project-testing');

    const config = PluginConfigSchema.parse({
      agents: {
        oracle: {
          skills_include_local: true,
          skills_remove: ['project-testing'],
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const effective = RuntimeConfig.get(projectDir).agents().oracle?.skills;

    expect(effective).toContain('project-architecture');
    expect(effective).not.toContain('project-testing');
  });

  test('preserves local-skill grants from a legacy alias across canonical config layers', () => {
    const projectDir = makeProject();
    writeSkill(projectDir, 'project-testing', 'project-testing');

    const config = PluginConfigSchema.parse({
      preset: 'local-project',
      presets: {
        'local-project': {
          explore: {
            skills_include_local: true,
          },
        },
      },
      agents: {
        explorer: {
          skills: ['codemap'],
        },
      },
    });

    RuntimeConfig.init(projectDir, config);
    const effective = RuntimeConfig.get(projectDir).agent('explorer')?.skills;

    expect(effective).toContain('codemap');
    expect(effective).toContain('project-testing');
  });
});
