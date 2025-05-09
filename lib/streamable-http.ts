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
export type SSEJSStreamableHTTPClientTransportOptions = {
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
   * Customizes HTTP requests to the server.
   */
  requestInit?: RequestInit

  /**
   * Options to configure the reconnection behavior.
   */
  reconnectionOptions?: StreamableHTTPReconnectionOptions

  /**
   * Session ID for the connection. This is used to identify the session on the server.
   * When not provided and connecting to a server that supports session IDs, the server will generate a new session ID.
   */
  sessionId?: string
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
  private _reconnectionOptions: StreamableHTTPReconnectionOptions
  private _retryCount: number = 0
  private _lastEventId?: string
  private _onresumptiontoken?: (token: string) => void
  private _replayMessageId?: string | number

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(url: URL, opts?: SSEJSStreamableHTTPClientTransportOptions) {
    this._url = url
    this._requestInit = opts?.requestInit
    this._authProvider = opts?.authProvider
    this._sessionId = opts?.sessionId
    this._reconnectionOptions =
      opts?.reconnectionOptions ?? DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS
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

    if (this._sessionId) {
      headers['mcp-session-id'] = this._sessionId
    }

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
          const sseOptions: { headers: Record<string, string> } = {
            headers: {
              ...headers,
              Accept: 'text/event-stream',
            },
          }

          // If we have a resumption token, add it as Last-Event-ID
          if (resumptionToken) {
            sseOptions.headers['Last-Event-ID'] = resumptionToken
          }

          // Create the SSE connection
          this._sseConnection = new SSE(this._url.href, sseOptions)

          if (this._sseConnection) {
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

              // If the connection is not explicitly being closed, try to reconnect
              if (
                this._abortController &&
                !this._abortController.signal.aborted
              ) {
                this._scheduleReconnection()
              }

              this.onerror?.(error)

              if (this._sseConnection) {
                this._sseConnection.close()
                this._sseConnection = null
              }

              reject(error)
            }

            // Handle SSE connection closure
            this._sseConnection.onreadystatechange = ({
              readyState,
            }: {
              readyState: number
            }) => {
              // readyState 2 means connection closed
              if (readyState === 2) {
                // If the connection is not explicitly being closed, try to reconnect
                if (
                  this._abortController &&
                  !this._abortController.signal.aborted
                ) {
                  this._scheduleReconnection()
                }
              }
            }

            // Handle session ID from server
            this._sseConnection.addEventListener(
              'session-id',
              (event: { data: string }) => {
                this._sessionId = event.data
              },
            )

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
          } else {
            reject(new Error('Failed to create SSE connection'))
          }
        })
        .catch((error) => {
          reject(error)
          if (this.onerror) this.onerror(error as Error)
        })
    })
  }

  /**
   * Calculates the next reconnection delay using backoff algorithm
   */
  private _getNextReconnectionDelay(): number {
    const initialDelay = this._reconnectionOptions.initialReconnectionDelay
    const growFactor = this._reconnectionOptions.reconnectionDelayGrowFactor
    const maxDelay = this._reconnectionOptions.maxReconnectionDelay

    return Math.min(
      initialDelay * Math.pow(growFactor, this._retryCount),
      maxDelay,
    )
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private _scheduleReconnection(): void {
    const maxRetries = this._reconnectionOptions.maxRetries

    // Check if we've exceeded maximum retry attempts
    if (maxRetries > 0 && this._retryCount >= maxRetries) {
      this.onerror?.(
        new Error(`Maximum reconnection attempts (${maxRetries}) exceeded.`),
      )
      return
    }

    // Calculate next delay based on current attempt count
    const delay = this._getNextReconnectionDelay()

    // Schedule the reconnection
    setTimeout(() => {
      this._startOrAuthSse({
        resumptionToken: this._lastEventId,
        onresumptiontoken: this._onresumptiontoken,
        replayMessageId: this._replayMessageId,
      }).catch((error) => {
        this.onerror?.(
          new Error(
            `Failed to reconnect SSE stream: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
        // Increment retry count for next attempt
        this._retryCount++
        // Schedule another reconnection
        this._scheduleReconnection()
      })
    }, delay)
  }

  async start(): Promise<void> {
    if (this._abortController) {
      throw new Error(
        'SSEJSStreamableHTTPClientTransport already started! If using Client class, note that connect() calls start() automatically.',
      )
    }

    this._abortController = new AbortController()
    this._retryCount = 0

    // Initialize SSE connection
    return this._startOrAuthSse({ resumptionToken: undefined })
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
      const init = {
        ...this._requestInit,
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(message),
        signal: this._abortController?.signal,
      }

      const response = await fetch(this._url, init)

      // Handle session ID received during initialization
      const sessionId = response.headers.get('mcp-session-id')
      if (sessionId) {
        this._sessionId = sessionId
      }

      if (!response.ok) {
        if (response.status === 401 && this._authProvider) {
          const result = await auth(this._authProvider, {
            serverUrl: this._url,
          })
          if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError()
          }

          // Purposely _not_ awaited, so we don't call onerror twice
          return this.send(message)
        }

        const text = await response.text().catch(() => null)
        throw new Error(
          `Error POSTing to endpoint (HTTP ${response.status}): ${text}`,
        )
      }

      // If the response is 202 Accepted, there's no body to process
      if (response.status === 202) {
        // if the accepted notification is initialized, we start the SSE stream
        // if it's supported by the server
        if (isInitializedNotification(message)) {
          // Start without a resumption token since this is a fresh connection
          this._startOrAuthSse({
            resumptionToken: undefined,
            onresumptiontoken,
          }).catch((err) => this.onerror?.(err))
        }
        return
      }

      // Check the response type
      const contentType = response.headers.get('content-type')

      // Get original message(s) for detecting request IDs
      const messages = Array.isArray(message) ? message : [message]
      const hasRequests = messages.some((msg) => isJSONRPCRequest(msg))

      if (hasRequests) {
        if (contentType?.includes('text/event-stream')) {
          // Use SSE.js instead of manual fetch handling for SSE responses
          const sseResponse = new SSE('', {
            headers: headers,
            method: 'POST',
            payload: JSON.stringify(message),
          })

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
            },
          )

          sseResponse.stream()
        } else if (contentType?.includes('application/json')) {
          // For JSON responses, we parse and handle them directly
          const data = await response.json()
          const responseMessages = Array.isArray(data)
            ? data.map((msg) => JSONRPCMessageSchema.parse(msg))
            : [JSONRPCMessageSchema.parse(data)]

          for (const msg of responseMessages) {
            this.onmessage?.(msg)
          }
        } else {
          throw new StreamableHTTPError(
            -1,
            `Unexpected content type: ${contentType}`,
          )
        }
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
    if (!this._sessionId) {
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

      const response = await fetch(this._url, init)

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
