// Omits `validateProfile`, which the adapter calls unconditionally.
export default () => ({ buildCommand: () => [], capabilities: () => [] });
