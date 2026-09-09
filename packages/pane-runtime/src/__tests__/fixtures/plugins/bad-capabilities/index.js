// Claims `resume` with no resume object. Loading this would give a restart
// that silently begins a fresh conversation while looking like it continued.
export default () => ({
  buildCommand: () => [],
  validateProfile: () => ({ valid: true, issues: [] }),
  capabilities: () => ["resume"],
});
