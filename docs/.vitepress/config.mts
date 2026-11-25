import { defineConfig } from "vitepress";

// A static site: no analytics, no hosted search, no external fonts or scripts.
// The same markdown files ship in the npm package (docs/**/*.md) for agents to read offline.
export default defineConfig({
  title: "SAP UI Automation",
  description: "Let an agent see and drive the SAP screens you have open: SAP GUI for Windows, Web GUI and Fiori.",
  lang: "en",
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ["README.md", "node_modules/**"],
  // Links to repository files (src/, CONTRIBUTING.md, ...) use full GitHub URLs, so every relative link must resolve.
  ignoreDeadLinks: false,
  head: [["meta", { name: "robots", content: "index,follow" }]],
  themeConfig: {
    search: { provider: "local" },
    nav: [
      { text: "Get started", link: "/getting-started/choose" },
      { text: "Concepts", link: "/concepts/surfaces" },
      { text: "Guides", link: "/guides/chrome" },
      { text: "Reference", link: "/reference/tools" },
      { text: "Security", link: "/security" },
    ],
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Introduction", link: "/getting-started/" },
          { text: "Choose your setup", link: "/getting-started/choose" },
          { text: "Install in your client", link: "/getting-started/installation" },
          { text: "Set up with your agent", link: "/getting-started/setup-prompt" },
          { text: "Your first session", link: "/getting-started/first-session" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "Surfaces", link: "/concepts/surfaces" },
          { text: "The screen view", link: "/concepts/screen-view" },
          { text: "Ids and handles", link: "/concepts/ids" },
          { text: "Actions", link: "/concepts/actions" },
          { text: "Safety model", link: "/concepts/safety" },
          { text: "Confirm mode", link: "/concepts/confirm-mode" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Chrome: Web GUI and Fiori", link: "/guides/chrome" },
          { text: "SAP GUI for Windows (scripting)", link: "/guides/sap-gui-windows" },
          { text: "SAP GUI for Windows: network reader (experimental)", link: "/guides/network-reader" },
          { text: "CLI for coding agents", link: "/guides/cli-for-agents" },
          { text: "Writing tests with the SDK", link: "/guides/sdk-tests" },
          { text: "Recording and replay", link: "/guides/record-replay" },
          { text: "Trace viewer", link: "/guides/trace-viewer" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "MCP tools", link: "/reference/tools" },
          { text: "Actions", link: "/reference/actions" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "CLI commands", link: "/reference/cli" },
        ],
      },
      {
        text: "More",
        items: [
          { text: "Security and data handling", link: "/security" },
          { text: "Benchmarks", link: "/benchmarks" },
          { text: "Comparison", link: "/comparison" },
          { text: "FAQ and troubleshooting", link: "/faq" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/DidroAI/sap-ui-automation" }],
    editLink: { pattern: "https://github.com/DidroAI/sap-ui-automation/edit/main/docs/:path" },
    footer: {
      message: "MIT licence. Not affiliated with, endorsed by or sponsored by SAP SE. SAP and other SAP products are trademarks of SAP SE.",
    },
  },
});
