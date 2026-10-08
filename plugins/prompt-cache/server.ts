import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { SETTINGS } from "./settings";

/** The app reads thread events itself; the server only owns the settings form. */
export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.settings.define(SETTINGS);
}
