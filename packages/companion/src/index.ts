import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Astrogate companion. Loaded into every Pi session the controller starts.
 * Connects to the controller socket, injects the task envelope, reports state,
 * and exposes the role's tools. Nothing is wired yet.
 */
export default function astrogateCompanion(_pi: ExtensionAPI): void {}
