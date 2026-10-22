// Package entry for both OpenCode generations (OpenCode 1 >= 1.18.29).
//
// OpenCode 2 calls `setup` (src/v2/plugin.js). OpenCode 1 calls `server`,
// which lazy-imports the V1 entry: that module imports `@opencode-ai/plugin`,
// which an OpenCode 2 host does not provide, so it must never load there.
import v2 from "./src/v2/plugin.js";

export default {
  ...v2,
  async server(input, options) {
    const { TimeLoggerPlugin } = await import("./.opencode/plugins/time-logger.js");
    return TimeLoggerPlugin(input, options);
  },
};
