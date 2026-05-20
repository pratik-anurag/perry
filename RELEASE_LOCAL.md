# Local VSIX Release

Use this workflow to build and install Perry locally from a `.vsix` file. This does not publish anything to the VS Code Marketplace and does not require Marketplace credentials, Azure DevOps, or a Personal Access Token.

## Build

```sh
npm install
npm run compile
npm run release:local
```

The generated VSIX filename follows this pattern:

```text
perry-code-context-<version>.vsix
```

For the current package version, expect:

```text
perry-code-context-0.1.2.vsix
```

## Inspect Package Contents

Before installing, you can list the files that will be included:

```sh
npm run package:check
```

## Install

Install with the VS Code CLI:

```sh
code --install-extension perry-code-context-0.1.2.vsix
```

Or install the latest generated VSIX in this directory:

```sh
npm run install:local
```

Manual VS Code UI method:

```text
Extensions panel -> three-dot menu -> Install from VSIX... -> choose the generated .vsix file
```

## Uninstall And Reinstall

The extension ID is usually:

```text
<publisher>.<name>
```

For this project:

```text
kitarpgaruna.perry-code-context
```

Uninstall:

```sh
code --uninstall-extension kitarpgaruna.perry-code-context
```

Reinstall:

```sh
code --install-extension perry-code-context-0.1.2.vsix
```

## Version Bumps

Before creating a new local release, update `version` in `package.json`.

Examples:

```text
0.0.1
0.0.2
0.1.0
```

After changing the version, run:

```sh
npm run release:local
```

## Release Checklist

- [ ] `npm install` succeeds
- [ ] `npm run compile` succeeds
- [ ] `npm run release:local` creates a `.vsix`
- [ ] `.vsix` installs successfully in VS Code
- [ ] Extension activates in Extension Development Host or installed VS Code
- [ ] Commands appear in Command Palette
- [ ] No unnecessary files are included in the package
