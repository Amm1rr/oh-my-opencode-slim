# Marketplace packages

Marketplace packages add third-party specialist agents. Package data is stored
locally and selected in the active preset; installing a package does not add it
to the running agent registry. Registry membership and permissions are frozen
for each plugin generation.

## CLI

Run commands from the project directory. Bundle paths are resolved relative to
the current working directory.

```sh
oh-my-opencode-slim marketplace install author/package
oh-my-opencode-slim marketplace import ./package.json
oh-my-opencode-slim marketplace list
oh-my-opencode-slim marketplace show author/package
oh-my-opencode-slim marketplace verify author/package
oh-my-opencode-slim marketplace enable author/package
oh-my-opencode-slim marketplace disable author/package
oh-my-opencode-slim marketplace update author/package
oh-my-opencode-slim marketplace update-file ./package.json
oh-my-opencode-slim marketplace remove author/package
oh-my-opencode-slim marketplace status
oh-my-opencode-slim marketplace request-reload
```

Commands reject unknown options, missing targets, and extra arguments. `install`
and `update` use the configured marketplace registry; `import` and
`update-file` read local JSON bundles. `enable`/`disable` persist activation
directives into the active preset. `remove` also removes config references.
Validation, service, and config failures return a nonzero exit status. A failed
verification also returns nonzero.

`status` compares installed desired packages with the live registry only when
called inside a running plugin generation. Standalone CLI status reports
`liveAvailable: false`, `livePackages: null`, and `reloadRequired: null`, since
it cannot inspect the host's in-memory agent registry.

## Orchestrator tools

The orchestrator can use `marketplace_inspect` (`list`, `show`, `verify`,
`status`, `request_reload`) and `marketplace_manage` (`install`, `import`,
`update`, `update_file`, `remove`, `enable`, `disable`). Both are restricted by
agent permissions and an execution-time orchestrator identity guard that
accounts for a configured orchestrator display alias.

Management tools mutate desired disk state only. `request_reload` only reports
whether restarting/reloading OpenCode is required; it never reloads the host or
claims that newly configured agents are already available. Restart OpenCode to
create a new plugin generation and agent registry.

## Preset selection

Marketplace activation lives under a preset's `marketplace` block. For example:

```jsonc
{
  "preset": "work",
  "presets": {
    "work": {
      "marketplace": {
        "agents_add": ["author/package"],
      },
    },
  },
}
```

Use the CLI `enable`/`disable` commands to update this state safely, including
layered presets. See [Marketplace package contract](marketplace-contract.md)
for bundle and registry schemas and [Configuration](configuration.md) for
config locations.
