# Package Manager

This project uses **Bun** exclusively as the package manager and runtime.

- Use `bun install` to install dependencies (not `npm install` or `pnpm install`)
- Use `bun run <script>` to run package.json scripts
- Use `bun add <package>` to add dependencies
- Use `bunx` for one-off package execution (not `npx` or `pnpx`)

Do not use npm, pnpm, or yarn for any operations in this project.
