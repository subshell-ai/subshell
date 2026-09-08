# npm Package Lookup

Query npmjs.com for package information.

## Usage

```
/npm <package-name>
```

## Instructions

When the user invokes this skill with a package name, fetch information about that npm package from the npm registry.

1. Use WebFetch to query the npm registry API at `https://registry.npmjs.org/<package-name>`
2. Extract and present the following information in a clear format:
   - **Package name** and **description**
   - **Latest version**
   - **License**
   - **Homepage** and **repository** URLs
   - **Weekly downloads** (if available, fetch from `https://api.npmjs.org/downloads/point/last-week/<package-name>`)
   - **Dependencies** (list the main dependencies)
   - **Keywords**
   - **Author/Maintainers**

3. If the package is not found, inform the user clearly.

4. If the user provides additional context (like "show me all versions" or "what are the peer dependencies"), adjust the output accordingly.

## Example Output

```
## lodash

**Description:** Lodash modular utilities.
**Latest Version:** 4.17.21
**License:** MIT
**Homepage:** https://lodash.com/
**Repository:** https://github.com/lodash/lodash

**Weekly Downloads:** 45,000,000+

**Keywords:** modules, stdlib, util

**Author:** John-David Dalton
```
