import type { BbPluginApi } from "@get-bb/plugin-sdk";

// The switcher lives in the app and reads bb's live sidebar cache; no backend state.
export default function plugin(bb: BbPluginApi) {
  bb.log.info("Project Switcher loaded");
}
