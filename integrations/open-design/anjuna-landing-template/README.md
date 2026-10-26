# Anjuna landing template (Open Design plugin)

This Open Design plugin makes the local coding agent build a static lead-gen landing template, check it against the template contract and submit it as a ZIP to the template MCP worker (`POST /submit-zip`). The owner then approves it in the dashboard under Templates.

## Install

```sh
od plugin install ./integrations/open-design/anjuna-landing-template
```

## Builder key

The agent reads the key from the `ANJUNA_BUILDER_KEY` environment variable. Create a key in the dashboard on the Builder keys screen, then set the variable in the environment that starts Open Design and its agent:

```sh
export ANJUNA_BUILDER_KEY=<builder key>
```

```powershell
setx ANJUNA_BUILDER_KEY "<builder key>"
```

Restart Open Design after `setx` so the agent sees the variable. Never commit the key or paste it into a prompt.

## Optional: connect the MCP server

With the MCP server connected, the agent reads the live contract with `get_template_contract` and can run `check_template` before it submits.

```sh
claude mcp add --scope project --transport http anjuna-template https://<host>/mcp --header 'Authorization: Bearer ${ANJUNA_BUILDER_KEY}'
```

The single quotes keep the shell from expanding the variable. `--scope project` writes `.mcp.json` in the Open Design project folder. Claude Code stores `${ANJUNA_BUILDER_KEY}` there as written and expands `${VAR}` in `.mcp.json` headers when it starts, so the key never lands in the file.

`<host>` is the template MCP host. The ZIP upload goes to the same host at `/submit-zip`.

## Run

Pick the plugin in Open Design and fill in:

- `brandName`: the template name, for example `Harbor Funding`.
- `templateId`: a lowercase slug, for example `harbor-funding`. Send the same id again to add a new version.

The owner runbook is `docs/runbooks/open-design-templates.md`.
