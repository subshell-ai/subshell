// Omits `validatePreset`, a REQUIRED member of the published contract, so the
// loader must refuse it even though no control-plane code calls it today.
export default () => ({ buildCommand: () => [], capabilities: () => [] });
