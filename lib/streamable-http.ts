import { SSE } from 'sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  isInitializedNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  auth,
  AuthResult,
  OAuthClientProvider,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js'

// Default reconnection options for StreamableHTTP connections
const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS: StreamableHTTPReconnectionOptions =
  {
    initialReconnectionDelay: 1000,
    maxReconnectionDelay: 30000,
    reconnectionDelayGrowFactor: 1.5,
    maxRetries: 2,
  }

export class StreamableHTTPError extends Error {
  constructor(
    public readonly code: number | undefined,
    message: string | undefined,
  ) {
    super(`Streamable HTTP error: ${message}`)
  }
}

/**
 * Options for starting or authenticating an SSE connection
 */
interface StartSSEOptions {
  /**
   * The resumption token used to continue long-running requests that were interrupted.
   *
   * This allows clients to reconnect and continue from where they left off.
   */
  resumptionToken?: string

  /**
   * A callback that is invoked when the resumption token changes.
   *
   * This allows clients to persist the latest token for potential reconnection.
   */
  onresumptiontoken?: (token: string) => void

  /**
   * Override Message ID to associate with the replay message
   * so that response can be associate with the new resumed request.
   */
  replayMessageId?: string | number
}

/**
 * Configuration options for reconnection behavior of the SSEJSStreamableHTTPClientTransport.
 */
export interface StreamableHTTPReconnectionOptions {
  /**
   * Maximum backoff time between reconnection attempts in milliseconds.
   * Default is 30000 (30 seconds).
   */
  maxReconnectionDelay: number

  /**
   * Initial backoff time between reconnection attempts in milliseconds.
   * Default is 1000 (1 second).
   */
  initialReconnectionDelay: number

  /**
   * The factor by which the reconnection delay increases after each attempt.
   * Default is 1.5.
   */
  reconnectionDelayGrowFactor: number

  /**
   * Maximum number of reconnection attempts before giving up.
   * Default is 2.
   */
  maxRetries: number
}

export interface SseErrorEvent {
  status?: number
  data?: string
}

/**
 * Configuration options for the `SSEJSStreamableHTTPClientTransport`.
 */
export interface SSEJSStreamableHTTPClientTransportOptions {
  /**
   * An OAuth client provider to use for authentication.
   *
   * When an `authProvider` is specified and the connection is started:
   * 1. The connection is attempted with any existing access token from the `authProvider`.
   * 2. If the access token has expired, the `authProvider` is used to refresh the token.
   * 3. If token refresh fails or no access token exists, and auth is required, `OAuthClientProvider.redirectToAuthorization` is called, and an `UnauthorizedError` will be thrown from `connect`/`start`.
   *
   * After the user has finished authorizing via their user agent, and is redirected back to the MCP client application, call `SSEJSStreamableHTTPClientTransport.finishAuth` with the authorization code before retrying the connection.
   *
   * If an `authProvider` is not provided, and auth is required, an `UnauthorizedError` will be thrown.
   *
   * `UnauthorizedError` might also be thrown when sending any message over the transport, indicating that the session has expired, and needs to be re-authed and reconnected.
   */
  authProvider?: OAuthClientProvider

  /**
   * Custom implementation of the fetch API to use for HTTP requests.
   * This allows using a custom fetch implementation in environments where the global fetch is not available or needs to be customized.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Custom implementation of URL to use.
   * This allows using a custom URL implementation in environments where the global URL is not available or needs to be customized.
   */
  URL?: typeof globalThis.URL | any

  /**
   * Customizes HTTP requests to the server.
   */
  requestInit?: RequestInit

  /**
   * Session ID for the connection. This is used to identify the session on the server.
   * When not provided and connecting to a server that supports session IDs, the server will generate a new session ID.
   */
  sessionId?: string

  /**
   * EventSource initialization options.
   */
  eventSourceInit?: Record<string, any>
}

/**
 * Client transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It will connect to a server using HTTP POST for sending messages and HTTP GET with Server-Sent Events
 * for receiving messages.
 */
export class SSEJSStreamableHTTPClientTransport implements Transport {
  private _sseConnection: SSE | null = null
  private _abortController?: AbortController
  private _url: URL
  private _requestInit?: RequestInit
  private _authProvider?: OAuthClientProvider
  private _sessionId?: string
  private _lastEventId?: string
  private _onresumptiontoken?: (token: string) => void
  private _replayMessageId?: string | number
  private _fetch: typeof globalThis.fetch
  private _URL: typeof globalThis.URL | any
  private _eventSourceInit?: Record<string, any>

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  onsseclose: (() => void) | null

