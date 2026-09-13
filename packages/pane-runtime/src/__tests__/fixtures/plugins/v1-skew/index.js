// The README's headline skew: a v1 plugin exporting the v1 member name,
// `validateProfile`, and not v2's `validatePreset`. Nothing upstream catches
// it — `apiVersion: 1` parses, because the manifest guard only refuses
// versions ABOVE the host's — so the loader's required-member check is the
// one thing that refuses this, and it must NAME `validatePreset`.
export default () => ({
  buildCommand: () => [],
  validateProfile: () => ({ valid: true, issues: [] }),
  capabilities: () => [],
});
