/* eslint-disable no-underscore-dangle */
import { SSE } from 'sse.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  auth,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js'

export interface SseErrorEvent {
  status?: number
  data?: string
}

export class SseError extends Error {
  code?: number
  event?: SseErrorEvent

  constructor(message: string, event?: SseErrorEvent) {
    super(`SSE error: ${message}`)
    this.code = event?.status
    this.event = event
  }
}

interface EventSourceInitWithHeaders {
  headers?: Record<string, string>
  [key: string]: any
}

interface TransportOptions {
  URL?: typeof globalThis.URL
  fetch?: typeof globalThis.fetch
  eventSourceInit?: EventSourceInitWithHeaders
  requestInit?: RequestInit
  authProvider?: OAuthClientProvider
}

type AuthResult = 'AUTHORIZED' | string

/**
 * Client transport for SSE: this will connect to a server using Server-Sent Events for receiving
 * messages and make separate POST requests for sending messages.
 *
 * Based on sse.js for React Native support.
 */
export class SSEJSClientTransport {
  private _url: URL
  private _sseConnection: SSE | null
  private _endpoint: URL | globalThis.URL | null
  private _abortController: AbortController | null
  private _eventSourceInit?: EventSourceInitWithHeaders
  private _requestInit?: RequestInit
  private _authProvider?: OAuthClientProvider
  private _fetch: typeof globalThis.fetch
  private _URL: typeof globalThis.URL | any // can be whatwg-url-without-unicode

  public onclose: (() => void) | null
  public onerror: ((error: Error) => void) | null
  public onmessage: ((message: any) => void) | null
  public onsseclose: (() => void) | null

  constructor(url: URL, opts: TransportOptions = {}) {
    this._url = url
    this._sseConnection = null
    this._endpoint = null
    this._abortController = null
    this._eventSourceInit = opts.eventSourceInit
    this._requestInit = opts.requestInit
    this._authProvider = opts.authProvider
    this._fetch = opts.fetch || globalThis.fetch
    this._URL = opts.URL || globalThis.URL

    this.onclose = null
    this.onerror = null
    this.onmessage = null

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
      if (this.onerror) this.onerror(error as Error)
      throw error
    }

    if (result !== 'AUTHORIZED') {
      throw new UnauthorizedError()
    }

    return await this._startOrAuth()
  }

  private async _commonHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {}
    if (this._authProvider) {
      const tokens = await this._authProvider.tokens()
      if (tokens) {
        headers['Authorization'] = `Bearer ${tokens.access_token}`
      }
    }
    return headers
  }

  private _startOrAuth(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Set up the abort controller
      this._abortController = new AbortController()

      // Prepare headers for the SSE connection
      this._commonHeaders()
        .then((headers) => {
          // Create options for SSE connection
          const sseOptions = {
            ...this._eventSourceInit,
            headers: {
              ...headers,
              Accept: 'text/event-stream',
              ...(this._eventSourceInit?.headers || {}),
            },
            // sse.js doesn't support signal directly, but we'll keep the abort controller for POST requests
          }

          // Create the SSE connection
          this._sseConnection = new SSE(this._url.href, sseOptions)

          // Handle errors
          if (this._sseConnection) {
            this._sseConnection.onerror = (event: SseErrorEvent) => {
              // Check for auth errors (401)
              if (event.status === 401 && this._authProvider) {
                this._authThenStart().then(resolve, reject)
                return
              }

              const error = new SseError(event.data as string, event)
              reject(error)
              if (this.onerror) this.onerror(error)
              if (this._sseConnection) {
                this._sseConnection.close()
              }
            }

            this._sseConnection.onreadystatechange = ({
              readyState,
            }: {
              readyState: number
            }) => {
              if (readyState === 2) this.onsseclose?.()
            }

            // Listen for the endpoint event
            this._sseConnection.addEventListener(
              'endpoint',
              (event: { data: string }) => {
                try {
                  this._endpoint = new this._URL(event.data, this._url)
                  if (this._endpoint?.origin !== this._url.origin) {
                    throw new Error(
                      `Endpoint origin does not match connection origin: ${this._endpoint?.origin}`,
                    )
                  }
                } catch (error) {
                  reject(error)
                  if (this.onerror) this.onerror(error as Error)

                  this.close()
                  return
                }

                resolve()
              },
            )

            // Handle messages
            this._sseConnection.addEventListener(
              'message',
              (event: { data: string }) => {
                let message
                try {
                  const parsed = JSON.parse(event.data)
                  message = JSONRPCMessageSchema.parse(parsed)
                } catch (error) {
                  if (this.onerror) this.onerror(error as Error)
                  return
                }

                if (this.onmessage) this.onmessage(message)
              },
            )

            // Start the connection
            this._sseConnection.stream()
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

  async start(): Promise<void> {
    if (this._sseConnection) {
      throw new Error(
        'SSEClientTransport already started! If using Client class, note that connect() calls start() automatically.',
      )
    }

    return await this._startOrAuth()
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
    this._abortController?.abort()
    if (this._sseConnection) {
      this._sseConnection.close()
      this._sseConnection = null
    }
    if (this.onclose) this.onclose()
  }

  async send(message: any): Promise<void> {
    if (!this._endpoint) {
      throw new Error('Not connected')
    }

    try {
      const commonHeaders = await this._commonHeaders()
      const headers = new Headers({
        ...commonHeaders,
        ...(this._requestInit?.headers || {}),
      })
      headers.set('content-type', 'application/json')

      const init = {
        ...this._requestInit,
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: this._abortController?.signal,
      }

      const response = await this._fetch(this._endpoint, init)
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
    } catch (error) {
      if (this.onerror) this.onerror(error as Error)
      throw error
    }
  }
}