  constructor(url: URL, opts?: SSEJSStreamableHTTPClientTransportOptions) {
    this._url = url
    this._requestInit = opts?.requestInit
    this._authProvider = opts?.authProvider
    this._sessionId = opts?.sessionId
    this._fetch = opts?.fetch || globalThis.fetch
    this._URL = opts?.URL || globalThis.URL
    this._eventSourceInit = opts?.eventSourceInit

    this.onsseclose = null
  }

  private async _authThenStart(): Promise<void> {
    if (!this._authProvider) {
      throw new UnauthorizedError('No auth provider')
    }

    let result: AuthResult
    try {
      result = await auth(this._authProvider, { serverUrl: this._url })
    } catch (error) {
      this.onerror?.(error as Error)
      throw error
    }

    if (result !== 'AUTHORIZED') {
      throw new UnauthorizedError()
    }

    return await this._startOrAuthSse({
      resumptionToken: this._lastEventId,
      onresumptiontoken: this._onresumptiontoken,
      replayMessageId: this._replayMessageId,
    })
  }

  private async _commonHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {}
    if (this._authProvider) {
      const tokens = await this._authProvider.tokens()
      if (tokens) {
        headers['Authorization'] = `Bearer ${tokens.access_token}`
      }
    }

    if (this.sessionId) headers['mcp-session-id'] = this.sessionId

