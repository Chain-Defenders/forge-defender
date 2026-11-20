# KeyMoat

A test, a script or a dependency's build step runs with everything your user account can read, including private keys
in `.env` files and Solana keypairs. KeyMoat runs `forge`, `cast`, `anchor` and the others in a sandbox that cannot read
them, and blocks network connections the project has no reason to make.

ForgeDefender starts tools by name. When KeyMoat's links come first on the PATH that VS Code sees, every test run,
coverage run and trace from the editor is sandboxed too.

## The KeyMoat view

The **KeyMoat** view in the ForgeDefender sidebar shows:

- whether KeyMoat is installed, and whether its sandbox works on this machine;
- whether **editor runs are sandboxed**: whether the tools ForgeDefender starts go through KeyMoat. If they don't, it explains how to fix it;
- **keys in plain text** in your projects (from `keymoat scan`). Click one to open the line; **Move into encrypted storage** runs `keymoat keys move` in a terminal, where you choose a password;
- **blocked connections**: hosts a sandboxed command tried to reach from this project. **Allow** adds the host after asking you. Allow only hosts you recognise, such as your RPC provider.

It refreshes after each test run and from its refresh button. If KeyMoat is not installed, the view says so in one line,
with no pop-ups.

## When editor runs are not sandboxed

VS Code started from the Dock or the Start menu does not see the PATH your shell sets up. Either:

- start VS Code from a terminal with `code .`, so every extension and task uses KeyMoat; or
- click **Run ForgeDefender's tools through KeyMoat**, which points ForgeDefender's `forgeDefender.paths.*` settings at KeyMoat's links. This covers ForgeDefender only.
