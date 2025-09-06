# MCP SDK Client SSE.js

[![Actions Status](https://github.com/mybigday/mcp-sdk-client-ssejs/workflows/CI/badge.svg)](https://github.com/mybigday/mcp-sdk-client-ssejs/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/mcp-sdk-client-ssejs.svg)](https://www.npmjs.com/package/mcp-sdk-client-ssejs/)

Client transport alternative of [@modelcontextprotocol/sdk/client](https://www.npmjs.com/package/@modelcontextprotocol/sdk#writing-mcp-clients) base on [sse.js](https://www.npmjs.com/package/sse.js). The main purpose is make it working on React Native with [llama.rn](https://github.com/mybigday/llama.rn).

Supports:
- Streamable HTTP
- SSE

## Installation

```bash
npm install @modelcontextprotocol/sdk
npm install mcp-sdk-client-ssejs
```

- For use `@modelcontextprotocol/sdk` in React Native, you may need enable `unstable_enablePackageExports: true` in the project's metro config.
- Or you can try to use `babel-plugin-module-resolver` to alias the `@modelcontextprotocol/sdk` to `@modelcontextprotocol/sdk/dist/esm` in babel config:
```js
module.exports = {
  presets: [/* ... */],
  plugins: [
    // ...
    [
      'module-resolver',
      {
        alias: {
          '@modelcontextprotocol/sdk': '@modelcontextprotocol/sdk/dist/esm',
        },
      },
    ],
  ],
}
```

## Usage

The usage is the most same as the original [@modelcontextprotocol/sdk/client](https://github.com/modelcontextprotocol/typescript-sdk?tab=readme-ov-file#writing-mcp-clients), but you need to use `SSEJSStreamableHTTPClientTransport` or `SSEJSClientTransport` instead of `StreamableHTTPClientTransport` or `SSEClientTransport`. (There are no STDIO support in this package.)

### SSEJSStreamableHTTPClientTransport

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEJSStreamableHTTPClientTransport } from 'mcp-sdk-client-ssejs'

const transport = new SSEJSStreamableHTTPClientTransport(
  'http://<your-mcp-server-sse-endpoint-url>', 
  { /* TransportOptions */ },
)

const client = new Client({
  name: 'example-client',
  version: '1.0.0',
})

await client.connect(transport)

// List prompts
const prompts = await client.listPrompts()

// Get a prompt
const prompt = await client.getPrompt({
  name: 'example-prompt',
  arguments: {
    arg1: 'value',
  },
})

// List resources
const resources = await client.listResources()

// Read a resource
const resource = await client.readResource({
  uri: 'file:///example.txt',
})

// Call a tool
const result = await client.callTool({
  name: 'example-tool',
  arguments: {
    arg1: 'value',
  },
})
```

### SSEJSClientTransport

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEJSClientTransport } from 'mcp-sdk-client-ssejs'

const transport = new SSEJSClientTransport(
  'http://<your-mcp-server-sse-endpoint-url>',
  { /* TransportOptions */ },
)

const client = new Client({
  name: 'example-client',
  version: '1.0.0',
})

await client.connect(transport)

// Usage is the same as with SSEJSStreamableHTTPClientTransport
```

## Use fetch / URL as optional parameters

Both transport options accept `URL` and `fetch` options.

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEJSStreamableHTTPClientTransport, SSEJSClientTransport } from 'mcp-sdk-client-ssejs'

// Example: Use whatwg-url-without-unicode
import { URL } from 'whatwg-url-without-unicode'

// For SSEJSStreamableHTTPClientTransport
const streamableTransport = new SSEJSStreamableHTTPClientTransport(
  'http://<your-mcp-server-sse-endpoint-url>'
  {
    URL,
    // Example: Custom fetch implementation
    fetch: (...args) => fetch(...args),
  },
)

// Or for SSEJSClientTransport
const transport = new SSEJSClientTransport(
  'http://<your-mcp-server-sse-endpoint-url>',
  {
    URL,
    fetch: (...args) => fetch(...args),
  },
)
```

## Use cases

- [BRICKS](https://bricks.tools) - Our product for building interactive signage in simple way. We provide AI functions as Generator LLM/Assistant/MCP/MCPServer.
  - The Generator MCP (Client) is based on this package.

## License

MIT

---

<p align="center">
  <a href="https://bricks.tools">
    <img width="90px" src="https://avatars.githubusercontent.com/u/17320237?s=200&v=4">
  </a>
  <p align="center">
    Built and maintained by <a href="https://bricks.tools">BRICKS</a>.
  </p>
</p>