    return {
      ...headers,
      ...((this._requestInit?.headers as Record<string, string>) || {}),
    }
  }

  private async _startOrAuthSse(options: StartSSEOptions): Promise<void> {
    const { resumptionToken, onresumptiontoken, replayMessageId } = options

    // Store these for potential reconnection
    this._lastEventId = resumptionToken
    this._onresumptiontoken = onresumptiontoken
    this._replayMessageId = replayMessageId

    return new Promise<void>((resolve, reject) => {
      this._commonHeaders()
        .then((headers) => {
          // Create options for SSE connection
          const sseOptions = {
            ...this._eventSourceInit,
            headers: {
              ...headers,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              ...(this._eventSourceInit?.headers || {}),
            },
            start: false,
            method: 'GET',
          }

          // If we have a resumption token, add it as Last-Event-ID
          if (resumptionToken) {
            sseOptions.headers['Last-Event-ID'] = resumptionToken
          }

          // Create the SSE connection
          this._sseConnection = new SSE(this._url.href, sseOptions)

          // Handle errors
          this._sseConnection.onerror = (event: SseErrorEvent) => {
            // Check for auth errors (401)
            if (event.status === 401 && this._authProvider) {
              this._authThenStart().then(resolve, reject)
              return
            }

            // For 405, the server doesn't support SSE on GET - this is valid according to spec
            if (event.status === 405) {
              resolve()
              return
            }

            const error = new StreamableHTTPError(event.status, event.data)

            this.onerror?.(error)

            if (this._sseConnection) {
              this._sseConnection.close()
              this._sseConnection = null
            }

            reject(error)
          }

          // Handle SSE connection closure
          // this._sseConnection.onreadystatechange = ({
          //   readyState,
          // }: {
          //   readyState: number
          // }) => {
          //   if (readyState === 2) this.onsseclose?.()
          // }

          // Handle JSON-RPC messages
          this._sseConnection.addEventListener(
            'message',
            (event: { data: string; lastEventId?: string }) => {
              try {
                const parsed = JSON.parse(event.data)
                const message = JSONRPCMessageSchema.parse(parsed)

                // Apply replay message ID if needed
                if (
                  replayMessageId !== undefined &&
                  isJSONRPCResponse(message)
                ) {
                  message.id = replayMessageId
                }

                if (this.onmessage) this.onmessage(message)
              } catch (error) {
                if (this.onerror) this.onerror(error as Error)
              }

              // Update last event ID if present and call callback
              if (event.lastEventId) {
                this._lastEventId = event.lastEventId
                if (onresumptiontoken) onresumptiontoken(event.lastEventId)
              }
            },
          )

          // Start the connection
          this._sseConnection.stream()
          resolve()
        })
        .catch((error) => {
          reject(error)
          if (this.onerror) this.onerror(error as Error)
        })
    })
  }

  async start(): Promise<void> {
    if (this._abortController) {
      throw new Error(
        'SSEJSStreamableHTTPClientTransport already started! If using Client class, note that connect() calls start() automatically.',
      )
    }

    this._abortController = new AbortController()
  }

  /**
   * Call this method after the user has finished authorizing via their user agent and is redirected back to the MCP client application. This will exchange the authorization code for an access token, enabling the next connection attempt to successfully auth.
   */
  async finishAuth(authorizationCode: string): Promise<void> {
    if (!this._authProvider) {
      throw new UnauthorizedError('No auth provider')
    }

    const result = await auth(this._authProvider, {
      serverUrl: this._url,
      authorizationCode,
    })
    if (result !== 'AUTHORIZED') {
      throw new UnauthorizedError('Failed to authorize')
    }
  }

  async close(): Promise<void> {
    // Abort any pending requests
    this._abortController?.abort()

    // Close SSE connection if exists
    if (this._sseConnection) {
      this._sseConnection.close()
      this._sseConnection = null
    }

    this.onclose?.()
  }

  async send(
    message: JSONRPCMessage | JSONRPCMessage[],
    options?: {
      resumptionToken?: string
      onresumptiontoken?: (token: string) => void
    },
  ): Promise<void> {
    try {
      const { resumptionToken, onresumptiontoken } = options || {}

      if (resumptionToken) {
        // If we have a resumption token, we need to reconnect the SSE stream
        this._startOrAuthSse({
          resumptionToken,
          onresumptiontoken,
          replayMessageId: isJSONRPCRequest(message) ? message.id : undefined,
        }).catch((err) => this.onerror?.(err))
        return
      }

      const headers = await this._commonHeaders()
      
      // Get original message(s) for detecting request IDs
      const messages = Array.isArray(message) ? message : [message]
      const hasRequests = messages.some((msg) => isJSONRPCRequest(msg))

      if (hasRequests) {
        // Use SSE for any request expecting a streaming response
        const sseOptions = {
          useLastEventId: true,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
          },
          method: 'POST',
          payload: JSON.stringify(message),
          start: false,
        }

        // Create a new SSE connection for the request
        const sseResponse = new SSE(this._url.href, sseOptions)

        // Handle errors
        sseResponse.onerror = (event: SseErrorEvent) => {
          // Check for auth errors (401)
          if (event.status === 401 && this._authProvider) {
            this._authThenStart().then(() => {
              // Retry the send after successful auth
              this.send(message, options);
            }, (err) => this.onerror?.(err));
            return;
          }

          const error = new StreamableHTTPError(event.status, event.data);
          this.onerror?.(error);
        };

        // sseResponse.onreadystatechange = (event: any) => {
        //   if (event.readyState === 2) this.onsseclose?.()
        // }

        // Process message events
        sseResponse.addEventListener(
          'message',
          (event: { data: string; lastEventId?: string }) => {
            try {
              const parsed = JSON.parse(event.data)
              const message = JSONRPCMessageSchema.parse(parsed)
              this.onmessage?.(message)

              // Update last event ID if present and call callback
              if (event.lastEventId) {
                this._lastEventId = event.lastEventId
                if (onresumptiontoken) onresumptiontoken(event.lastEventId)
              }
            } catch (error) {
              this.onerror?.(error as Error)
            }
          }
        )

        // Extract session ID from headers, if available
        sseResponse.addEventListener('open', (event: any) => {
          // If target with headers exists (specific to SSE.js implementation)
          const { xhr } = event.source
          if (xhr?.responseHeaders) {
            const sessionId = xhr.responseHeaders['mcp-session-id']
            if (sessionId) {
              this._sessionId = sessionId
            }
            
            // If the initialized notification was accepted, start the SSE stream
            if (xhr?.responseCode === 202) {
              this._startOrAuthSse({
                resumptionToken: undefined,
                onresumptiontoken,
              }).catch((err) => this.onerror?.(err))
            }
          }
        })

        sseResponse.stream()
        return
      }
    } catch (error) {
      this.onerror?.(error as Error)
      throw error
    }
  }

  get sessionId(): string | undefined {
    return this._sessionId
  }

  /**
   * Terminates the current session by sending a DELETE request to the server.
   */
  async terminateSession(): Promise<void> {
    if (!this.sessionId) {
      return // No session to terminate
    }

    try {
      const headers = await this._commonHeaders()

      const init = {
        ...this._requestInit,
        method: 'DELETE',
        headers,
        signal: this._abortController?.signal,
      }

      const response = await this._fetch(this._url, init)

      // We specifically handle 405 as a valid response according to the spec,
      // meaning the server does not support explicit session termination
      if (!response.ok && response.status !== 405) {
        throw new StreamableHTTPError(
          response.status,
          `Failed to terminate session: ${response.statusText}`,
        )
      }

      this._sessionId = undefined
    } catch (error) {
      this.onerror?.(error as Error)
      throw error
    }
  }
}
