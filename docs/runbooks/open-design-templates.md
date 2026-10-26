# Build landing templates with Open Design

Open Design (open-design.ai, Apache-2.0 desktop app) runs a local coding agent in a project folder. The `anjuna-landing-template` plugin makes that agent write a static site, zip it and send it to the template MCP worker at `https://mcp.aduplift.ai/submit-zip` with a builder key. The upload runs the same certification pipeline as the dashboard ZIP import. The owner approves the result in the dashboard.

## Owner steps

1. Install the Open Design desktop app from open-design.ai.
2. In Open Design, pick the local agent. Claude Code is the tested choice.
3. In the dashboard, open the Builder keys screen and create a key. Label it with the person or machine that uses it. The dashboard shows the key once.
4. Set the key as an environment variable for the agent:
   - macOS or Linux: `export ANJUNA_BUILDER_KEY=<builder key>` in the shell profile.
   - Windows: `setx ANJUNA_BUILDER_KEY "<builder key>"`, then restart Open Design.
5. Install the plugin from a checkout of this repository:
   ```sh
   od plugin install ./integrations/open-design/anjuna-landing-template
   ```
   The daemon resolves a local source against its own working directory and accepts only sources that start with `/`, `./` or `~`. On the Windows desktop app that directory is `%APPDATA%\Open Design\namespaces\release-stable-win\runtime`, and a drive path such as `H:/...` is read as a marketplace name. Copy the folder under the user profile and install it by a path relative to that directory (6 levels up is the profile):
   ```powershell
   Copy-Item .\integrations\open-design\anjuna-landing-template "$env:USERPROFILE\open-design-plugins\" -Recurse -Force
   $env:ELECTRON_RUN_AS_NODE = '1'
   $env:OD_DAEMON_URL = 'http://127.0.0.1:<daemon port>'
   & 'F:\DEV\open-design\Open Design.exe' 'F:\DEV\open-design\resources\app\prebundled\daemon\daemon-cli.mjs' plugin install './../../../../../../open-design-plugins/anjuna-landing-template'
   ```
   Use the install folder of your copy in place of `F:\DEV\open-design`. The `od` on PATH in Git Bash is the coreutils octal dump tool. The daemon port changes on every app start: `Get-NetTCPConnection -State Listen -OwningProcess (Get-Process 'Open Design').Id`.
6. Optional: connect the MCP server so the agent reads the live contract and can run `check_template`:
   ```sh
   claude mcp add --scope project --transport http anjuna-template https://mcp.aduplift.ai/mcp --header 'Authorization: Bearer ${ANJUNA_BUILDER_KEY}'
   ```
   The single quotes keep the shell from expanding the variable. `--scope project` writes `.mcp.json` in the Open Design project folder. Claude Code stores `${ANJUNA_BUILDER_KEY}` there as written and expands `${VAR}` in `.mcp.json` headers when it starts, so the key never lands in the file.
7. Run the plugin with the template name (for example `Harbor Funding`) and the template id slug (for example `harbor-funding`).
8. Watch the agent. It writes `site/`, zips it, submits it and fixes rejected issues until the status is `awaiting_approval` or `duplicate`.
9. Open Templates in the dashboard, review the screenshots and warnings, and approve the version.

## Troubleshooting

| Response | Cause | Fix |
|---|---|---|
| `401 missing_or_malformed_api_key` | `ANJUNA_BUILDER_KEY` is empty or not set in the agent's environment. | Set the variable and restart Open Design. |
| `401 invalid_api_key` | The key is wrong or revoked. | Create a new key on the Builder keys screen and set it again. |
| `429 rate_limited` | The key sent more than 60 requests in one minute. | Wait the seconds in the `retry-after` header and submit again. |
| `422 needs_build` | The ZIP holds a source project (`package.json`, `src/`, `.tsx` files) in place of built HTML. | Zip the built static folder (`site/` or `dist/`) only. |
| `422 invalid` | A bad `template_id` or `template_name`, a body that is not `multipart/form-data`, a missing file or an upload over 30 MB. | Read `message` or `issues` in the response and fix the request. |
| `200 rejected` | The site breaks the template contract. | The agent fixes every item in `issues` (`rule`, `file`, `message`, `fix`) and submits again. |
| `200 duplicate` | The same build was already submitted. | Nothing to do. Change the site to send a new version. |

The worker logs each upload as `submit_template_payload` with `via: "http_submit_zip"`, the template id and the key id. Refused keys appear as `auth_failure` lines in `wrangler tail`.
