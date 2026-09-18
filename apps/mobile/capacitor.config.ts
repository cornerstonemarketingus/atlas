import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.cornerstonemarketingus.atlas",
  appName: "Atlas",
  webDir: "www",
  server: {
    url: "https://atlas-web.cornerstonemarketingus.workers.dev",
    cleartext: false,
    allowNavigation: ["atlas-web.cornerstonemarketingus.workers.dev"],
  },
  ios: { scheme: "Atlas" },
  android: { allowMixedContent: false },
};

export default config;
