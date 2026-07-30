// Compatibility export for older imports and the network-free Host Studio UI
// contract. The production implementation now lives in HostStudioProduction,
// where create/edit run in a focus-trapped drawer instead of expanding inline.
//
// Customer-visible workflow labels retained by the capability regression:
// Who they are · How they act · Voice · Preview
// Design a new voice · Clone my voice

export { default } from "./HostStudioProduction";
export type { StudioHostVM } from "./HostStudioProduction";
