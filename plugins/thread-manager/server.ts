import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Uses the frontend SDK and host realtime cache; owns no copy of thread data.
export default function plugin(bb: BbPluginApi) {
  bb.log.info("Thread Manager loaded");
}
