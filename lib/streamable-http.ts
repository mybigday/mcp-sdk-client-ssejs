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
const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS: SSEJSStreamableHTTPReconnectionOptions =
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
export interface SSEJSStreamableHTTPReconnectionOptions {
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
  data?: string
  responseCode?: number
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
   * Options to configure the reconnection behavior.
   */
  reconnectionOptions?: SSEJSStreamableHTTPReconnectionOptions

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
  private _sseResponse: SSE | null = null
  private _abortController?: AbortController
  private _url: URL
  private _requestInit?: RequestInit
  private _authProvider?: OAuthClientProvider
  private _sessionId?: string
  private _reconnectionOptions: SSEJSStreamableHTTPReconnectionOptions
  private _fetch: typeof globalThis.fetch
  private _URL: typeof globalThis.URL | any
  private _eventSourceInit?: Record<string, any>

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  onsseclose?: (noGetSupport: boolean) => void

  constructor(url: URL, opts?: SSEJSStreamableHTTPClientTransportOptions) {
    this._url = url
    this._requestInit = opts?.requestInit
    this._authProvider = opts?.authProvider
    this._sessionId = opts?.sessionId
    this._reconnectionOptions =
      opts?.reconnectionOptions ?? DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS
    this._fetch = opts?.fetch || globalThis.fetch
    this._URL = opts?.URL || globalThis.URL
    this._eventSourceInit = opts?.eventSourceInit
  }

