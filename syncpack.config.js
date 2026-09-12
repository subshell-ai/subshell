module.exports = {
  "sortFirst": ["name", "description", "version", "license", "type", "private", "main", "exports", "types", "homepage", "repository", "bugs", "author", "keywords", "scripts", "dependencies", "devDependencies", "peerDependencies", "resolutions"],
  "sortAz": [],
  "semverGroups": [{
    "range": "",
    "dependencyTypes": ["prod", "dev", "resolutions", "overrides"],
    "dependencies": ["**"],
    "packages": ["**"]
  }],
  "versionGroups": [
    {
      "label": "use workspace protocol for local packages",
      "dependencies": ["$LOCAL"],
      "dependencyTypes": ["!local"],
      "pinVersion": "workspace:*"
    }
  ]
}
