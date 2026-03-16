import packageJson from "../package.json" with { type: "json" };

export const APP_ID = packageJson.name;
export const APP_VERSION = packageJson.version;
export const PROTOCOL_VERSION = 3;
export const OPENCLAW_NODE_HOST_CLIENT_ID = "node-host";