  /**
   * Calculates the next reconnection delay using  backoff algorithm
   *
   * @param attempt Current reconnection attempt count for the specific stream
   * @returns Time to wait in milliseconds before next reconnection attempt
   */
  private _getNextReconnectionDelay(attempt: number): number {
    // Access default values directly, ensuring they're never undefined
    const initialDelay = this._reconnectionOptions.initialReconnectionDelay
    const growFactor = this._reconnectionOptions.reconnectionDelayGrowFactor
    const maxDelay = this._reconnectionOptions.maxReconnectionDelay

    // Cap at maximum delay
    return Math.min(initialDelay * Math.pow(growFactor, attempt), maxDelay)
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   *
   * @param lastEventId The ID of the last received event for resumability
   * @param attemptCount Current reconnection attempt count for this specific stream
   */
  private _scheduleReconnection(
    options: StartSSEOptions,
    attemptCount = 0,
  ): void {
    // Use provided options or default options
    const maxRetries = this._reconnectionOptions.maxRetries

    // Check if we've exceeded maximum retry attempts
    if (maxRetries > 0 && attemptCount >= maxRetries) {
      this.onerror?.(
        new Error(`Maximum reconnection attempts (${maxRetries}) exceeded.`),
      )
      return
    }

    // Calculate next delay based on current attempt count
    const delay = this._getNextReconnectionDelay(attemptCount)

    // Schedule the reconnection
    setTimeout(() => {
      // Use the last event ID to resume where we left off
      this._startOrAuthSse(options, () => {
        this._scheduleReconnection(options, attemptCount + 1)
      }).catch((error) => {
        if (this.onerror) this.onerror(error as Error)
      })
    }, delay)
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
      resumptionToken: undefined,
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

  private async _startOrAuthSse(
    options: StartSSEOptions,
    onContinueRetry?: () => void,
  ): Promise<void> {
    const { resumptionToken, onresumptiontoken, replayMessageId } = options

    const headers = await this._commonHeaders()

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

    let started = false
    let lastEventId: string | undefined

    let noGetSupport = false

    // Handle errors
    this._sseConnection.onerror = (event: SseErrorEvent) => {
      // Check for auth errors (401)
      if (event.responseCode === 401 && this._authProvider) {
        this._authThenStart()
        return
      }

      // For 405, the server doesn't support SSE on GET - this is valid according to spec
      if (event.responseCode === 405) {
        noGetSupport = true
        return
      }

      const error = new StreamableHTTPError(event.responseCode, event.data)

      this.onerror?.(error)

      if (!started) {
        onContinueRetry?.()
      } else if (
        this._abortController &&
        !this._abortController.signal.aborted
      ) {
        if (lastEventId) {
          try {
            this._scheduleReconnection(
              {
                resumptionToken: lastEventId,
                onresumptiontoken,
                replayMessageId: replayMessageId,
              },
              0,
            )
          } catch (error) {
            this.onerror?.(
              new Error(
                `Failed to reconnect: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            )
          }
        }
      }
    }

    this._sseConnection.onreadystatechange = (event) => {
      if (event.readyState === 2) this.onsseclose?.(noGetSupport)
    };

    // Handle JSON-RPC messages
    this._sseConnection.addEventListener(
      'message',
      (event: { data: string; id?: string }) => {
        started = true
        try {
          const parsed = JSON.parse(event.data)
          const message = JSONRPCMessageSchema.parse(parsed)

          // Apply replay message ID if needed
          if (replayMessageId !== undefined && isJSONRPCResponse(message)) {
            message.id = replayMessageId
          }

          if (this.onmessage) this.onmessage(message)
        } catch (error) {
          if (this.onerror) this.onerror(error as Error)
        }

        // Update last event ID if present and call callback
        if (event.id) {
          lastEventId = event.id
          if (onresumptiontoken) onresumptiontoken(event.id)
        }
      },
    )

    // Start the connection
    this._sseConnection.stream()
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

    if (this._sseResponse) {
      this._sseResponse.close()
      this._sseResponse = null
    }

    this.onclose?.()
  }

  async send(
    message: JSONRPCMessage | JSONRPCMessage[],
    options?: StartSSEOptions,
  ): Promise<void> {
    try {
      const { resumptionToken, replayMessageId, onresumptiontoken } =
        options || {}

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
      const hasRequests =
        messages.filter(
          (msg) => 'method' in msg && 'id' in msg && msg.id !== undefined,
        ).length > 0

      // Use SSE for any request expecting a streaming response
      const sseOptions = {
        useLastEventId: true,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        method: 'POST',
        payload: JSON.stringify(message),
        start: false,
      }

      // Create a new SSE connection for the request
      this._sseResponse = new SSE(this._url.href, sseOptions)

      let lastEventId: string | undefined

      if (hasRequests) {
        // Handle errors
        this._sseResponse.onerror = (event: SseErrorEvent) => {
          // Check for auth errors (401)
          if (event.responseCode === 401 && this._authProvider) {
            this._authThenStart().then(
              () => {
                // Retry the send after successful auth
                this.send(message, options)
              },
              (err) => this.onerror?.(err),
            )
            return
          }

          const error = new StreamableHTTPError(event.responseCode, event.data)
          this.onerror?.(error)

          if (this._abortController && !this._abortController.signal.aborted) {
            if (lastEventId) {
              try {
                this._scheduleReconnection(
                  {
                    resumptionToken: lastEventId,
                    onresumptiontoken,
                    replayMessageId: replayMessageId,
                  },
                  0,
                )
              } catch (error) {
                this.onerror?.(
                  new Error(
                    `Failed to reconnect: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  ),
                )
              }
            }
          }
        }

        // Process message events
        this._sseResponse.addEventListener(
          'message',
          (event: { data: string; id?: string }) => {
            try {
              const parsed = JSON.parse(event.data)
              const message = JSONRPCMessageSchema.parse(parsed)
              this.onmessage?.(message)
            } catch (error) {
              this.onerror?.(error as Error)
            }

            // Update last event ID if present and call callback
            if (event.id) {
              lastEventId = event.id
              if (onresumptiontoken) onresumptiontoken(event.id)
            }
          },
        )
      }

      // Extract session ID from headers, if available
      this._sseResponse.addEventListener('open', (event: any) => {
        // If target with headers exists (specific to SSE.js implementation)
        const { xhr } = event.source
        if (xhr?.responseHeaders) {
          const sessionId = xhr.responseHeaders['mcp-session-id']
          if (sessionId) {
            this._sessionId = sessionId
          }
        }
        // If the initialized notification was accepted, start the SSE stream
        if (xhr?.status === 202) {
          if (isInitializedNotification(message)) {
            this._startOrAuthSse({
              resumptionToken: undefined,
              onresumptiontoken,
            }).catch((err) => this.onerror?.(err))
          }
        }
      })

      this._sseResponse.stream()
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
    if (!this.sessionId) return // No session to terminate

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
